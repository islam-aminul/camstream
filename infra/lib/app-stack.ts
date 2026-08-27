import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { CamStreamConfig } from './config';
import { Storage } from './storage';
import { Registry } from './registry';
import { Identity } from './identity';
import { Ingest } from './ingest';
import { Api } from './api';
import { Edge } from './edge';
import { Signing, PRIVATE_KEY_PARAMETER } from './signing';
import { Provisioning, CLAIM_CERT_PARAMETER } from './provisioning';

export interface AppStackProps extends StackProps {
  readonly config: CamStreamConfig;
  readonly hostedZone: route53.IPublicHostedZone;
  readonly certificate: acm.ICertificate;
}

export class CamStreamAppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, hostedZone, certificate } = props;

    const storage = new Storage(this, 'Storage', { config });
    const registry = new Registry(this, 'Registry');
    const identity = new Identity(this, 'Identity');
    const signing = new Signing(this, 'Signing');

    const ingest = new Ingest(this, 'Ingest', { liveBucket: storage.liveBucket });

    // Fleet provisioning by claim: an installer carries a shared claim
    // certificate plus a per-agent one-time token, and the hook refuses
    // anything else.
    const provisioning = new Provisioning(this, 'Provisioning', {
      registryTable: registry.table,
      devicePolicyName: 'camstream-device-policy',
      thingTypeName: 'camstream-agent',
    });

    const api = new Api(this, 'Api', {
      config,
      userPool: identity.userPool,
      userPoolClient: identity.userPoolClient,
      registryTable: registry.table,
      cloudFrontKeyPairId: signing.publicKey.publicKeyId,
      privateKeyParameterName: PRIVATE_KEY_PARAMETER,
      liveBucketName: storage.liveBucket.bucketName,
      liveBucket: storage.liveBucket,
      agentVersion: this.node.tryGetContext('camstream:agentVersion') ?? '0.1.0',
      claimCertParameterName: CLAIM_CERT_PARAMETER,
      provisioningTemplateName: provisioning.templateName,
    });

    // Agents sign heartbeats with SigV4 using their IoT-issued credentials.
    // The signature covers the Host header, so agents must call API Gateway
    // directly — CloudFront rewrites Host to the origin and would invalidate it.
    ingest.deviceRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeHeartbeat',
        actions: ['execute-api:Invoke'],
        resources: [
          api.httpApi.arnForExecuteApi('POST', '/api/device/report'),
          api.httpApi.arnForExecuteApi('GET', '/api/device/config'),
        ],
      }),
    );

    const edge = new Edge(this, 'Edge', {
      config,
      liveBucket: storage.liveBucket,
      webBucket: storage.webBucket,
      apiOriginDomain: api.originDomain,
      keyGroup: signing.keyGroup,
      certificate,
    });

    // Somebody has to be told when the control plane starts failing. Nothing
    // alarmed at all before this, so a broken session mint or a wedged admin
    // function would have been discovered by a customer rather than by us.
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      displayName: 'CamStream alarms',
    });
    new CfnOutput(this, 'AlarmTopicArn', {
      description: 'Subscribe an address to this to receive control-plane alarms',
      value: alarmTopic.topicArn,
    });

    for (const [name, fn] of Object.entries(api.functions)) {
      new cloudwatch.Alarm(this, `${name}Errors`, {
        alarmDescription: `${name} is returning errors`,
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        // Missing data is no invocations, which is the normal state of an idle
        // deployment and emphatically not a problem.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    }

    new cloudwatch.Alarm(this, 'ApiServerErrors', {
      alarmDescription: 'The control plane is returning 5xx',
      metric: api.httpApi.metricServerError({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    const aliasTarget = route53.RecordTarget.fromAlias(
      new targets.CloudFrontTarget(edge.distribution),
    );
    for (const name of [config.appDomain, ...config.altDomains]) {
      const suffix = name === config.appDomain ? 'Apex' : name.split('.')[0];
      new route53.ARecord(this, `AliasA${suffix}`, { zone: hostedZone, recordName: name, target: aliasTarget });
      new route53.AaaaRecord(this, `AliasAAAA${suffix}`, { zone: hostedZone, recordName: name, target: aliasTarget });
    }

    new CfnOutput(this, 'SiteUrl', { value: `https://${config.appDomain}` });
    new CfnOutput(this, 'DistributionDomain', { value: edge.distribution.distributionDomainName });
    new CfnOutput(this, 'DistributionId', { value: edge.distribution.distributionId });
    new CfnOutput(this, 'LiveBucket', { value: storage.liveBucket.bucketName });
    new CfnOutput(this, 'WebBucket', { value: storage.webBucket.bucketName });
    new CfnOutput(this, 'UserPoolId', { value: identity.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: identity.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'RegistryTable', { value: registry.table.tableName });
    new CfnOutput(this, 'CloudFrontKeyPairId', { value: signing.publicKey.publicKeyId });
    new CfnOutput(this, 'IotRoleAlias', { value: 'camstream-device' });
    new CfnOutput(this, 'ProvisioningTemplate', { value: provisioning.templateName });
    new CfnOutput(this, 'ClaimPolicyName', { value: provisioning.claimPolicyName });
    new CfnOutput(this, 'ApiInvokeUrl', {
      description: 'Direct API Gateway URL — agents must use this, not the CloudFront domain',
      value: api.httpApi.apiEndpoint,
    });
  }
}
