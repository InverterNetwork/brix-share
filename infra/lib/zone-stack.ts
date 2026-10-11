import { CfnOutput, Fn, Stack, type StackProps, aws_route53 as route53 } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface ZoneStackProps extends StackProps {
  zoneName: string;
}

/** Delegated zone (prod). Deployed first so the NS delegation exists before ACM validates. */
export class ZoneStack extends Stack {
  readonly zone: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: ZoneStackProps) {
    super(scope, id, props);
    const zone = new route53.PublicHostedZone(this, 'Zone', { zoneName: props.zoneName });
    this.zone = zone;
    new CfnOutput(this, 'NameServers', {
      value: Fn.join(' ', zone.hostedZoneNameServers ?? []),
      description: `Create these four NS records for ${props.zoneName} at the parent DNS provider`,
    });
  }
}
