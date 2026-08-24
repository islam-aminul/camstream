import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { CamStreamConfig } from './config';

export interface CertStackProps extends StackProps {
  readonly config: CamStreamConfig;
  readonly hostedZone: route53.IPublicHostedZone;
}

/**
 * Must be us-east-1: CloudFront accepts certificates from no other region.
 *
 * Deploy only after the registrar points at the zone's nameservers, otherwise
 * DNS validation cannot resolve and this stack will sit waiting.
 */
export class CamStreamCertStack extends Stack {
  public readonly certificate: acm.ICertificate;

  constructor(scope: Construct, id: string, props: CertStackProps) {
    super(scope, id, props);
    const { config, hostedZone } = props;

    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: config.domainName,
      subjectAlternativeNames: [`*.${config.domainName}`],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    new CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
  }
}
