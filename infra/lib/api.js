"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Api = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const authorizers = __importStar(require("aws-cdk-lib/aws-apigatewayv2-authorizers"));
const integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const iot = __importStar(require("aws-cdk-lib/aws-iot"));
const constructs_1 = require("constructs");
const path = __importStar(require("node:path"));
const LAMBDA_DIR = path.join(__dirname, '..', 'lambda');
/**
 * The control plane. Deliberately *not* on the media path — these routes are
 * hit on login and every 30s per device, never per segment.
 */
class Api extends constructs_1.Construct {
    httpApi;
    constructor(scope, id, props) {
        super(scope, id);
        const { config, userPool, userPoolClient, registryTable } = props;
        const stack = aws_cdk_lib_1.Stack.of(this);
        // An explicit log group per function, rather than `logRetention`, which
        // provisions a custom-resource Lambda just to set a retention policy.
        const logGroupFor = (functionName) => new logs.LogGroup(this, `${functionName}Logs`, {
            logGroupName: `/aws/lambda/${functionName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
        });
        const defaults = {
            runtime: lambda.Runtime.NODEJS_22_X,
            architecture: lambda.Architecture.ARM_64,
            memorySize: 256,
            timeout: aws_cdk_lib_1.Duration.seconds(10),
            bundling: {
                format: aws_lambda_nodejs_1.OutputFormat.ESM,
                minify: true,
                sourceMap: false,
                target: 'node22',
                // The SDK ships inside the managed runtime; bundling it would add
                // megabytes and cold-start time for no benefit.
                externalModules: ['@aws-sdk/*'],
            },
        };
        const sessionFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'SessionFunction', {
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
        sessionFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: [
                stack.formatArn({
                    service: 'ssm',
                    resource: 'parameter',
                    resourceName: props.privateKeyParameterName.replace(/^\//, ''),
                }),
            ],
        }));
        const streamsFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'StreamsFunction', {
            ...defaults,
            functionName: 'camstream-streams',
            logGroup: logGroupFor('camstream-streams'),
            description: 'Lists the cameras visible to the caller tenant',
            entry: path.join(LAMBDA_DIR, 'streams', 'index.ts'),
            environment: { REGISTRY_TABLE: registryTable.tableName },
        });
        registryTable.grantReadData(streamsFn);
        const deviceFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'DeviceFunction', {
            ...defaults,
            functionName: 'camstream-device',
            logGroup: logGroupFor('camstream-device'),
            description: 'Agent reports and configuration fetch — both event-driven',
            entry: path.join(LAMBDA_DIR, 'device', 'index.ts'),
            environment: { REGISTRY_TABLE: registryTable.tableName },
        });
        registryTable.grantReadWriteData(deviceFn);
        // Needed to turn the certificate id in the caller's ARN into a thing name.
        deviceFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['iot:ListPrincipalThings'],
            // The principal being listed is a certificate, so the grant needs no
            // wider reach than certificates in this account.
            resources: [stack.formatArn({ service: 'iot', resource: 'cert', resourceName: '*' })],
        }));
        const presenceFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'PresenceFunction', {
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
        heartbeatRole.addToPolicy(new iam.PolicyStatement({
            // PutItem only: a rule that could read the table would be able to
            // exfiltrate every tenant's registry through a crafted payload.
            actions: ['dynamodb:PutItem'],
            resources: [registryTable.tableArn],
        }));
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
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
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
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            }),
        });
        const watchFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'WatchFunction', {
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
        watchFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['iot:Publish'],
            resources: [
                stack.formatArn({ service: 'iot', resource: 'topic', resourceName: 'camstream/*' }),
            ],
        }));
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
        const adminFn = new aws_lambda_nodejs_1.NodejsFunction(this, 'AdminFunction', {
            ...defaults,
            functionName: 'camstream-admin',
            logGroup: logGroupFor('camstream-admin'),
            description: 'Tenant administration: users, agents and camera approval',
            entry: path.join(LAMBDA_DIR, 'admin', 'index.ts'),
            timeout: aws_cdk_lib_1.Duration.seconds(20),
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
        // Presigning a download link needs read on the downloads prefix only.
        props.liveBucket.grantRead(adminFn, 'downloads/*');
        adminFn.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ssm:GetParameter'],
            resources: [stack.formatArn({
                    service: 'ssm', resource: 'parameter',
                    resourceName: props.claimCertParameterName.replace(/^\//, ''),
                })],
        }));
        adminFn.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'cognito-idp:ListUsers',
                'cognito-idp:AdminCreateUser',
                'cognito-idp:AdminDeleteUser',
                'cognito-idp:AdminAddUserToGroup',
                'cognito-idp:AdminRemoveUserFromGroup',
                // Needed to report each user's role, which is group membership.
                'cognito-idp:AdminListGroupsForUser',
            ],
            resources: [userPool.userPoolArn],
        }));
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
            [apigwv2.HttpMethod.PATCH, '/api/admin/agents/{thingName}'],
            [apigwv2.HttpMethod.GET, '/api/admin/agents/{thingName}/identity'],
            [apigwv2.HttpMethod.GET, '/api/admin/agents/{thingName}/installer'],
            [apigwv2.HttpMethod.POST, '/api/admin/scan'],
            [apigwv2.HttpMethod.GET, '/api/admin/discovered'],
            [apigwv2.HttpMethod.POST, '/api/admin/cameras'],
            [apigwv2.HttpMethod.DELETE, '/api/admin/cameras/{identity}'],
            [apigwv2.HttpMethod.POST, '/api/admin/credentials'],
            [apigwv2.HttpMethod.GET, '/api/admin/users'],
            [apigwv2.HttpMethod.POST, '/api/admin/users'],
            [apigwv2.HttpMethod.DELETE, '/api/admin/users/{username}'],
        ]) {
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
    get originDomain() {
        return `${this.httpApi.apiId}.execute-api.${aws_cdk_lib_1.Stack.of(this).region}.${aws_cdk_lib_1.Stack.of(this).urlSuffix}`;
    }
}
exports.Api = Api;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE2RDtBQUM3RCxzRUFBd0Q7QUFDeEQsc0ZBQXdFO0FBQ3hFLHdGQUEwRTtBQUcxRSx5REFBMkM7QUFDM0MsK0RBQWlEO0FBQ2pELHFFQUE2RTtBQUM3RSwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELHlEQUEyQztBQUUzQywyQ0FBdUM7QUFDdkMsZ0RBQWtDO0FBR2xDLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztBQWlCeEQ7OztHQUdHO0FBQ0gsTUFBYSxHQUFJLFNBQVEsc0JBQVM7SUFDaEIsT0FBTyxDQUFrQjtJQUV6QyxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQWU7UUFDdkQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUNqQixNQUFNLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxjQUFjLEVBQUUsYUFBYSxFQUFFLEdBQUcsS0FBSyxDQUFDO1FBQ2xFLE1BQU0sS0FBSyxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRTdCLHdFQUF3RTtRQUN4RSxzRUFBc0U7UUFDdEUsTUFBTSxXQUFXLEdBQUcsQ0FBQyxZQUFvQixFQUFFLEVBQUUsQ0FDM0MsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxHQUFHLFlBQVksTUFBTSxFQUFFO1lBQzdDLFlBQVksRUFBRSxlQUFlLFlBQVksRUFBRTtZQUMzQyxTQUFTLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQyxRQUFRO1lBQ3RDLGFBQWEsRUFBRSwyQkFBYSxDQUFDLE9BQU87U0FDckMsQ0FBQyxDQUFDO1FBRUwsTUFBTSxRQUFRLEdBQUc7WUFDZixPQUFPLEVB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