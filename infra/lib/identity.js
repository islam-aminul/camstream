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
exports.Identity = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const constructs_1 = require("constructs");
/**
 * Viewer identity. Sign-up is admin-only: CCTV access is granted, not
 * self-served. Every user carries a `custom:tenantId` claim, which is what the
 * session Lambda turns into a CloudFront cookie policy scoped to that tenant's
 * camera prefixes.
 */
class Identity extends constructs_1.Construct {
    userPool;
    userPoolClient;
    constructor(scope, id) {
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
            removalPolicy: aws_cdk_lib_1.RemovalPolicy.DESTROY,
        });
        // Roles are groups, not token attributes: a group can be revoked centrally
        // and takes effect on the next token refresh, whereas an attribute rides in
        // every unexpired token until it lapses.
        // Construct ids are pinned rather than derived from the role name: the
        // admin group already exists, and renaming its logical id would make
        // CloudFormation create a second group of the same name before deleting
        // the first, which collides and rolls the whole update back.
        const roles = [
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
            accessTokenValidity: aws_cdk_lib_1.Duration.hours(1),
            idTokenValidity: aws_cdk_lib_1.Duration.hours(1),
            refreshTokenValidity: aws_cdk_lib_1.Duration.days(30),
            enableTokenRevocation: true,
        });
    }
}
exports.Identity = Identity;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaWRlbnRpdHkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpZGVudGl0eS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBc0Q7QUFDdEQsaUVBQW1EO0FBQ25ELDJDQUF1QztBQUV2Qzs7Ozs7R0FLRztBQUNILE1BQWEsUUFBUyxTQUFRLHNCQUFTO0lBQ3JCLFFBQVEsQ0FBbUI7SUFDM0IsY0FBYyxDQUF5QjtJQUV2RCxZQUFZLEtBQWdCLEVBQUUsRUFBVTtRQUN0QyxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxPQUFPLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDckQsWUFBWSxFQUFFLG1CQUFtQjtZQUNqQyxpQkFBaUIsRUFBRSxLQUFLO1lBQ3hCLGFBQWEsRUFBRSxFQUFFLEtBQUssRUFBRSxJQUFJLEVBQUU7WUFDOUIsbUJBQW1CLEVBQUUsS0FBSztZQUMxQixrQkFBa0IsRUFBRTtnQkFDbEIsS0FBSyxFQUFFLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFO2FBQzFDO1lBQ0QsZ0JBQWdCLEVBQUU7Z0JBQ2hCLHdFQUF3RTtnQkFDeEUsMkRBQTJEO2dCQUMzRCxRQUFRLEVBQUUsSUFBSSxPQUFPLENBQUMsZUFBZSxDQUFDLEVBQUUsTUFBTSxFQUFFLENBQUMsRUFBRSxNQUFNLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsQ0FBQztnQkFDaEYsc0VBQXNFO2dCQUN0RSxtRUFBbUU7Z0JBQ25FLGdFQUFnRTtnQkFDaEUsUUFBUSxFQUFFLElBQUksT0FBTyxDQUFDLGVBQWUsQ0FBQyxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsTUFBTSxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUM7YUFDakY7WUFDRCxjQUFjLEVBQUU7Z0JBQ2QsU0FBUyxFQUFFLEVBQUU7Z0JBQ2IsZ0JBQWdCLEVBQUUsSUFBSTtnQkFDdEIsZ0JBQWdCLEVBQUUsSUFBSTtnQkFDdEIsYUFBYSxFQUFFLElBQUk7Z0JBQ25CLGNBQWMsRUFBRSxLQUFLO2FBQ3RCO1lBQ0QsZUFBZSxFQUFFLE9BQU8sQ0FBQyxlQUFlLENBQUMsVUFBVTtZQUNuRCxhQUFhLEVBQUUsMkJBQWEsQ0FBQyxPQUFPO1NBQ3JDLENBQUMsQ0FBQztRQUVILDJFQUEyRTtRQUMzRSw0RUFBNEU7UUFDNUUseUNBQXlDO1FBQ3pDLHVFQUF1RTtRQUN2RSxxRUFBcUU7UUFDckUsd0VBQXdFO1FBQ3hFLDZEQUE2RDtRQUM3RCxNQUFNLEtBQUssR0FBNEU7WUFDckYsRUFBRSxFQUFFLEVBQUUsaUJBQWlCLEVBQUUsSUFBSSxFQUFFLFlBQVksRUFBRSxVQUFVLEVBQUUsQ0FBQztnQkFDeEQsV0FBVyxFQUFFLGlEQUFpRCxFQUFFO1lBQ2xFLEVBQUUsRUFBRSxFQUFFLFlBQVksRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxDQUFDO2dCQUM5QyxXQUFXLEVBQUUsNkRBQTZELEVBQUU7WUFDOUUsRUFBRSxFQUFFLEVBQUUsZUFBZSxFQUFFLElBQUksRUFBRSxVQUFVLEVBQUUsVUFBVSxFQUFFLENBQUM7Z0JBQ3BELFdBQVcsRUFBRSxrRUFBa0UsRUFBRTtZQUNuRixFQUFFLEVBQUUsRUFBRSxhQUFhLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxVQUFVLEVBQUUsQ0FBQztnQkFDaEQsV0FBVyxFQUFFLHNCQUFzQixFQUFFO1NBQ3hDLENBQUM7UUFDRixLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3pCLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsRUFBRSxFQUFFO2dCQUMxQyxVQUFVLEVBQUUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxVQUFVO2dCQUNwQyxTQUFTLEVBQUUsSUFBSSxDQUFDLElBQUk7Z0JBQ3BCLFdBQVcsRUFBRSxJQUFJLENBQUMsV0FBVztnQkFDN0IsVUFBVSxFQUFFLElBQUksQ0FBQyxVQUFVO2FBQzVCLENBQUMsQ0FBQztRQUNMLENBQUM7UUFFRCxJQUFJLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLFdBQVcsRUFBRTtZQUN6RCxrQkFBa0IsRUFBRSxlQUFlO1lBQ25DLGNBQWMsRUFBRSxLQUFLO1lBQ3JCLFNBQVMsRUFBRSxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUU7WUFDNUIsMEJBQTBCLEVBQUUsSUFBSTtZQUNoQyxtQkFBbUIsRUFBRSxzQkFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7WUFDdEMsZUFBZSxFQUFFLHNCQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztZQUNsQyxvQkFBb0IsRUFBRSxzQkFBUSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDdkMscUJBQXFCLEVBQUUsSUFBSTtTQUM1QixDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUF4RUQsNEJBd0VDIn0=