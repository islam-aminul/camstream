import { Annotations, CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
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

    /*
     * Who gets told.
     *
     * Taken from context rather than written here, because an alarm address is
     * deployment configuration and often a shared mailbox nobody wants in a
     * public repository:
     *
     *   npx cdk deploy CamStreamApp -c alarmEmail=alerts@example.com
     *
     * or set `alarmEmail` in cdk.json to make it stick. AWS sends a
     * confirmation link once; until it is clicked nothing is delivered, and
     * "the subscription exists" is not the same as "somebody is being told".
     *
     * Without it the alarms still exist and still fire - into a topic with no
     * subscribers, which is exactly the state this is here to end - so synth
     * says so out loud rather than deploying a quiet nothing.
     */
    const alarmEmail = this.node.tryGetContext('alarmEmail');
    if (typeof alarmEmail === 'string' && alarmEmail.includes('@')) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(alarmEmail));
    } else {
      Annotations.of(this).addWarning(
        'No alarmEmail in context: alarms will fire into a topic with no subscribers. '
        + 'Deploy with -c alarmEmail=you@example.com, and confirm the email AWS sends.',
      );
    }

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

    /*
     * Throttling, which errors do not cover.
     *
     * A throttled invocation is not an error, it is an invocation that never
     * happened - the caller gets a 429 and the function's own error metric
     * stays at zero. This account spent weeks capped at ten concurrent
     * executions against a default of a thousand, shedding requests, and no
     * alarm here would have said so.
     */
    for (const [name, fn] of Object.entries(api.functions)) {
      new cloudwatch.Alarm(this, `${name}Throttles`, {
        alarmDescription: `${name} is being throttled - requests are being shed`,
        metric: fn.metricThrottles({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    }

    /*
     * The registry refusing reads or writes.
     *
     * On-demand billing makes this rare, but a hot partition does not care
     * about billing mode: every camera at one site shares a partition key, so
     * a large site under load is exactly where this would appear. It surfaces
     * to a viewer as a blank estate rather than as an error.
     */
    new cloudwatch.Alarm(this, 'RegistryThrottled', {
      alarmDescription: 'DynamoDB is throttling the registry',
      metric: new cloudwatch.MathExpression({
        expression: 'reads + writes',
        usingMetrics: {
          reads: registry.table.metric('ReadThrottleEvents', { statistic: 'Sum' }),
          writes: registry.table.metric('WriteThrottleEvents', { statistic: 'Sum' }),
        },
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    /*
     * Nothing is talking to us.
     *
     * Agents heartbeat over MQTT to a topic rule that writes straight to the
     * registry - they do not call a Lambda, which is the point of the rule - so
     * the signal is the rule's own TopicMatch, published by IoT for free.
     *
     * An earlier version of this counted calls to the device Lambda, on the
     * assumption that agents reported on their heartbeat. They do not: that
     * endpoint is called only when something changes, so the metric sat at
     * zero with two healthy agents streaming, and the alarm was firing within
     * minutes of being deployed. Measure the path the traffic actually takes.
     *
     * Forty-five minutes because an idle agent heartbeats every fifteen
     * (`heartbeatIdleMinutes`), so a shorter window would alarm on the normal
     * cadence of a quiet estate. Three intervals is enough to be sure and
     * still catches a real outage within the hour.
     *
     * Deliberately fleet-wide. One agent going quiet is a site losing power,
     * which belongs in the console rather than in a page at three in the
     * morning.
     *
     * Missing data breaches here, unlike everywhere else: no data points at
     * all is precisely the condition being detected.
     */
    new cloudwatch.Alarm(this, 'NoAgentHeartbeats', {
      alarmDescription: 'No agent has sent a heartbeat for forty-five minutes',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/IoT',
        metricName: 'TopicMatch',
        dimensionsMap: { RuleName: 'camstream_agent_heartbeat' },
        statistic: 'Sum',
        period: Duration.minutes(45),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    /*
     * Heartbeats arriving and not being recorded.
     *
     * The quietest failure in the system: IoT accepts the message, the rule
     * matches, and the action writing it to the registry fails. Every agent
     * looks connected from its own side while the console shows an estate
     * that stopped reporting, and nothing else here would notice - the rule
     * runs no Lambda, so no error metric covers it.
     */
    for (const rule of ['camstream_agent_heartbeat', 'camstream_agent_presence']) {
      new cloudwatch.Alarm(this, `${rule === 'camstream_agent_heartbeat' ? 'Heartbeat' : 'Presence'}RuleFailures`, {
        alarmDescription: `The ${rule} topic rule is failing to act on messages`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/IoT',
          metricName: 'Failure',
          dimensionsMap: { RuleName: rule },
          statistic: 'Sum',
          period: Duration.minutes(15),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
    }

    /*
     * Viewers being refused.
     *
     * A declined rendition is a tile showing "the site is at capacity" that
     * will not recover by itself: the agent has been asked to convert more
     * cameras at once than it may. Sustained rather than instantaneous,
     * because one refusal during a busy minute is the cap working as intended
     * and an hour of them is a site that needs a bigger machine or a higher
     * ceiling.
     */
    new cloudwatch.Alarm(this, 'TranscodesDeclined', {
      alarmDescription: 'Viewers are being refused conversions - a site is at capacity',
      metric: new cloudwatch.Metric({
        namespace: 'CamStream',
        metricName: 'TranscodesDeclined',
        statistic: 'Sum',
        period: Duration.minutes(15),
      }),
      threshold: 10,
      evaluationPeriods: 2,
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
