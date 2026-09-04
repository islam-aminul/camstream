import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { CamStreamConfig } from './config';

const LAMBDA_DIR = path.join(__dirname, '..', 'lambda');

export interface ApiProps {
  readonly config: CamStreamConfig;
  readonly liveBucketName: string;
  readonly claimCertParameterName: string;
  readonly provisioningTemplateName: string;
  /** Version of the agent bundle installers should fetch. */
  readonly agentVersion: string;
  readonly liveBucket: s3.IBucket;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly registryTable: dynamodb.Table;
  readonly cloudFrontKeyPairId: string;
  readonly privateKeyParameterName: string;
}

/**
 * The control plane. Deliberately *not* on the media path — these routes are
 * hit on login and every 30s per device, never per segment.
 */
export class Api extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  /** Every function here, so the stack can alarm on each without repeating itself. */
  public readonly functions: Record<string, lambda.IFunction> = {};
  /**
   * The admin function, concretely rather than as an interface.
   *
   * The stack grants it the alarm topic and tells it where that topic is, and
   * both need the real type - `IFunction` can be granted to but cannot be
   * given an environment variable.
   */
  public readonly adminFunction!: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { config, userPool, userPoolClient, registryTable } = props;
    const stack = Stack.of(this);

    // An explicit log group per function, rather than `logRetention`, which
    // provisions a custom-resource Lambda just to set a retention policy.
    const logGroupFor = (functionName: string) =>
      new logs.LogGroup(this, `${functionName}Logs`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    const defaults = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      bundling: {
        format: OutputFormat.ESM,
        minify: true,
        sourceMap: false,
        target: 'node22',
        // The SDK ships inside the managed runtime; bundling it would add
        // megabytes and cold-start time for no benefit.
        externalModules: ['@aws-sdk/*'],
      },
    };

    const sessionFn = new NodejsFunction(this, 'SessionFunction', {
      ...defaults,
      functionName: 'camstream-session',
      logGroup: logGroupFor('camstream-session'),
      description: 'Mints CloudFront signed cookies scoped to the caller tenant',
      entry: path.join(LAMBDA_DIR, 'session', 'index.ts'),
      environment: {
        CF_KEY_PAIR_ID: props.cloudFrontKeyPairId,
        CF_PRIVATE_KEY_PARAM: props.privateKeyParameterName,
        ALLOWED_HOSTS: [config.appDomain, ...config.altDomains].join(','),
        REGISTRY_TABLE: registryTable.tableName,
      },
    });
    registryTable.grantReadWriteData(sessionFn);

    sessionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          stack.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: props.privateKeyParameterName.replace(/^\//, ''),
          }),
        ],
      }),
    );

    const streamsFn = new NodejsFunction(this, 'StreamsFunction', {
      ...defaults,
      functionName: 'camstream-streams',
      logGroup: logGroupFor('camstream-streams'),
      description: 'Lists the cameras visible to the caller tenant',
      entry: path.join(LAMBDA_DIR, 'streams', 'index.ts'),
      environment: { REGISTRY_TABLE: registryTable.tableName },
    });
    registryTable.grantReadData(streamsFn);

    const deviceFn = new NodejsFunction(this, 'DeviceFunction', {
      ...defaults,
      functionName: 'camstream-device',
      logGroup: logGroupFor('camstream-device'),
      description: 'Agent reports and configuration fetch — both event-driven',
      entry: path.join(LAMBDA_DIR, 'device', 'index.ts'),
      environment: { REGISTRY_TABLE: registryTable.tableName },
    });
    registryTable.grantReadWriteData(deviceFn);
    // Needed to turn the certificate id in the caller's ARN into a thing name.
    deviceFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:ListPrincipalThings'],
        // The principal being listed is a certificate, so the grant needs no
        // wider reach than certificates in this account.
        resources: [stack.formatArn({ service: 'iot', resource: 'cert', resourceName: '*' })],
      }),
    );

    const presenceFn = new NodejsFunction(this, 'PresenceFunction', {
      ...defaults,
      functionName: 'camstream-presence',
      logGroup: logGroupFor('camstream-presence'),
      description: 'Turns IoT connect/disconnect events into agent liveness',
      entry: path.join(LAMBDA_DIR, 'presence', 'index.ts'),
      environment: { REGISTRY_TABLE: registryTable.tableName },
    });
    registryTable.grantReadWriteData(presenceFn);
    presenceFn.addPermission('IotRuleInvoke', {
      principal: new iam.ServicePrincipal('iot.amazonaws.com'),
      sourceAccount: stack.account,
      // Pinned to the rule, not merely the account: any topic rule in the
      // account could otherwise invoke this and write agent liveness.
      sourceArn: stack.formatArn({
        service: 'iot', resource: 'rule', resourceName: 'camstream_agent_presence',
      }),
    });

    // Lifecycle events replace the heartbeat poll entirely: this is the actual
    // connection state, delivered the moment it changes.
    new iot.CfnTopicRule(this, 'PresenceRule', {
      ruleName: 'camstream_agent_presence',
      topicRulePayload: {
        description: 'Agent connect/disconnect to registry liveness',
        sql: "SELECT * FROM '$aws/events/presence/+/+'",
        awsIotSqlVersion: '2016-03-23',
        ruleDisabled: false,
        actions: [{ lambda: { functionArn: presenceFn.functionArn } }],
      },
    });

    // Health, as opposed to liveness. Presence says the socket is up; it
    // cannot say whether the agent is doing anything useful, and the failures
    // that strand a site — a wedged encoder, a camera refusing every
    // connection, a full disk — leave the socket perfectly healthy.
    //
    // This writes straight to DynamoDB with no Lambda in the path, so a
    // heartbeat costs one MQTT message and one 100-byte write. That is what
    // makes the cadence affordable to keep at all: at the idle rate an agent
    // costs a few cents a year to monitor.
    const heartbeatRole = new iam.Role(this, 'HeartbeatRuleRole', {
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
      description: 'Lets the heartbeat topic rule write agent health',
    });
    heartbeatRole.addToPolicy(
      new iam.PolicyStatement({
        // PutItem only: a rule that could read the table would be able to
        // exfiltrate every tenant's registry through a crafted payload.
        actions: ['dynamodb:PutItem'],
        resources: [registryTable.tableArn],
      }),
    );

    new iot.CfnTopicRule(this, 'HeartbeatRule', {
      ruleName: 'camstream_agent_heartbeat',
      topicRulePayload: {
        description: 'Agent health heartbeats to the registry',
        // The thing name is taken from the topic, never from the payload: a
        // certificate is only allowed to publish under its own thing name, so
        // the topic is authenticated and the payload is not.
        sql: [
          // The tenant is the thing name up to its first separator. IoT SQL
          // has no split, so this indexes to the separator directly.
          "SELECT concat('TENANT#', substring(topic(2), 0, indexof(topic(2), '--'))) AS pk,",
          "concat('HEALTH#', topic(2)) AS sk,",
          'topic(2) AS thingName,',
          'agentVersion, uptimeSeconds, publishing, camerasConfigured,',
          'healthy, failingTasks,',
          // What the machine has left, and which part of it is binding. The
          // 128-stream ceiling is a hard limit and never the real one: an
          // agent runs out of processor, memory, disk or uplink long before
          // it runs out of that, and an operator told "128 maximum" while
          // video stutters at thirty has been told nothing useful.
          'constraint, constraintMessage, maxConcurrentTranscodes,',
          'cpuLoad, memoryUsedFraction, memoryFreeBytes, diskFreeBytes,',
          'uploadBytesPerSecond, uploadMillisPerSegment,',
          'floor(timestamp() / 1000) AS heartbeatAt,',
          // Health is only ever read as "the latest"; a record nobody replaced
          // in three days describes an agent that is long gone.
          'floor(timestamp() / 1000) + 259200 AS expiresAt',
          "FROM 'camstream/+/heartbeat'",
        ].join(' '),
        awsIotSqlVersion: '2016-03-23',
        ruleDisabled: false,
        actions: [
          {
            // A separate item from the device record, because this action puts
            // rather than updates: writing it onto DEVICE# would replace
            // everything else the agent's registration holds.
            dynamoDBv2: {
              putItem: { tableName: registryTable.tableName },
              roleArn: heartbeatRole.roleArn,
            },
          },
        ],
      },
    });

    // The MQTT data endpoint is account-specific and has no CloudFormation
    // attribute, so it is resolved once at deploy time.
    const iotEndpoint = new cr.AwsCustomResource(this, 'IotDataEndpoint', {
      onUpdate: {
        service: 'Iot',
        action: 'describeEndpoint',
        parameters: { endpointType: 'iot:Data-ATS' },
        physicalResourceId: cr.PhysicalResourceId.of('camstream-iot-data-endpoint'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      logGroup: new logs.LogGroup(this, 'IotDataEndpointLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    const credentialEndpoint = new cr.AwsCustomResource(this, 'IotCredentialEndpoint', {
      onUpdate: {
        service: 'Iot',
        action: 'describeEndpoint',
        parameters: { endpointType: 'iot:CredentialProvider' },
        physicalResourceId: cr.PhysicalResourceId.of('camstream-iot-credential-endpoint'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      logGroup: new logs.LogGroup(this, 'IotCredentialEndpointLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    const watchFn = new NodejsFunction(this, 'WatchFunction', {
      ...defaults,
      functionName: 'camstream-watch',
      logGroup: logGroupFor('camstream-watch'),
      description: 'Turns viewer demand into per-agent publish instructions',
      entry: path.join(LAMBDA_DIR, 'watch', 'index.ts'),
      environment: {
        REGISTRY_TABLE: registryTable.tableName,
        IOT_DATA_ENDPOINT: iotEndpoint.getResponseField('endpointAddress'),
      },
    });
    registryTable.grantReadWriteData(watchFn);
    watchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iot:Publish'],
        resources: [
          stack.formatArn({ service: 'iot', resource: 'topic', resourceName: 'camstream/*' }),
        ],
      }),
    );

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'camstream-api',
      description: 'CamStream control plane',
      // No CORS block: the API is reached same-origin through CloudFront.
      createDefaultStage: true,
    });

    // The stage inherited the account default of 10,000 requests a second, so
    // every authenticated route was unmetered per caller — and two of them are
    // expensive by design: /api/session does an SSM read and an RSA signature,
    // /api/watch reads three key ranges and publishes MQTT. One careless or
    // compromised viewer account was a cost lever against the customer's own
    // bill, which is awkward for a product whose headline is that it only
    // spends money while somebody is watching.
    //
    // Generous enough that a real player never meets it: a viewer makes a few
    // calls a minute, and an estate's agents do not come through here at all.
    const stage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
      detailedMetricsEnabled: true,
    };

    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/camstream-api',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    stage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      // Enough to answer "who called what, when, and did it work".
      format: JSON.stringify({
        requestId: '$context.requestId',
        at: '$context.requestTime',
        method: '$context.httpMethod',
        path: '$context.path',
        status: '$context.status',
        latencyMs: '$context.responseLatency',
        principal: '$context.authorizer.claims.sub',
        ip: '$context.identity.sourceIp',
      }),
    };

    const viewerAuth = new authorizers.HttpUserPoolAuthorizer('ViewerAuthorizer', userPool, {
      userPoolClients: [userPoolClient],
      identitySource: ['$request.header.Authorization'],
    });

    this.httpApi.addRoutes({
      path: '/api/session',
      methods: [apigwv2.HttpMethod.POST],
      authorizer: viewerAuth,
      integration: new integrations.HttpLambdaIntegration('SessionIntegration', sessionFn),
    });

    this.httpApi.addRoutes({
      path: '/api/streams',
      methods: [apigwv2.HttpMethod.GET],
      authorizer: viewerAuth,
      integration: new integrations.HttpLambdaIntegration('StreamsIntegration', streamsFn),
    });

    const adminFn = new NodejsFunction(this, 'AdminFunction', {
      ...defaults,
      functionName: 'camstream-admin',
      logGroup: logGroupFor('camstream-admin'),
      description: 'Tenant administration: users, agents and camera approval',
      entry: path.join(LAMBDA_DIR, 'admin', 'index.ts'),
      timeout: Duration.seconds(20),
      environment: {
        REGISTRY_TABLE: registryTable.tableName,
        USER_POOL_ID: userPool.userPoolId,
        IOT_DATA_ENDPOINT: iotEndpoint.getResponseField('endpointAddress'),
        CLAIM_CERT_PARAM: props.claimCertParameterName,
        PROVISIONING_TEMPLATE: props.provisioningTemplateName,
        IOT_CREDENTIAL_ENDPOINT: credentialEndpoint.getResponseField('endpointAddress'),
        LIVE_BUCKET: props.liveBucketName,
        API_INVOKE_URL: this.httpApi.apiEndpoint,
        AGENT_VERSION: props.agentVersion,
      },
    });
    registryTable.grantReadWriteData(adminFn);
    adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iot:Publish'],
      resources: [stack.formatArn({ service: 'iot', resource: 'topic', resourceName: 'camstream/*' })],
    }));
    // Retiring an agent: detach and delete its certificate, then the thing.
    // Without this an enrolled device could never be decommissioned, and a
    // premises that had ever held one could never be deleted either.
    adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'iot:ListThingPrincipals',
        'iot:DetachThingPrincipal',
        'iot:ListAttachedPolicies',
        'iot:DetachPolicy',
        'iot:UpdateCertificate',
        'iot:DeleteCertificate',
        'iot:DeleteThing',
      ],
      resources: [
        stack.formatArn({ service: 'iot', resource: 'thing', resourceName: '*' }),
        stack.formatArn({ service: 'iot', resource: 'cert', resourceName: '*' }),
      ],
    }));
    // Presigning a download link needs read on the downloads prefix only.
    props.liveBucket.grantRead(adminFn, 'downloads/*');
    adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [stack.formatArn({
        service: 'ssm', resource: 'parameter',
        resourceName: props.claimCertParameterName.replace(/^\//, ''),
      })],
    }));
    adminFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDeleteUser',
          // Needed to establish which tenant an account belongs to before
          // acting on it — deleting one used to check the caller's role but
          // never the target's tenant.
          'cognito-idp:AdminGetUser',
          // Changing a role means leaving the old group as well as joining the
          // new one, and moving someone between sites rewrites an attribute.
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          // Needed to report each user's role, which is group membership.
          'cognito-idp:AdminListGroupsForUser',
          // Suspending an account rather than deleting it: the reversible
          // option, and the one the console recommends before deletion.
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminDisableUser',
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    const adminIntegration = new integrations.HttpLambdaIntegration('AdminIntegration', adminFn);
    // Authorisation is inside the Lambda: the JWT authorizer proves identity,
    // group membership decides what that identity may do.
    for (const [method, routePath] of [
      [apigwv2.HttpMethod.GET, '/api/admin/me'],
      [apigwv2.HttpMethod.GET, '/api/admin/customers'],
      [apigwv2.HttpMethod.POST, '/api/admin/customers'],
      [apigwv2.HttpMethod.GET, '/api/admin/premises'],
      [apigwv2.HttpMethod.POST, '/api/admin/premises'],
      [apigwv2.HttpMethod.DELETE, '/api/admin/premises/{premisesId}'],
      [apigwv2.HttpMethod.GET, '/api/admin/agents'],
      [apigwv2.HttpMethod.GET, '/api/admin/cameras'],
      [apigwv2.HttpMethod.GET, '/api/admin/counts'],
      [apigwv2.HttpMethod.GET, '/api/admin/search'],
      [apigwv2.HttpMethod.POST, '/api/admin/agents'],
      [apigwv2.HttpMethod.PATCH, '/api/admin/agents/{thingName}'],
      [apigwv2.HttpMethod.DELETE, '/api/admin/agents/{thingName}'],
      [apigwv2.HttpMethod.GET, '/api/admin/agents/{thingName}/identity'],
      [apigwv2.HttpMethod.GET, '/api/admin/agents/{thingName}/installer'],
      [apigwv2.HttpMethod.POST, '/api/admin/scan'],
      [apigwv2.HttpMethod.POST, '/api/admin/agents/{thingName}/update'],
      [apigwv2.HttpMethod.GET, '/api/admin/discovered'],
      [apigwv2.HttpMethod.POST, '/api/admin/cameras'],
      [apigwv2.HttpMethod.GET, '/api/admin/alerts'],
      [apigwv2.HttpMethod.POST, '/api/admin/alerts'],
      [apigwv2.HttpMethod.DELETE, '/api/admin/alerts'],
      [apigwv2.HttpMethod.POST, '/api/admin/cameras/move'],
      [apigwv2.HttpMethod.PATCH, '/api/admin/cameras/{identity}'],
      [apigwv2.HttpMethod.DELETE, '/api/admin/cameras/{identity}'],
      [apigwv2.HttpMethod.GET, '/api/admin/credentials'],
      [apigwv2.HttpMethod.POST, '/api/admin/credentials'],
      [apigwv2.HttpMethod.DELETE, '/api/admin/credentials'],
      [apigwv2.HttpMethod.GET, '/api/admin/users'],
      [apigwv2.HttpMethod.POST, '/api/admin/users'],
      [apigwv2.HttpMethod.PATCH, '/api/admin/users/{username}'],
      [apigwv2.HttpMethod.DELETE, '/api/admin/users/{username}'],
    ] as [apigwv2.HttpMethod, string][]) {
      this.httpApi.addRoutes({
        path: routePath,
        methods: [method],
        authorizer: viewerAuth,
        integration: adminIntegration,
      });
    }

    this.httpApi.addRoutes({
      path: '/api/watch',
      methods: [apigwv2.HttpMethod.POST],
      authorizer: viewerAuth,
      integration: new integrations.HttpLambdaIntegration('WatchIntegration', watchFn),
    });

    // SigV4-signed by the agent using its IoT-issued temporary credentials.
    const deviceIntegration = new integrations.HttpLambdaIntegration('DeviceIntegration', deviceFn);
    const iamAuth = new authorizers.HttpIamAuthorizer();
    this.httpApi.addRoutes({
      path: '/api/device/report',
      methods: [apigwv2.HttpMethod.POST],
      authorizer: iamAuth,
      integration: deviceIntegration,
    });
    this.httpApi.addRoutes({
      path: '/api/device/config',
      methods: [apigwv2.HttpMethod.GET],
      authorizer: iamAuth,
      integration: deviceIntegration,
    });

    (this as { adminFunction: NodejsFunction }).adminFunction = adminFn;
    Object.assign(this.functions, {
      Session: sessionFn,
      Streams: streamsFn,
      Device: deviceFn,
      Presence: presenceFn,
      Watch: watchFn,
      Admin: adminFn,
    });
  }

  /** Hostname CloudFront should use as the API origin. */
  public get originDomain(): string {
    return `${this.httpApi.apiId}.execute-api.${Stack.of(this).region}.${Stack.of(this).urlSuffix}`;
  }
}
