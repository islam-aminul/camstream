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
exports.Signing = exports.PRIVATE_KEY_PARAMETER = void 0;
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const constructs_1 = require("constructs");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const KEYS_DIR = path.join(__dirname, '..', 'keys');
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'cloudfront-public.pem');
/** SSM SecureString holding the matching private key. Never enters the repo. */
exports.PRIVATE_KEY_PARAMETER = '/camstream/cloudfront/private-key';
/**
 * The CloudFront trusted key group used to gate `/live/*`.
 *
 * The public half is committed; the private half is created and uploaded by
 * `scripts/bootstrap-keys.sh` before the first deploy.
 */
class Signing extends constructs_1.Construct {
    publicKey;
    keyGroup;
    constructor(scope, id) {
        super(scope, id);
        if (!fs.existsSync(PUBLIC_KEY_PATH)) {
            throw new Error(`Missing ${PUBLIC_KEY_PATH}. Run scripts/bootstrap-keys.sh before deploying.`);
        }
        const encodedKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8').trim();
        this.publicKey = new cloudfront.PublicKey(this, 'ViewerKey', {
            encodedKey,
            comment: 'CamStream viewer cookie-signing key',
        });
        this.keyGroup = new cloudfront.KeyGroup(this, 'ViewerKeyGroup', {
            items: [this.publicKey],
            comment: 'CamStream viewers',
        });
    }
}
exports.Signing = Signing;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2lnbmluZy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNpZ25pbmcudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsdUVBQXlEO0FBQ3pELDJDQUF1QztBQUN2Qyw0Q0FBOEI7QUFDOUIsZ0RBQWtDO0FBRWxDLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLElBQUksRUFBRSxNQUFNLENBQUMsQ0FBQztBQUNwRCxNQUFNLGVBQWUsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSx1QkFBdUIsQ0FBQyxDQUFDO0FBRXJFLGdGQUFnRjtBQUNuRSxRQUFBLHFCQUFxQixHQUFHLG1DQUFtQyxDQUFDO0FBRXpFOzs7OztHQUtHO0FBQ0gsTUFBYSxPQUFRLFNBQVEsc0JBQVM7SUFDcEIsU0FBUyxDQUF1QjtJQUNoQyxRQUFRLENBQXNCO0lBRTlDLFlBQVksS0FBZ0IsRUFBRSxFQUFVO1FBQ3RDLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsSUFBSSxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsZUFBZSxDQUFDLEVBQUUsQ0FBQztZQUNwQyxNQUFNLElBQUksS0FBSyxDQUNiLFdBQVcsZUFBZSxtREFBbUQsQ0FDOUUsQ0FBQztRQUNKLENBQUM7UUFDRCxNQUFNLFVBQVUsR0FBRyxFQUFFLENBQUMsWUFBWSxDQUFDLGVBQWUsRUFBRSxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUVuRSxJQUFJLENBQUMsU0FBUyxHQUFHLElBQUksVUFBVSxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsV0FBVyxFQUFFO1lBQzNELFVBQVU7WUFDVixPQUFPLEVBQUUscUNBQXFDO1NBQy9DLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxVQUFVLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUM5RCxLQUFLLEVBQUUsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDO1lBQ3ZCLE9BQU8sRUFBRSxtQkFBbUI7U0FDN0IsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBeEJELDBCQXdCQyJ9