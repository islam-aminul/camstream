import { CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { CamStreamConfig } from './config';

export interface ZoneStackProps extends StackProps {
  readonly config: CamStreamConfig;
}

/**
 * The hosted zone, alone in its own stack.
 *
 * It is deployed first and in isolation because the ACM certificate cannot
 * validate until the registrar delegates to these nameservers — bundling the
 * two would leave the whole stack blocked in CREATE_IN_PROGRESS while a human
 * edits DNS at the registrar.
 *
 * Placed in us-east-1 so the certificate stack can reference it without a
 * cross-region lookup. Route 53 itself is global; the region is immaterial.
 */
export class CamStreamZoneStack extends Stack {
  public readonly hostedZone: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: ZoneStackProps) {
    super(scope, id, props);

    this.hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
      zoneName: props.config.domainName,
      comment: 'CamStream',
    });

    new CfnOutput(this, 'HostedZoneId', { value: this.hostedZone.hostedZoneId });
    new CfnOutput(this, 'NameServers', {
      description: 'Set these four as the nameservers for the domain at your registrar',
      value: Fn.join(' ', this.hostedZone.hostedZoneNameServers ?? []),
    });
  }
}
