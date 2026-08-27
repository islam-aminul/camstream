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
exports.Ingest = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const iot = __importStar(require("aws-cdk-lib/aws-iot"));
const constructs_1 = require("constructs");
/**
 * The edge trust anchor.
 *
 * An agent holds an X.509 certificate attached to an IoT thing. It exchanges
 * that certificate for short-lived AWS credentials through the IoT Credentials
 * Provider, then writes HLS parts straight to S3. There is no Lambda or API
 * Gateway on the per-segment path — at LL-HLS part rates that would dominate
 * both cost and latency.
 *
 * Isolation is enforced by `${credentials-iot:ThingName}` in the role policy:
 * a device can only ever write beneath its own prefix, and cannot read at all.
 */
class Ingest extends constructs_1.Construct {
    deviceRole;
    roleAlias;
    devicePolicy;
    constructor(scope, id, props) {
        super(scope, id);
        const { liveBucket } = props;
        const stack = aws_cdk_lib_1.Stack.of(this);
        this.deviceRole = new iam.Role(this, 'DeviceRole', {
            roleName: 'camstream-device-role',
            assumedBy: new iam.ServicePrincipal('credentials.iot.amazonaws.com'),
            description: 'Assumed by CamStream edge agents via the IoT Credentials Provider',
            inlinePolicies: {
                'segment-write': new iam.PolicyDocument({
                    statements: [
                        new iam.PolicyStatement({
                            sid: 'WriteOwnSegmentsOnly',
                            actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
                            resources: [
                                liveBucket.arnForObjects('live/${credentials-iot:ThingName}/*'),
                            ],
                        }),
                        // Lets an agent clean up its own stale manifests on restart.
                        new iam.PolicyStatement({
                            sid: 'DeleteOwnSegmentsOnly',
                            actions: ['s3:DeleteObject'],
                            resources: [
                                liveBucket.arnForObjects('live/${credentials-iot:ThingName}/*'),
                            ],
                        }),
                    ],
                }),
            },
        });
        this.roleAlias = new iot.CfnRoleAlias(this, 'RoleAlias', {
            roleAlias: 'camstream-device',
            roleArn: this.deviceRole.roleArn,
            credentialDurationSeconds: 3600,
        });
        this.devicePolicy = new iot.CfnPolicy(this, 'DevicePolicy', {
            policyName: 'camstream-device-policy',
            policyDocument: {
                Version: '2012-10-17',
                Statement: [
                    {
                        // Only the certificate's own thing may be assumed — prevents a
                        // leaked cert from impersonating another site's device.
                        Sid: 'AssumeRoleForOwnThing',
                        Effect: 'Allow',
                        Action: 'iot:AssumeRoleWithCertificate',
                        Resource: stack.formatArn({
                            service: 'iot',
                            resource: 'rolealias',
                            resourceName: 'camstream-device',
                        }),
                    },
                    {
                        // The agent idles with no ffmpeg running; this subscription is how
                        // it learns that a viewer has opened the grid.
                        Sid: 'ConnectAsOwnThing',
                        Effect: 'Allow',
                        Action: 'iot:Connect',
                        Resource: stack.formatArn({
                            service: 'iot',
                            resource: 'client',
                            resourceName: '${iot:Connection.Thing.ThingName}',
                        }),
                    },
                    {
                        // watch  — which renditions to publish
                        // config — a version number telling the agent to re-fetch its
                        //          configuration; the payload itself is fetched over HTTPS
                        //          because credentials and assignments outgrow an MQTT
                        //          message on a large site
                        // command — one-off instructions such as "scan now"
                        Sid: 'SubscribeOwnTopics',
                        Effect: 'Allow',
                        Action: 'iot:Subscribe',
                        Resource: [
                            stack.formatArn({
                                service: 'iot',
                                resource: 'topicfilter',
                                resourceName: 'camstream/${iot:Connection.Thing.ThingName}/watch',
                            }),
                            stack.formatArn({
                                service: 'iot',
                                resource: 'topicfilter',
                                resourceName: 'camstream/${iot:Connection.Thing.ThingName}/config',
                            }),
                            stack.formatArn({
                                service: 'iot',
                                resource: 'topicfilter',
                                resourceName: 'camstream/${iot:Connection.Thing.ThingName}/command',
                            }),
                        ],
                    },
                    {
                        Sid: 'ReceiveOwnTopics',
                        Effect: 'Allow',
                        Action: 'iot:Receive',
                        Resource: [
                            stack.formatArn({
                                service: 'iot',
                                resource: 'topic',
                                resourceName: 'camstream/${iot:Connection.Thing.ThingName}/watch',
                            }),
                            stack.formatArn({
                                service: 'iot',
                                resource: 'topic',
                                resourceName: 'camstream/${iot:Connection.Thing.ThingName}/config',
                            }),
                            stack.formatArn({
                                service: 'iot',
                                resource: 'topic',
                                resourceName: 'camstream/${iot:Connection.Thing.ThingName}/command',
                            }),
                        ],
                    },
                    {
                        // The agent's only outbound topic, and it may publish under its own
                        // thing name and nowhere else. That restriction is what makes the
                        // heartbeat rule's SQL safe: it derives the tenant and device from
                        // the topic, which IoT has authenticated against the certificate,
                        // rather than from the payload, which the agent could say anything
                        // in. A compromised agent can therefore lie about its own health
                        // and nothing else — it cannot write a health record over another
                        // tenant's.
                        Sid: 'PublishOwnHealth',
                        Effect: 'Allow',
                        Action: 'iot:Publish',
                        Resource: stack.formatArn({
                            service: 'iot',
                            resource: 'topic',
                            resourceName: 'camstream/${iot:Connection.Thing.ThingName}/heartbeat',
                        }),
                    },
                ],
            },
        });
        new iot.CfnThingType(this, 'ThingType', {
            thingTypeName: 'camstream-agent',
            thingTypeProperties: {
                thingTypeDescription: 'On-premises CamStream ingestion agent',
                searchableAttributes: ['tenantId', 'siteName', 'agentVersion'],
            },
        });
    }
}
exports.Ingest = Ingest;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5nZXN0LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiaW5nZXN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUFvQztBQUNwQyx5REFBMkM7QUFDM0MseURBQTJDO0FBRTNDLDJDQUF1QztBQU12Qzs7Ozs7Ozs7Ozs7R0FXRztBQUNILE1BQWEsTUFBTyxTQUFRLHNCQUFTO0lBQ25CLFVBQVUsQ0FBVztJQUNyQixTQUFTLENBQW1CO0lBQzVCLFlBQVksQ0FBZ0I7SUFFNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFrQjtRQUMxRCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ2pCLE1BQU0sRUFBRSxVQUFVLEVBQUUsR0FBRyxLQUFLLENBQUM7UUFDN0IsTUFBTSxLQUFLLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUM7UUFFN0IsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUNqRCxRQUFRLEVBQUUsdUJBQXVCO1lBQ2pDLFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQywrQkFBK0IsQ0FBQztZQUNwRSxXQUFXLEVBQUUsbUVBQW1FO1lBQ2hGLGNBQWMsRUFBRTtnQkFDZCxlQUFlLEVBQUUsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDO29CQUN0QyxVQUFVLEVBQUU7d0JBQ1YsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDOzRCQUN0QixHQUFHLEVBQUUsc0JBQXNCOzRCQUMzQixPQUFPLEVBQUUsQ0FBQyxjQUFjLEVBQUUseUJBQXlCLENBQUM7NEJBQ3BELFNBQVMsRUFBRTtnQ0FDVCxVQUFVLENBQUMsYUFBYSxDQUFDLHFDQUFxQyxDQUFDOzZCQUNoRTt5QkFDRixDQUFDO3dCQUNGLDZEQUE2RDt3QkFDN0QsSUFBSSxH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