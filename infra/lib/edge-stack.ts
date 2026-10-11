import {
  Stack,
  type StackProps,
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_wafv2 as wafv2,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { ZoneRef } from './stages.ts';
import { webAclRules, webAclVisibility } from './waf.ts';

export interface EdgeStackProps extends StackProps {
  /** Custom domain with its zone; without it there is no certificate (CloudFront default domain). */
  domain?: { name: string; zoneRef: ZoneRef };
}

/** CloudFront-scoped resources that must live in us-east-1: certificate and WAF web ACL. */
export class EdgeStack extends Stack {
  readonly certificate: acm.ICertificate | undefined;
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    if (this.region !== 'us-east-1') throw new Error('EdgeStack must be deployed to us-east-1');

    this.certificate = props.domain
      ? new acm.Certificate(this, 'Certificate', {
          domainName: props.domain.name,
          validation: acm.CertificateValidation.fromDns(
            route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
              hostedZoneId: props.domain.zoneRef.zoneId,
              zoneName: props.domain.zoneRef.zoneName,
            }),
          ),
        })
      : undefined;

    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      rules: webAclRules(),
      visibilityConfig: webAclVisibility(),
    });
    this.webAclArn = acl.attrArn;
  }
}
