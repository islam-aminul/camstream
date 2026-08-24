import { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Single-table registry of devices and the cameras they expose.
 *
 *   pk = TENANT#<tenantId>   sk = DEVICE#<thingName>            -> device record
 *   pk = TENANT#<tenantId>   sk = CAMERA#<thingName>#<cameraId> -> camera record
 *
 * On-demand billing so an idle deployment bills nothing. Camera and device
 * records carry a TTL refreshed by agent heartbeats, so a device that goes away
 * disappears from the viewer's camera list on its own.
 */
export class Registry extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: 'camstream-registry',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
