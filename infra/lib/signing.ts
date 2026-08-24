import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';
import * as fs from 'node:fs';
import * as path from 'node:path';

const KEYS_DIR = path.join(__dirname, '..', 'keys');
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'cloudfront-public.pem');

/** SSM SecureString holding the matching private key. Never enters the repo. */
export const PRIVATE_KEY_PARAMETER = '/camstream/cloudfront/private-key';

/**
 * The CloudFront trusted key group used to gate `/live/*`.
 *
 * The public half is committed; the private half is created and uploaded by
 * `scripts/bootstrap-keys.sh` before the first deploy.
 */
export class Signing extends Construct {
  public readonly publicKey: cloudfront.PublicKey;
  public readonly keyGroup: cloudfront.KeyGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    if (!fs.existsSync(PUBLIC_KEY_PATH)) {
      throw new Error(
        `Missing ${PUBLIC_KEY_PATH}. Run scripts/bootstrap-keys.sh before deploying.`,
      );
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
