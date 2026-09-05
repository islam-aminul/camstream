import { Construct } from 'constructs';
import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * The key that says a package is ours.
 *
 * An update instruction names a URL, and the agent's only check on it is that
 * it looks like an S3 URL over HTTPS — the shape of a URL, not evidence about
 * what is behind it. Signing the bundle answers the question the URL cannot:
 * whoever produced this held a key that only the release path holds.
 *
 * Asymmetric because the agent must verify without being able to sign. The
 * private half never leaves KMS, so there is no file to leak and no secret in
 * CI, and who may sign becomes an IAM question with a CloudTrail record behind
 * it. That permission is the real trust boundary — the key material is not
 * something anybody can copy, so the interesting question is who can ask it to
 * sign, and the answer should be the release pipeline and nothing else.
 *
 * P-256 rather than RSA: the signature is about seventy bytes instead of two
 * hundred and fifty, so it travels inside the existing MQTT instruction with
 * room to spare, and `java.security.Signature` verifies it with no dependency
 * added to the agent.
 *
 * Cost is a dollar a month for the key. Signing is $0.15 per ten thousand
 * requests and a release makes two, so the requests will not be noticed.
 * Verification costs nothing at all: the agent checks locally against a public
 * key baked into it, and `kms:Verify` is never called.
 *
 * See `docs/signing.md` for the rollout, which matters more than the key does.
 */
export class PackageSigning extends Construct {
  public readonly key: kms.Key;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.key = new kms.Key(this, 'ReleaseKey', {
      alias: 'camstream/release-signing',
      description: 'Signs CamStream agent update bundles. See docs/signing.md.',
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,

      /**
       * Retained on stack deletion, deliberately.
       *
       * Every agent in the field carries the matching public key compiled into
       * it. Destroying this one would leave a fleet that can verify and a
       * control plane that cannot sign — and no way to fix it remotely, because
       * fixing it requires an update those agents would refuse.
       *
       * KMS would in any case only schedule deletion, with a minimum seven-day
       * window, but the point is not to start the clock by accident.
       */
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The publisher needs this to sign; the agent never sees it, and needs
    // only the public half, which is committed into the repository.
    new CfnOutput(this, 'ReleaseSigningKeyId', { value: this.key.keyId });
    new CfnOutput(this, 'ReleaseSigningKeyArn', { value: this.key.keyArn });
  }
}
