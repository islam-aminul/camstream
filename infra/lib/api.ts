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
import { Construct } from 'constructs';
import * as path from 'node:path';
import { CamStreamConfig } from './config';

const LAMBDA_DIR = path.join(__dirname, '..', 'lambda');

export interface ApiProps {
  readonly config: CamStreamConfig;
  readonly liveBucketName: string;
  readonly claimCertParameterName: string;
  readonly provisioningTemplateName: string;
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

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { config, userPool, userPoolClient, registryTable } = props;
    const stack = Stack.of(this);

    // An explicit log group per function, rather than `logRetention`, which
    // provisions a custom-resource Lambda just to set a retention policy.
    const logGroupFor = (functionName: string) =>
      new logs.LogGroup(this, `${functionName}Logs`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_WEEK,
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
      new iam.PolicyStatement({ actions: ['iot:ListPrincipalThings'], resources: ['*'] }),
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
      },
    });
    registryTable.grantReadWriteData(adminFn);
    adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iot:Publish'],
      resources: [stack.formatArn({ service: 'iot', resource: 'topic', resourceName: 'camstream/*' })],
    }));
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
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    const adminIntegration = new integrations.HttpLambdaIntegration('AdminIntegration', adminFn);
    // Authorisation is inside the Lambda: the JWT authorizer proves identity,
    // group membership decides what that identity may do.
    for (const [method, routePath] of [
      [apigwv2.HttpMethod.GET, '/api/admin/me'],
      [apigwv2.HttpMethod.GET, '/api/admin/premises'],
      [apigwv2.HttpMethod.POST, '/api/admin/premises'],
      [apigwv2.HttpMethod.DELETE, '/api/admin/premises/{premisesId}'],
      [apigwv2.HttpMethod.GET, '/api/admin/agents'],
      [apigwv2.HttpMethod.POST, '/api/admin/agents'],
      [apigwv2.HttpMethod.GET, '/api/admin/agents/{thingName}/identity'],
      [apigwv2.HttpMethod.POST, '/api/admin/scan'],
      [apigwv2.HttpMethod.GET, '/api/admin/discovered'],
      [apigwv2.HttpMethod.POST, '/api/admin/cameras'],
      [apigwv2.HttpMethod.DELETE, '/api/admin/cameras/{identity}'],
      [apigwv2.HttpMethod.POST, '/api/admin/credentials'],
      [apigwv2.HttpMethod.GET, '/api/admin/users'],
      [apigwv2.HttpMethod.POST, '/api/admin/users'],
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
  }

  /** Hostname CloudFront should use as the API origin. */
  public get originDomain(): string {
    return `${this.httpApi.apiId}.execute-api.${Stack.of(this).region}.${Stack.of(this).urlSuffix}`;
  }
}
