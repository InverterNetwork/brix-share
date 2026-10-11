import { Match } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../lib/waf.ts';
import { resourcesOf, synthAll } from './helpers.ts';

const built = synthAll();

describe.each(built.map((b) => [b.label, b] as const))('stage %s', (_name, b) => {
  const { mainT, edgeT, stage } = b;
  let json: string;
  beforeAll(() => {
    json = JSON.stringify(mainT.toJSON());
  });

  it('table: on-demand, TTL, no PITR, no stream, deletion protection, sparse files GSI', () => {
    mainT.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'purgeAt', Enabled: true },
      StreamSpecification: Match.absent(),
      Replicas: [
        Match.objectLike({
          DeletionProtectionEnabled: true,
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
        }),
      ],
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'sweep-due',
          KeySchema: [
            { AttributeName: 'sweepPart', KeyType: 'HASH' },
            { AttributeName: 'sweepAt', KeyType: 'RANGE' },
          ],
        }),
      ],
    });
    expect(resourcesOf(mainT, 'AWS::DynamoDB::GlobalTable')).toHaveLength(1);
  });

  it('files bucket: private, unversioned, 31-day backstop, CORS limited to the site', () => {
    mainT.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `brix-share-${stage.name}-files-${stage.filesBucketSuffix}`,
      CorsConfiguration: {
        CorsRules: [
          {
            AllowedOrigins: stage.customDomain
              ? [Match.objectLike({ 'Fn::Join': Match.anyValue() }), `https://${stage.domainName}`]
              : [
                  Match.objectLike({
                    'Fn::Join': [
                      '',
                      [
                        'https://',
                        { 'Fn::GetAtt': [Match.stringLikeRegexp('^Distribution'), 'DomainName'] },
                      ],
                    ],
                  }),
                ],
            AllowedMethods: ['PUT', 'GET'],
            AllowedHeaders: ['content-type'],
            MaxAge: 300,
          },
        ],
      },
      VersioningConfiguration: Match.absent(),
      LoggingConfiguration: Match.absent(),
      ReplicationConfiguration: Match.absent(),
      ObjectLockEnabled: Match.absent(),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 31, Status: 'Enabled' })]),
      },
    });
  });

  it('access log bucket expires logs after 30 days', () => {
    mainT.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 30 })] },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'ObjectWriter' }] },
    });
  });

  it('static bucket only accepts writes from the web deploy role and keeps versions', () => {
    const policies = resourcesOf(mainT, 'AWS::S3::BucketPolicy');
    const statements = policies.flatMap(
      (p) => (p.Properties!.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
    );
    const onlyRole = statements.find((s) => s.Sid === 'OnlyWebDeployRoleWrites');
    expect(onlyRole).toMatchObject({
      Effect: 'Deny',
      Principal: { AWS: '*' },
      Action: 's3:PutObject',
      Condition: {
        ArnNotEquals: {
          'aws:PrincipalArn': { 'Fn::GetAtt': [expect.stringMatching(/^WebDeployRole/), 'Arn'] },
        },
      },
    });
    expect(statements.find((s) => s.Sid === 'KeepServedVersions')).toMatchObject({
      Effect: 'Deny',
      Action: 's3:DeleteObjectVersion',
    });
    const role = resourcesOf(mainT, 'AWS::IAM::Role').find(
      (r) => r.Properties!.RoleName === `BrixShare-${stage.name}-web-deploy`,
    )!;
    expect(role.Properties!.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: { AWS: `arn:aws:iam::${stage.account}:root` },
          Condition: {
            ArnLike: {
              'aws:PrincipalArn': `arn:aws:iam::${stage.account}:role/aws-reserved/sso.amazonaws.com/*/AWSReservedSSO_AdministratorAccess_*`,
            },
          },
        },
      ],
    });
  });

  it('access logs readable only by the admin role, file objects only by the api role', () => {
    const statements = resourcesOf(mainT, 'AWS::S3::BucketPolicy').flatMap(
      (p) => (p.Properties!.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
    );
    expect(statements.find((s) => s.Sid === 'OnlyAdminReadsAccessLogs')).toMatchObject({
      Effect: 'Deny',
      Principal: { AWS: '*' },
      Action: expect.arrayContaining(['s3:GetObject']),
      Condition: {
        ArnNotLike: {
          'aws:PrincipalArn': expect.stringContaining('AWSReservedSSO_AdministratorAccess_*'),
        },
      },
    });
    expect(statements.find((s) => s.Sid === 'OnlyApiReadsFiles')).toMatchObject({
      Effect: 'Deny',
      Principal: { AWS: '*' },
      Condition: {
        ArnNotEquals: {
          'aws:PrincipalArn': { 'Fn::GetAtt': [expect.stringMatching(/^ApiServiceRole/), 'Arn'] },
        },
      },
    });
  });

  it('no throttle alarm on the single-concurrency governor', () => {
    const names = resourcesOf(mainT, 'AWS::CloudWatch::Alarm').map((a) =>
      JSON.stringify(a.Properties!.AlarmDescription),
    );
    expect(names.some((n) => n.includes('Governor Lambda throttled'))).toBe(false);
    expect(names.some((n) => n.includes('Api Lambda throttled'))).toBe(true);
  });

  it('lambdas: node 22, arm64, 256 MB, reserved concurrency, no tracing, 14-day log groups', () => {
    const fns = resourcesOf(mainT, 'AWS::Lambda::Function').filter(
      (f) => (f.Properties!.Runtime as string) === 'nodejs22.x' && f.Properties!.MemorySize === 256,
    );
    expect(fns).toHaveLength(3);
    for (const f of fns) {
      expect(f.Properties!.Architectures).toEqual(['arm64']);
      expect(f.Properties!.TracingConfig).toBeUndefined();
    }
    expect(fns.map((f) => f.Properties!.ReservedConcurrentExecutions).sort()).toEqual([1, 1, 20]);
    const groups = resourcesOf(mainT, 'AWS::Logs::LogGroup');
    expect(groups).toHaveLength(3);
    for (const g of groups) expect(g.Properties!.RetentionInDays).toBe(14);
    expect(resourcesOf(mainT, 'Custom::LogRetention')).toHaveLength(0);
  });

  it('api is reachable only through CloudFront: IAM-auth function URL with OAC and scoped invoke permissions', () => {
    mainT.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
    mainT.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 'lambda',
        SigningBehavior: 'always',
      }),
    });
    mainT.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: 'cloudfront.amazonaws.com',
    });
    mainT.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'cloudfront.amazonaws.com',
      InvokedViaFunctionUrl: true,
    });
    for (const p of resourcesOf(mainT, 'AWS::Lambda::Permission')) {
      expect(p.Properties!.Principal).not.toBe('*');
    }
  });

  it('cloudfront: behaviors, TLS, WAF, logging, no distribution-wide error pages', () => {
    mainT.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: stage.customDomain ? [stage.domainName] : Match.absent(),
        DefaultRootObject: 'index.html',
        HttpVersion: 'http2and3',
        PriceClass: 'PriceClass_100',
        CustomErrorResponses: Match.absent(),
        Logging: Match.objectLike({ IncludeCookies: false, Prefix: 'cloudfront/' }),
        WebACLId: Match.anyValue(),
        ViewerCertificate: stage.customDomain
          ? Match.objectLike({
              MinimumProtocolVersion: 'TLSv1.2_2021',
              SslSupportMethod: 'sni-only',
            })
          : Match.absent(), // CloudFront default certificate until the custom domain is on
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: ['GET', 'HEAD'],
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        }),
        CacheBehaviors: [
          Match.objectLike({
            PathPattern: '/api/*',
            ViewerProtocolPolicy: 'https-only',
            CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            FunctionAssociations: Match.absent(),
          }),
        ],
      }),
    });
  });

  it('api origin request policy forwards only what the API reads', () => {
    mainT.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: Match.objectLike({
        HeadersConfig: {
          HeaderBehavior: 'whitelist',
          Headers: ['x-manage-token', 'content-type', 'CloudFront-Viewer-Country'],
        },
        QueryStringsConfig: { QueryStringBehavior: 'none' },
        CookiesConfig: { CookieBehavior: 'none' },
      }),
    });
  });

  it('response headers: CSP with only self and the files bucket, HSTS preload, COOP, CORP, robots', () => {
    const policy = resourcesOf(mainT, 'AWS::CloudFront::ResponseHeadersPolicy')[0]!;
    const cfg = JSON.stringify(policy.Properties);
    expect(cfg).toContain("default-src 'none'; script-src 'self'; style-src 'self'");
    expect(cfg).toContain(
      "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(cfg).toContain("connect-src 'self' https://");
    expect(cfg).toContain('.s3.eu-central-1.amazonaws.com');
    expect(cfg).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    mainT.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          StrictTransportSecurity: {
            AccessControlMaxAgeSec: 63072000,
            IncludeSubdomains: true,
            Preload: true,
            Override: true,
          },
          ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true },
          FrameOptions: { FrameOption: 'DENY', Override: true },
          ContentTypeOptions: { Override: true },
        }),
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            Match.objectLike({
              Header: 'Permissions-Policy',
              Value: Match.stringLikeRegexp('camera=\\(\\)'),
            }),
            Match.objectLike({ Header: 'Cross-Origin-Opener-Policy', Value: 'same-origin' }),
            Match.objectLike({ Header: 'Cross-Origin-Resource-Policy', Value: 'same-origin' }),
            Match.objectLike({ Header: 'X-Robots-Tag', Value: 'noindex, nofollow' }),
          ]),
        },
        RemoveHeadersConfig: { Items: [{ Header: 'Server' }] },
      }),
    });
  });

  it('IAM: no scans, no wildcard actions, no s3 GetObject outside the api', () => {
    expect(json).not.toContain('dynamodb:Scan');
    const policies = resourcesOf(mainT, 'AWS::IAM::Policy');
    expect(JSON.stringify(policies)).not.toMatch(/"dynamodb:\*"|"s3:\*"|"ssm:\*"|"Action":"\*"/);
    const withGet = policies.filter((p) => JSON.stringify(p.Properties).includes('s3:GetObject'));
    expect(withGet).toHaveLength(1);
    expect(JSON.stringify(withGet[0]!.Properties!.Roles)).toContain('ApiServiceRole');
  });

  it('metrics come from log metric filters and feed the alarms', () => {
    for (const name of ['Creates', 'Consumes', 'Api5xx', 'TableItemCount']) {
      mainT.hasResourceProperties('AWS::Logs::MetricFilter', {
        MetricTransformations: [
          Match.objectLike({ MetricNamespace: `BrixShare/${stage.name}`, MetricName: name }),
        ],
      });
    }
    mainT.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ $.event = "create" }',
    });
    mainT.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ $.status >= 500 }',
    });
    mainT.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Creates',
      Namespace: `BrixShare/${stage.name}`,
      Threshold: 42,
    });
    // Every alarm notifies the stage topic and each configured external topic, on ALARM and on OK.
    const alarms = resourcesOf(mainT, 'AWS::CloudWatch::Alarm');
    expect(alarms.length).toBeGreaterThan(0);
    for (const a of alarms) {
      expect(a.Properties!.AlarmName).toMatch(new RegExp(`^BrixShare-${stage.name}-[A-Za-z0-9]+$`));
      expect(a.Properties!.AlarmDescription).toMatch(/^Brix Share \(/);
      const n = 1 + (stage.alarmTopicArns?.length ?? 0);
      expect(a.Properties!.AlarmActions as unknown[]).toHaveLength(n);
      expect(a.Properties!.OKActions as unknown[]).toHaveLength(n);
      for (const arn of stage.alarmTopicArns ?? []) {
        expect(a.Properties!.AlarmActions).toContain(arn);
        expect(a.Properties!.OKActions).toContain(arn);
      }
    }
    mainT.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ 'detail-type': ['CloudWatch Alarm State Change'] }),
    });
  });

  it('SSM: circuit breaker and difficulty defaults, no secret parameter in the template', () => {
    mainT.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/brix-share/${stage.name}/createEnabled`,
      Value: 'true',
    });
    mainT.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/brix-share/${stage.name}/powDifficulty`,
      Value: '18',
    });
    expect(json).not.toContain('SecureString');
    for (const p of resourcesOf(mainT, 'AWS::SSM::Parameter')) {
      expect(p.Properties!.Name).not.toMatch(/HmacKey/i);
    }
  });

  it('DNS: alias records for the domain only with the custom domain', () => {
    if (!stage.customDomain) {
      expect(resourcesOf(mainT, 'AWS::Route53::RecordSet')).toHaveLength(0);
      return;
    }
    mainT.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: `${stage.domainName}.`,
      Type: 'A',
    });
    mainT.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: `${stage.domainName}.`,
      Type: 'AAAA',
    });
  });

  it('site URL output: the CloudFront domain, or the custom domain once enabled', () => {
    const out = JSON.stringify(mainT.toJSON().Outputs);
    if (stage.customDomain) expect(out).toContain(`https://${stage.domainName}`);
    else expect(out).toMatch(/"SiteUrl".*DomainName/);
  });

  it('edge: certificate for the domain and a CloudFront WAF with the planned rate limits', () => {
    expect(b.edge.region).toBe('us-east-1');
    if (stage.customDomain) {
      edgeT.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: stage.domainName,
        ValidationMethod: 'DNS',
      });
    } else {
      expect(resourcesOf(edgeT, 'AWS::CertificateManager::Certificate')).toHaveLength(0);
    }
    const acl = resourcesOf(edgeT, 'AWS::WAFv2::WebACL')[0]!;
    const props = acl.Properties as {
      Scope: string;
      VisibilityConfig: { SampledRequestsEnabled: boolean };
      Rules: {
        Name: string;
        VisibilityConfig: { SampledRequestsEnabled: boolean };
        Statement: { RateBasedStatement?: { Limit: number; EvaluationWindowSec: number } };
      }[];
    };
    expect(props.Scope).toBe('CLOUDFRONT');
    expect(props.VisibilityConfig.SampledRequestsEnabled).toBe(false);
    const limits = Object.fromEntries(
      props.Rules.filter((r) => r.Statement.RateBasedStatement).map((r) => [
        r.Name,
        r.Statement.RateBasedStatement!.Limit,
      ]),
    );
    expect(limits).toEqual({
      RateCreate: RATE_LIMITS.create,
      RateConsume: RATE_LIMITS.consume,
      RateChallenge: RATE_LIMITS.challenge,
      RateGlobal: RATE_LIMITS.global,
    });
    for (const r of props.Rules) expect(r.VisibilityConfig.SampledRequestsEnabled).toBe(false);
    expect(JSON.stringify(props)).toContain('SizeRestrictions_BODY');
    expect(props.Rules.map((r) => r.Name)).toContain('BodyOverCap');
  });

  it('tags every stack with app=brix-share', () => {
    expect(JSON.stringify(mainT.toJSON())).toContain('brix-share');
    for (const s of [b.main, b.edge, b.zoneStack]) {
      if (s) expect(s.tags.tagValues()).toMatchObject({ app: 'brix-share', stage: stage.name });
    }
  });
});

describe('stage wiring', () => {
  it('only prod is configured; its zone stack exists in both modes so the delegation can happen first', () => {
    expect([...new Set(built.map((b) => b.stage.name))]).toEqual(['prod']);
    for (const b of built) {
      expect(b.zoneStack).toBeDefined();
      b.zoneT!.hasResourceProperties('AWS::Route53::HostedZone', {
        Name: `${b.stage.domainName}.`,
      });
      expect(b.main.dependencies).toContain(b.edge);
      // The certificate validates against the zone, so the edge stack depends on it only with the domain.
      expect(b.edge.dependencies.includes(b.zoneStack!)).toBe(b.stage.customDomain);
    }
  });

  it('main stack reads the web ACL (and the certificate when used) from the us-east-1 edge stack', () => {
    for (const b of built) {
      const dist = JSON.stringify(b.mainT.toJSON());
      expect(dist).toContain('"Fn::GetStackOutput"');
      expect(dist).toContain(`"StackName":"BrixShare-${b.stage.name}-edge"`);
      expect(dist.includes('Certificate')).toBe(b.stage.customDomain);
    }
  });
});

describe('sweeper schedule', () => {
  it('runs every 5 minutes with a timeout well under it', () => {
    const b = built[0]!;
    b.mainT.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(5 minutes)' });
    const sweeper = resourcesOf(b.mainT, 'AWS::Lambda::Function').find(
      (f) => f.Properties!.Timeout === 120,
    );
    expect(sweeper).toBeDefined();
  });
});
