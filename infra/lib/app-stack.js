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
exports.CamStreamAppStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const targets = __importStar(require("aws-cdk-lib/aws-route53-targets"));
const storage_1 = require("./storage");
const registry_1 = require("./registry");
const identity_1 = require("./identity");
const ingest_1 = require("./ingest");
const api_1 = require("./api");
const edge_1 = require("./edge");
const signing_1 = require("./signing");
const provisioning_1 = require("./provisioning");
class CamStreamAppStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const { config, hostedZone, certificate } = props;
        const storage = new storage_1.Storage(this, 'Storage', { config });
        const registry = new registry_1.Registry(this, 'Registry');
        const identity = new identity_1.Identity(this, 'Identity');
        const signing = new signing_1.Signing(this, 'Signing');
        const ingest = new ingest_1.Ingest(this, 'Ingest', { liveBucket: storage.liveBucket });
        // Fleet provisioning by claim: an installer carries a shared claim
        // certificate plus a per-agent one-time token, and the hook refuses
        // anything else.
        const provisioning = new provisioning_1.Provisioning(this, 'Provisioning', {
            registryTable: registry.table,
            devicePolicyName: 'camstream-device-policy',
            thingTypeName: 'camstream-agent',
        });
        const api = new api_1.Api(this, 'Api', {
            config,
            userPool: identity.userPool,
            userPoolClient: identity.userPoolClient,
            registryTable: registry.table,
            cloudFrontKeyPairId: signing.publicKey.publicKeyId,
            privateKeyParameterName: signing_1.PRIVATE_KEY_PARAMETER,
            liveBucketName: storage.liveBucket.bucketName,
            liveBucket: storage.liveBucket,
            agentVersion: this.node.tryGetContext('camstream:agentVersion') ?? '0.1.0',
            claimCertParameterName: provisioning_1.CLAIM_CERT_PARAMETER,
            provisioningTemplateName: provisioning.templateName,
        });
        // Agents sign heartbeats with SigV4 using their IoT-issued credentials.
        // The signature covers the Host header, so agents must call API Gateway
        // directly — CloudFront rewrites Host to the origin and would invalidate it.
        ingest.deviceRole.addToPrincipalPolicy(new iam.PolicyStatement({
            sid: 'InvokeHeartbeat',
            actions: ['execute-api:Invoke'],
            resources: [
                api.httpApi.arnForExecuteApi('POST', '/api/device/report'),
                api.httpApi.arnForExecuteApi('GET', '/api/device/config'),
            ],
        }));
        const edge = new edge_1.Edge(this, 'Edge', {
            config,
            liveBucket: storage.liveBucket,
            webBucket: storage.webBucket,
            apiOriginDomain: api.originDomain,
            keyGroup: signing.keyGroup,
            certificate,
        });
        const aliasTarget = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(edge.distribution));
        for (const name of [config.appDomain, ...config.altDomains]) {
            const suffix = name === config.appDomain ? 'Apex' : name.split('.')[0];
            new route53.ARecord(this, `AliasA${suffix}`, { zone: hostedZone, recordName: name, target: aliasTarget });
            new route53.AaaaRecord(this, `AliasAAAA${suffix}`, { zone: hostedZone, recordName: name, target: aliasTarget });
        }
        new aws_cdk_lib_1.CfnOutput(this, 'SiteUrl', { value: `https://${config.appDomain}` });
        new aws_cdk_lib_1.CfnOutput(this, 'DistributionDomain', { value: edge.distribution.distributionDomainName });
        new aws_cdk_lib_1.CfnOutput(this, 'DistributionId', { value: edge.distribution.distributionId });
        new aws_cdk_lib_1.CfnOutput(this, 'LiveBucket', { value: storage.liveBucket.bucketName });
        new aws_cdk_lib_1.CfnOutput(this, 'WebBucket', { value: storage.webBucket.bucketName });
        new aws_cdk_lib_1.CfnOutput(this, 'UserPoolId', { value: identity.userPool.userPoolId });
        new aws_cdk_lib_1.CfnOutput(this, 'UserPoolClientId', { value: identity.userPoolClient.userPoolClientId });
        new aws_cdk_lib_1.CfnOutput(this, 'RegistryTable', { value: registry.table.tableName });
        new aws_cdk_lib_1.CfnOutput(this, 'CloudFrontKeyPairId', { value: signing.publicKey.publicKeyId });
        new aws_cdk_lib_1.CfnOutput(this, 'IotRoleAlias', { value: 'camstream-device' });
        new aws_cdk_lib_1.CfnOutput(this, 'ProvisioningTemplate', { value: provisioning.templateName });
        new aws_cdk_lib_1.CfnOutput(this, 'ClaimPolicyName', { value: provisioning.claimPolicyName });
        new aws_cdk_lib_1.CfnOutput(this, 'ApiInvokeUrl', {
            description: 'Direct API Gateway URL — agents must use this, not the CloudFront domain',
            value: api.httpApi.apiEndpoint,
        });
    }
}
exports.CamStreamAppStack = CamStreamAppStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEyRDtBQUUzRCx5REFBMkM7QUFDM0MsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUczRCx1Q0FBb0M7QUFDcEMseUNBQXNDO0FBQ3RDLHlDQUFzQztBQUN0QyxxQ0FBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLGlDQUE4QjtBQUM5Qix1Q0FBMkQ7QUFDM0QsaURBQW9FO0FBUXBFLE1BQWEsaUJBQWtCLFNBQVEsbUJBQUs7SUFDMUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFvQjtRQUM1RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUN4QixNQUFNLEVBQUUsTUFBTSxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsR0FBRyxLQUFLLENBQUM7UUFFbEQsTUFBTSxPQUFPLEdBQUcsSUFBSSxpQkFBTyxDQUFDLElBQUksRUFBRSxTQUFTLEVBQUUsRUFBRSxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQ3pELE1BQU0sUUFBUSxHQUFHLElBQUksbUJBQVEsQ0FBQyxJQUFJLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDaEQsTUFBTSxRQUFRLEdBQUcsSUFBSSxtQkFBUSxDQUFDLElBQUksRUFBRSxVQUFVLENBQUMsQ0FBQztRQUNoRCxNQUFNLE9BQU8sR0FBRyxJQUFJLGlCQUFPLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBRTdDLE1BQU0sTUFBTSxHQUFHLElBQUksZUFBTSxDQUFDLElBQUksRUFBRSxRQUFRLEVBQUUsRUFBRSxVQUFVLEVBQUUsT0FBTyxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUM7UUFFOUUsbUVBQW1FO1FBQ25FLG9FQUFvRTtRQUNwRSxpQkFBaUI7UUFDakIsTUFBTSxZQUFZLEdBQUcs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