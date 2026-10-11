import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_budgets as budgets,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as r53targets,
  aws_s3 as s3,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  DEFAULT_POW_DIFFICULTY,
  MANAGE_TOKEN_HEADER,
  PERMISSIONS_POLICY,
  HSTS_MAX_AGE_SEC,
  contentSecurityPolicy,
  filesBucketName as sharedFilesBucketName,
  filesBucketOrigin,
} from '@brix-share/shared';
import type { StageConfig, ZoneRef } from './stages.ts';

export interface BrixShareStackProps extends StackProps {
  stage: StageConfig;
  /** Custom domain (certificate in us-east-1, zone for the alias records); absent: CloudFront default domain. */
  domain?: { zoneRef: ZoneRef; certificate: acm.ICertificate };
  webAclArn: string;
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const entry = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

/** SPA routing: extensionless paths serve index.html. Only on the static behavior, never on /api. */
const SPA_REWRITE = `function handler(event) {
  var r = event.request;
  var last = r.uri.substring(r.uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') === -1) { r.uri = '/index.html'; }
  return r;
}`;

export class BrixShareStack extends Stack {
  constructor(scope: Construct, id: string, props: BrixShareStackProps) {
    super(scope, id, props);
    const { stage } = props;
    this.templateOptions.description = `Brix Share (${stage.name})`;
    // Explicit name: the CSP, IAM and the API refer to it as a literal, so the bucket's CORS rule can name
    // the CloudFront domain without a dependency cycle (distribution -> api -> role policy -> bucket).
    const filesBucketName = sharedFilesBucketName(stage.name, stage.filesBucketSuffix);
    const filesBucketArn = `arn:aws:s3:::${filesBucketName}`;
    const paramPrefix = `/brix-share/${stage.name}`;
    const metricNamespace = `BrixShare/${stage.name}`;

    // ---------- Data ----------

    const table = new dynamodb.TableV2(this, 'Secrets', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // purgeAt, not the policy expiry: TTL must never remove a live item before the sweeper tombstones it.
      timeToLiveAttribute: 'purgeAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      deletionProtection: true,
      // Ephemeral data must not outlive the stack; deletion protection is the guard against accidents.
      removalPolicy: RemovalPolicy.DESTROY,
      globalSecondaryIndexes: [
        {
          indexName: 'sweep-due',
          partitionKey: { name: 'sweepPart', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'sweepAt', type: dynamodb.AttributeType.NUMBER },
          projectionType: dynamodb.ProjectionType.INCLUDE,
          nonKeyAttributes: ['status', 'fileIds', 'createdAt', 'endedAt', 'expiresAt'],
        },
      ],
    });

    const filesBucket = new s3.Bucket(this, 'Files', {
      bucketName: filesBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        { id: 'backstop', expiration: Duration.days(31) },
        { id: 'abort-multipart', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const filesOrigin = filesBucketOrigin(filesBucketName, this.region);
    const adminRoleArnPattern = `arn:aws:iam::${stage.account}:role/${stage.adminRolePattern}`;

    const createEnabled = new ssm.StringParameter(this, 'CreateEnabled', {
      parameterName: `${paramPrefix}/createEnabled`,
      stringValue: 'true',
      description: 'Circuit breaker for secret creation. Set to false to stop creates.',
    });
    const powDifficulty = new ssm.StringParameter(this, 'PowDifficulty', {
      parameterName: `${paramPrefix}/powDifficulty`,
      stringValue: String(DEFAULT_POW_DIFFICULTY),
      description:
        'Proof-of-work difficulty in leading zero bits. Raised by the governor under load.',
    });
    const governorState = new ssm.StringParameter(this, 'GovernorState', {
      parameterName: `${paramPrefix}/governor`,
      stringValue: '{}',
      description: 'Governor bookkeeping (alarm state and timestamps).',
    });
    // Self-provisioned SecureString, created by the api Lambda on first use. Not a CloudFormation resource.
    const hmacKeyParamArn = this.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: `${paramPrefix.slice(1)}/powHmacKey`,
    });

    // ---------- Functions ----------

    const fn = (name: string, file: string, opts: Partial<nodejs.NodejsFunctionProps>) => {
      const logGroup = new logs.LogGroup(this, `${name}Logs`, {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const f = new nodejs.NodejsFunction(this, name, {
        entry: entry(file),
        projectRoot: repoRoot,
        depsLockFilePath: entry('pnpm-lock.yaml'),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        logGroup,
        loggingFormat: lambda.LoggingFormat.TEXT,
        tracing: lambda.Tracing.DISABLED,
        bundling: {
          minify: true,
          sourceMap: false,
          target: 'node22',
          format: nodejs.OutputFormat.ESM,
          mainFields: ['module', 'main'],
          // Bundle the pinned SDK instead of using the runtime's copy.
          externalModules: [],
          banner:
            "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
        ...opts,
      });
      return { fn: f, logGroup };
    };

    const api = fn('Api', 'api/src/handler.ts', {
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: 20,
      environment: {
        STAGE: stage.name,
        TABLE_NAME: table.tableName,
        FILES_BUCKET: filesBucketName,
        PARAM_PREFIX: paramPrefix,
      },
    });
    api.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [table.tableArn],
      }),
    );
    api.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
        resources: [`${filesBucketArn}/*`],
      }),
    );
    api.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [createEnabled.parameterArn, powDifficulty.parameterArn, hmacKeyParamArn],
      }),
    );
    // Create-only: the key can be provisioned once but never rotated by the function (cheap DoS otherwise).
    api.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        resources: [hmacKeyParamArn],
        conditions: { StringEquals: { 'ssm:Overwrite': 'false' } },
      }),
    );

    // Ciphertext objects are only ever read through presigned URLs signed by the api role.
    filesBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'OnlyApiReadsFiles',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [`${filesBucketArn}/*`],
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': api.fn.role!.roleArn } },
      }),
    );

    const sweeper = fn('Sweeper', 'sweeper/src/handler.ts', {
      timeout: Duration.minutes(2), // well under the 5-minute schedule, so runs never overlap
      reservedConcurrentExecutions: 1,
      environment: {
        STAGE: stage.name,
        TABLE_NAME: table.tableName,
        FILES_BUCKET: filesBucketName,
      },
    });
    sweeper.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${table.tableArn}/index/sweep-due`],
      }),
    );
    sweeper.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
          'dynamodb:DescribeTable',
        ],
        resources: [table.tableArn],
      }),
    );
    sweeper.fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [filesBucketArn] }),
    );
    sweeper.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject'],
        resources: [`${filesBucketArn}/*`],
      }),
    );
    // Every 5 minutes: expired envelopes and the files of ended secrets go within minutes, not hours.
    new events.Rule(this, 'SweeperSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(sweeper.fn, { retryAttempts: 0 })],
    });

    const governor = fn('Governor', 'sweeper/src/governor.ts', {
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 1,
      environment: { STAGE: stage.name, PARAM_PREFIX: paramPrefix },
    });
    governor.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameters', 'ssm:PutParameter'],
        resources: [
          createEnabled.parameterArn,
          powDifficulty.parameterArn,
          governorState.parameterArn,
        ],
      }),
    );

    // ---------- Edge ----------

    const staticBucket = new s3.Bucket(this, 'Static', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ id: 'noncurrent', noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const logBucket = new s3.Bucket(this, 'AccessLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // CloudFront standard (legacy) logging writes with ACLs.
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      lifecycleRules: [{ id: 'retention', expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Access logs contain viewer IPs: readable by the admin (security) role only (PLAN section 12).
    logBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'OnlyAdminReadsAccessLogs',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectAcl'],
        resources: [logBucket.arnForObjects('*')],
        conditions: { ArnNotLike: { 'aws:PrincipalArn': adminRoleArnPattern } },
      }),
    );

    const headersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      comment: 'Brix Share security headers',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: contentSecurityPolicy(filesOrigin),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(HSTS_MAX_AGE_SEC),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: PERMISSIONS_POLICY, override: true },
          { header: 'Cross-Origin-Opener-Policy', value: 'same-origin', override: true },
          { header: 'Cross-Origin-Resource-Policy', value: 'same-origin', override: true },
          { header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true },
        ],
      },
      removeHeaders: ['Server'],
    });

    const apiUrl = api.fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    const apiOriginRequest = new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequest', {
      // x-amz-content-sha256 is not listed: CloudFront rejects it here and OAC passes it to SigV4 signing itself.
      comment: 'Brix Share API: only the headers the API reads',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        MANAGE_TOKEN_HEADER,
        'content-type',
        'CloudFront-Viewer-Country',
      ),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Brix Share ${stage.name}`,
      ...(props.domain
        ? {
            domainNames: [stage.domainName],
            certificate: props.domain.certificate,
            sslSupportMethod: cloudfront.SSLMethod.SNI,
          }
        : {}),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      webAclId: props.webAclArn,
      defaultRootObject: 'index.html',
      enableLogging: true,
      logBucket,
      logFilePrefix: 'cloudfront/',
      logIncludesCookies: false,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headersPolicy,
        compress: true,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, 'SpaRewrite', {
              code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
              runtime: cloudfront.FunctionRuntime.JS_2_0,
            }),
          },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(apiUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: apiOriginRequest,
          responseHeadersPolicy: headersPolicy,
          compress: true,
        },
      },
    });

    // FunctionUrlOrigin grants lambda:InvokeFunctionUrl; Function URLs created since late 2025 also
    // require lambda:InvokeFunction, scoped to invocations through the URL.
    new lambda.CfnPermission(this, 'ApiInvokeViaUrlFromCloudFront', {
      action: 'lambda:InvokeFunction',
      functionName: api.fn.functionArn,
      principal: 'cloudfront.amazonaws.com',
      sourceArn: this.formatArn({
        service: 'cloudfront',
        region: '',
        resource: 'distribution',
        resourceName: distribution.distributionId,
      }),
      invokedViaFunctionUrl: true,
    });

    // The web deploy role is the only principal that may write the static bucket. Deploys are manual:
    // only the account's admin SSO role may assume it (not every principal with sts:AssumeRole on *).
    const webDeployRole = new iam.Role(this, 'WebDeployRole', {
      roleName: `BrixShare-${stage.name}-web-deploy`,
      assumedBy: new iam.AccountPrincipal(this.account).withConditions({
        ArnLike: { 'aws:PrincipalArn': adminRoleArnPattern },
      }),
      maxSessionDuration: Duration.hours(1),
      description:
        'Uploads the Brix Share web build and invalidates CloudFront. Assumed manually by an admin.',
    });
    webDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:DeleteObject'],
        resources: [staticBucket.arnForObjects('*')],
      }),
    );
    webDeployRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [staticBucket.bucketArn] }),
    );
    webDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [distribution.distributionArn],
      }),
    );
    staticBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'OnlyWebDeployRoleWrites',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [staticBucket.arnForObjects('*')],
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': webDeployRole.roleArn } },
      }),
    );
    staticBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'KeepServedVersions',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:DeleteObjectVersion'],
        resources: [staticBucket.arnForObjects('*')],
      }),
    );

    // Uploads and downloads go from the site straight to the files bucket.
    filesBucket.addCorsRule({
      allowedOrigins: [
        `https://${distribution.distributionDomainName}`,
        ...(props.domain ? [`https://${stage.domainName}`] : []),
      ],
      allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
      allowedHeaders: ['content-type'],
      maxAge: 300,
    });

    if (props.domain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.domain.zoneRef.zoneId,
        zoneName: props.domain.zoneRef.zoneName,
      });
      const aliasTarget = route53.RecordTarget.fromAlias(
        new r53targets.CloudFrontTarget(distribution),
      );
      new route53.ARecord(this, 'AliasA', {
        zone,
        recordName: stage.domainName,
        target: aliasTarget,
      });
      new route53.AaaaRecord(this, 'AliasAAAA', {
        zone,
        recordName: stage.domainName,
        target: aliasTarget,
      });
    }

    // ---------- Metrics and alarms ----------

    const topic = new sns.Topic(this, 'Alarms', {
      displayName: `Brix Share ${stage.name} alarms`,
      enforceSSL: true,
    });
    if (stage.alarmEmail) topic.addSubscription(new subs.EmailSubscription(stage.alarmEmail));
    const alarmActions = [
      new cwActions.SnsAction(topic),
      ...(stage.alarmTopicArns ?? []).map(
        (arn, i) =>
          new cwActions.SnsAction(sns.Topic.fromTopicArn(this, `ExternalAlarmTopic${i}`, arn)),
      ),
    ];

    const filterMetric = (
      name: string,
      logGroup: logs.ILogGroup,
      pattern: logs.IFilterPattern,
      metricValue = '1',
    ): cloudwatch.Metric => {
      new logs.MetricFilter(this, `${name}Filter`, {
        logGroup,
        filterPattern: pattern,
        metricNamespace,
        metricName: name,
        metricValue,
      });
      return new cloudwatch.Metric({ namespace: metricNamespace, metricName: name });
    };
    const creates = filterMetric(
      'Creates',
      api.logGroup,
      logs.FilterPattern.stringValue('$.event', '=', 'create'),
    );
    const consumes = filterMetric(
      'Consumes',
      api.logGroup,
      logs.FilterPattern.stringValue('$.event', '=', 'consume'),
    );
    const api5xx = filterMetric(
      'Api5xx',
      api.logGroup,
      logs.FilterPattern.numberValue('$.status', '>=', 500),
    );
    const itemCount = filterMetric(
      'TableItemCount',
      sweeper.logGroup,
      logs.FilterPattern.stringValue('$.event', '=', 'tableItemCount'),
      '$.value',
    );

    const alarm = (id: string, props: cloudwatch.AlarmProps) => {
      // Readable names and a product prefix: the shared team Slack channel shows both as they are.
      const a = new cloudwatch.Alarm(this, id, {
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...props,
        alarmName: `BrixShare-${stage.name}-${id}`,
        alarmDescription: `Brix Share (${stage.name}): ${props.alarmDescription ?? id}`,
      });
      a.addAlarmAction(...alarmActions);
      a.addOkAction(...alarmActions);
      return a;
    };

    // Roughly 500 creates per hour, evaluated in 5-minute buckets so the governor reacts quickly.
    const createRate = alarm('CreateRateHigh', {
      alarmDescription: 'Creates above ~500/hour. Drives the proof-of-work governor.',
      metric: creates.with({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 42,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
    });
    // Slow, steady abuse stays under the 5-minute governor trigger; a daily total catches it.
    alarm('CreatesDailyHigh', {
      alarmDescription: 'More than 2000 creates in 24 hours.',
      metric: creates.with({ statistic: 'Sum', period: Duration.days(1) }),
      threshold: 2000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    });
    alarm('ConsumeRateHigh', {
      alarmDescription: 'Consumes above 3000/hour.',
      metric: consumes.with({ statistic: 'Sum', period: Duration.hours(1) }),
      threshold: 3000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    });
    alarm('Api5xx', {
      alarmDescription: 'API answered 5xx at least 5 times in 5 minutes.',
      metric: api5xx.with({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
    });
    for (const [name, f] of [
      ['Api', api.fn],
      ['Sweeper', sweeper.fn],
      ['Governor', governor.fn],
    ] as const) {
      alarm(`${name}Errors`, {
        alarmDescription: `${name} Lambda invocation errors.`,
        metric: f.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
      });
      // The governor runs with concurrency 1 and two triggers; a throttled overlap is retried, not an incident.
      if (name === 'Governor') continue;
      alarm(`${name}Throttles`, {
        alarmDescription: `${name} Lambda throttled (reserved concurrency exhausted).`,
        metric: f.metricThrottles({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
      });
    }
    alarm('TableItemCountHigh', {
      alarmDescription:
        'More than 100k items in the secrets table (reported hourly by the sweeper).',
      metric: itemCount.with({ statistic: 'Maximum', period: Duration.hours(1) }),
      threshold: 100_000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    });
    alarm('FilesBucketSizeHigh', {
      alarmDescription: 'Files bucket above 10 GB.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/S3',
        metricName: 'BucketSizeBytes',
        dimensionsMap: { BucketName: filesBucketName, StorageType: 'StandardStorage' },
        statistic: 'Maximum',
        period: Duration.days(1),
      }),
      threshold: 10 * 1024 ** 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    });

    new events.Rule(this, 'GovernorOnAlarm', {
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        resources: [createRate.alarmArn],
      },
      targets: [new targets.LambdaFunction(governor.fn, { retryAttempts: 2 })],
    });
    new events.Rule(this, 'GovernorSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(governor.fn, { retryAttempts: 0 })],
    });

    if (stage.budgetUsd) {
      topic.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['sns:Publish'],
          principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
          resources: [topic.topicArn],
          conditions: { StringEquals: { 'aws:SourceAccount': stage.account } },
        }),
      );
      new budgets.CfnBudget(this, 'Budget', {
        budget: {
          budgetName: `BrixShare-${stage.name}`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: stage.budgetUsd, unit: 'USD' },
          costFilters: { TagKeyValue: ['user:app$brix-share'] },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: 'FORECASTED',
              comparisonOperator: 'GREATER_THAN',
              threshold: 100,
              thresholdType: 'PERCENTAGE',
            },
            subscribers: [{ subscriptionType: 'SNS', address: topic.topicArn }],
          },
        ],
      });
    }

    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'SiteUrl', {
      value: props.domain
        ? `https://${stage.domainName}`
        : `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'StaticBucketName', { value: staticBucket.bucketName });
    new CfnOutput(this, 'FilesBucketName', { value: filesBucketName });
    new CfnOutput(this, 'WebDeployRoleArn', { value: webDeployRole.roleArn });
    new CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
