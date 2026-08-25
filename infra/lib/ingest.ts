import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface IngestProps {
  readonly liveBucket: s3.Bucket;
}

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
export class Ingest extends Construct {
  public readonly deviceRole: iam.Role;
  public readonly roleAlias: iot.CfnRoleAlias;
  public readonly devicePolicy: iot.CfnPolicy;

  constructor(scope: Construct, id: string, props: IngestProps) {
    super(scope, id);
    const { liveBucket } = props;
    const stack = Stack.of(this);

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
