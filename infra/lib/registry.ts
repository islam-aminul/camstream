import { RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * Single-table registry of devices and the cameras they expose.
 *
 * The key layout lives in `lambda/shared/registry.ts`, which is where it is
 * enforced; restating it here only produced a second version to drift.
 *
 * On-demand billing so an idle deployment bills nothing. Health, live-camera
 * and demand records carry a TTL, so what a departed device leaves behind
 * expires on its own; premises, agents, approvals and credentials do not, and
 * are the reason for the recovery settings below.
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
      // This table is the estate: every premises, agent registration, camera
      // approval and credential envelope. Nothing else holds a copy — the
      // ciphertext here is the only stored form of a camera's password, since
      // the design deliberately keeps no key that could re-derive it. Losing
      // the table means re-entering every credential by hand, on site, which
      // is too expensive an outcome to leave one `cdk destroy` away.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
