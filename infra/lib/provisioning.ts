import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'node:path';

const LAMBDA_DIR = path.join(__dirname, '..', 'lambda');

/**
 * SSM SecureString holding the shared claim certificate and its key.
 *
 * Created by scripts/bootstrap-claim-cert.sh, because CloudFormation cannot
 * issue an IoT certificate and capture the private key.
 */
export const CLAIM_CERT_PARAMETER = '/camstream/iot/claim-certificate';

export interface ProvisioningProps {
  readonly registryTable: dynamodb.Table;
  readonly devicePolicyName: string;
  readonly thingTypeName: string;
}

/**
 * Fleet provisioning by claim.
 *
 * An installer ships a shared claim certificate and a per-agent enrollment
 * token. The claim certificate can do exactly two things — ask for a
 * certificate, and call this template — and the template refuses unless the
 * hook accepts the token. On success the agent receives its own unique
 * certificate and discards the claim.
 */
export class Provisioning extends Construct {
  public readonly templateName = 'camstream-agent-provisioning';
  public readonly claimPolicyName = 'camstream-claim-policy';

  constructor(scope: Construct, id: string, props: ProvisioningProps) {
    super(scope, id);
    const stack = Stack.of(this);

    const hook = new NodejsFunction(this, 'HookFunction', {
      functionName: 'camstream-provisioning-hook',
      description: 'Validates and consumes an agent enrollment token',
      entry: path.join(LAMBDA_DIR, 'provisioning-hook', 'index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // IoT gives the hook 5 seconds; anything slower fails the registration.
      timeout: Duration.seconds(5),
      logGroup: new logs.LogGroup(this, 'HookLogs', {
        logGroupName: '/aws/lambda/camstream-provisioning-hook',
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: { REGISTRY_TABLE: props.registryTable.tableName },
      bundling: { format: OutputFormat.ESM, minify: true, target: 'node22', externalModules: ['@aws-sdk/*'] },
    });
    props.registryTable.grantReadWriteData(hook);
    hook.addPermission('IotInvoke', {
      principal: new iam.ServicePrincipal('iot.amazonaws.com'),
      sourceAccount: stack.account,
    });

    // What IoT itself may do while registering a device — deliberately only
    // the things this template needs.
    const provisioningRole = new iam.Role(this, 'ProvisioningRole', {
      roleName: 'camstream-fleet-provisioning-role',
      assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
      description: 'Used by AWS IoT to register CamStream agents from a claim certificate',
      inlinePolicies: {
        register: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'iot:RegisterThing',
                'iot:CreateThing',
                'iot:DescribeThing',
                'iot:UpdateThing',
                'iot:AddThingToThingGroup',
                'iot:DescribeCertificate',
                'iot:UpdateCertificate',
                'iot:AttachThingPrincipal',
                'iot:AttachPolicy',
                'iot:AttachPrincipalPolicy',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
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
