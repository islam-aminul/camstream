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
exports.Provisioning = exports.CLAIM_CERT_PARAMETER = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const iot = __importStar(require("aws-cdk-lib/aws-iot"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const aws_lambda_nodejs_1 = require("aws-cdk-lib/aws-lambda-nodejs");
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const constructs_1 = require("constructs");
const path = __importStar(require("node:path"));
const LAMBDA_DIR = path.join(__dirname, '..', 'lambda');
/**
 * SSM SecureString holding the shared claim certificate and its key.
 *
 * Created by scripts/bootstrap-claim-cert.sh, because CloudFormation cannot
 * issue an IoT certificate and capture the private key.
 */
exports.CLAIM_CERT_PARAMETER = '/camstream/iot/claim-certificate';
/**
 * Fleet provisioning by claim.
 *
 * An installer ships a shared claim certificate and a per-agent enrollment
 * token. The claim certificate can do exactly two things — ask for a
 * certificate, and call this template — and the template refuses unless the
 * hook accepts the token. On success the agent receives its own unique
 * certificate and discards the claim.
 */
class Provisioning extends constructs_1.Construct {
    templateName = 'camstream-agent-provisioning';
    claimPolicyName = 'camstream-claim-policy';
    constructor(scope, id, props) {
        super(scope, id);
        const stack = aws_cdk_lib_1.Stack.of(this);
        const hook = new aws_lambda_nodejs_1.NodejsFunction(this, 'HookFunction', {
            functionName: 'camstream-provisioning-hook',
            description: 'Validates and consumes an agent enrollment token',
            entry: path.join(LAMBDA_DIR, 'provisioning-hook', 'index.ts'),
            runtime: lambda.Runtime.NODEJS_22_X,
            architecture: lambda.Architecture.ARM_64,
            memorySize: 256,
            // IoT gives the hook 5 seconds; anything slower fails the registration.
            timeout: aws_cdk_lib_1.Duration.seconds(5),
            logGroup: new logs.LogGroup(this, 'HookLogs', {
                logGroupName: '/aws/lambda/camstream-provisioning-hook',
                retention: logs.RetentionDays.ONE_MONTH,
                removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
            }),
            environment: { REGISTRY_TABLE: props.registryTable.tableName },
            bundling: { format: aws_lambda_nodejs_1.OutputFormat.ESM, minify: true, target: 'node22', externalModules: ['@aws-sdk/*'] },
        });
        props.registryTable.grantReadWriteData(hook);
        hook.addPermission('IotInvoke', {
            principal: new iam.ServicePrincipal('iot.amazonaws.com'),
            sourceAccount: stack.account,
        });
        // AWS publishes a managed policy for precisely this role. RegisterThing
        // touches around two dozen IoT actions — including several, like
        // ListThingGroupsForThing, that are not obvious from the template body —
        // and a hand-written list fails at registration time rather than at deploy.
        const provisioningRole = new iam.Role(this, 'ProvisioningRole', {
            roleName: 'camstream-fleet-provisioning-role',
            assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
            description: 'Used by AWS IoT to register CamStream agents from a claim certificate',
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSIoTThingsRegistration'),
            ],
        });
        new iot.CfnProvisioningTemplate(this, 'Template', {
            templateName: this.templateName,
            description: 'Registers a CamStream agent and issues it a unique certificate',
            enabled: true,
            provisioningRoleArn: provisioningRole.roleArn,
            preProvisioningHook: { targetArn: hook.functionArn, payloadVersion: '2020-04-01' },
            templateBody: JSON.stringify({
                Parameters: {
                    ThingName: { Type: 'String' },
                    TenantId: { Type: 'String' },
                    PremisesId: { Type: 'String' },
                    EnrollmentToken: { Type: 'String' },
                    'AWS::IoT::Certificate::Id': { Type: 'String' },
                },
                Resources: {
                    certificate: {
                        Type: 'AWS::IoT::Certificate',
                        Properties: { CertificateId: { Ref: 'AWS::IoT::Certificate::Id' }, Status: 'Active' },
                    },
                    policy: {
                        Type: 'AWS::IoT::Policy',
                        Properties: { PolicyName: props.devicePolicyName },
                    },
                    thing: {
                        Type: 'AWS::IoT::Thing',
                        OverrideSettings: { AttributePayload: 'MERGE', ThingTypeName: 'REPLACE' },
                        Properties: {
                            ThingName: { Ref: 'ThingName' },
                            ThingTypeName: props.thingTypeName,
                            AttributePayload: { tenantId: { Ref: 'TenantId' }, premisesId: { Ref: 'PremisesId' } },
                        },
                    },
                },
            }),
        });
        // The claim certificate's entire world: request a certificate, and run the
        // template. It cannot connect as a thing, publish, subscribe or assume the
        // credentials role, so on its own it is worth nothing.
        new iot.CfnPolicy(this, 'ClaimPolicy', {
            policyName: this.claimPolicyName,
            policyDocument: {
                Version: '2012-10-17',
                Statement: [
                    {
                        Effect: 'Allow',
                        Action: 'iot:Connect',
                        Resource: stack.formatArn({ service: 'iot', resource: 'client', resourceName: '*' }),
                    },
                    {
                        Effect: 'Allow',
                        Action: ['iot:Publish', 'iot:Receive'],
                        Resource: [
                            stack.formatArn({ service: 'iot', resource: 'topic', resourceName: '$aws/certificates/create/*' }),
                            stack.formatArn({
                                service: 'iot',
                                resource: 'topic',
                                resourceName: `$aws/provisioning-templates/${this.templateName}/provision/*`,
                            }),
                        ],
                    },
                    {
                        Effect: 'Allow',
                        Action: 'iot:Subscribe',
                        Resource: [
                            stack.formatArn({ service: 'iot', resource: 'topicfilter', resourceName: '$aws/certificates/create/*' }),
                            stack.formatArn({
                                service: 'iot',
                                resource: 'topicfilter',
                                resourceName: `$aws/provisioning-templates/${this.templateName}/provision/*`,
                            }),
                        ],
                    },
                ],
            },
        });
    }
}
exports.Provisioning = Provisioning;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJvdmlzaW9uaW5nLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHJvdmlzaW9uaW5nLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE2RDtBQUU3RCx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLCtEQUFpRDtBQUNqRCxxRUFBNkU7QUFDN0UsMkRBQTZDO0FBQzdDLDJDQUF1QztBQUN2QyxnREFBa0M7QUFFbEMsTUFBTSxVQUFVLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBRXhEOzs7OztHQUtHO0FBQ1UsUUFBQSxvQkFBb0IsR0FBRyxrQ0FBa0MsQ0FBQztBQVF2RTs7Ozs7Ozs7R0FRRztBQUNILE1BQWEsWUFBYSxTQUFRLHNCQUFTO0lBQ3pCLFlBQVksR0FBRyw4QkFBOEIsQ0FBQztJQUM5QyxlQUFlLEdBQUcsd0JBQXdCLENBQUM7SUFFM0QsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUF3QjtRQUNoRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ2pCLE1BQU0sS0FBSyxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRTdCLE1BQU0sSUFBSSxHQUFHLElBQUksa0NBQWMsQ0FBQyxJQUFJLEVBQUUsY0FBYyxFQUFFO1lBQ3BELFlBQVksRUFBRSw2QkFBNkI7WUFDM0MsV0FBVyxFQUFFLGtEQUFrRDtZQUMvRCxLQUFLLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsbUJBQW1CLEVBQUUsVUFBVSxDQUFDO1lBQzdELE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsWUFBWSxFQUFFLE1BQU0sQ0FBQyxZQUFZLENBQUMsTUFBTTtZQUN4QyxVQUFVLEVBQUUsR0FBRztZQUNmLHdFQUF3RTtZQUN4RSxP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