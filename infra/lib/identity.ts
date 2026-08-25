import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

/**
 * Viewer identity. Sign-up is admin-only: CCTV access is granted, not
 * self-served. Every user carries a `custom:tenantId` claim, which is what the
 * session Lambda turns into a CloudFront cookie policy scoped to that tenant's
 * camera prefixes.
 */
export class Identity extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'camstream-viewers',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      customAttributes: {
        // Immutable: re-tenanting a user must be a deliberate re-create, not an
        // attribute edit that silently widens their camera access.
        tenantId: new cognito.StringAttribute({ minLen: 3, maxLen: 32, mutable: false }),
        // Comma-separated premises ids. Empty means every site in the tenant.
        // Mutable, because moving someone between sites is routine whereas
        // moving them between tenants should be a deliberate re-create.
        premises: new cognito.StringAttribute({ minLen: 0, maxLen: 512, mutable: true }),
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Roles are groups, not token attributes: a group can be revoked centrally
    // and takes effect on the next token refresh, whereas an attribute rides in
    // every unexpired token until it lapses.
    // Construct ids are pinned rather than derived from the role name: the
    // admin group already exists, and renaming its logical id would make
    // CloudFormation create a second group of the same name before deleting
    // the first, which collides and rolls the whole update back.
    const roles: { id: string; name: string; precedence: number; description: string }[] = [
      { id: 'SuperadminGroup', name: 'superadmin', precedence: 0,
        description: 'Platform operator — may act across every tenant' },
      { id: 'AdminGroup', name: 'admin', precedence: 1,
        description: 'Manages users, premises, agents and cameras in their tenant' },
      { id: 'OperatorGroup', name: 'operator', precedence: 2,
        description: 'Manages premises, agents and cameras; may set camera credentials' },
      { id: 'ViewerGroup', name: 'viewer', precedence: 3,
        description: 'Watches streams only' },
    ];
    for (const role of roles) {
      new cognito.CfnUserPoolGroup(this, role.id, {
        userPoolId: this.userPool.userPoolId,
        groupName: role.name,
        description: role.description,
        precedence: role.precedence,
      });
    }

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'camstream-web',
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });
  }
}
