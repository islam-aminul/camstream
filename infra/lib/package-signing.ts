import { Construct } from 'constructs';
import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';

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

  /**
   * Says so, every time this key signs anything.
   *
   * Since agent 0.1.7 an unsigned package is refused outright, which is what
   * the signing was for - and it means `kms:Sign` on this key is now the whole
   * of the answer to "who decides what runs on the fleet". The key material
   * cannot be copied, so the only interesting question is who asked it to sign,
   * and nothing was watching that.
   *
   * Notification rather than a threshold alarm, deliberately. There is no
   * suspicious *rate* of signing to detect: a release signs two bundles and
   * then nothing happens for days, so any threshold high enough to be quiet
   * would also be high enough to miss a single hostile signature - which is
   * all it would take. Every use is worth one message, and every use is
   * expected to be one somebody in this repository just caused.
   *
   * EventBridge on the default bus, so no CloudTrail trail is needed: KMS logs
   * its cryptographic operations as management events, which are delivered
   * there without one. A trail would mean an S3 bucket, a log group and a
   * standing cost, for the same information.
   */
  public notifyOnUse(topic: sns.ITopic): void {
    new events.Rule(this, 'SigningUse', {
      description: 'A release bundle was signed with the CamStream release key',
      eventPattern: {
        source: ['aws.kms'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['kms.amazonaws.com'],
          // Sign only. Verify is not interesting - the agents do that
          // locally against the compiled-in public key and never call KMS -
          // and GetPublicKey is how the key gets into a build in the first
          // place, which is a read of something already public.
          eventName: ['Sign'],
          // Scoped to this key. Other keys in the account are symmetric and
          // cannot be signed with at all, so this is belt and braces - but an
          // unscoped rule would start paging about somebody else's key the
          // day one is added.
          resources: { ARN: [this.key.keyArn] },
        },
      },
      targets: [
        new targets.SnsTopic(topic, {
          // Who and when, in the notification itself. An alert that only says
          // "the key was used" sends somebody to CloudTrail to find out the
          // one thing they actually wanted to know.
          message: events.RuleTargetInput.fromText(
            `The CamStream release signing key was used to sign a package.

  who:   ${events.EventField.fromPath('$.detail.userIdentity.arn')}
  when:  ${events.EventField.fromPath('$.detail.eventTime')}
  from:  ${events.EventField.fromPath('$.detail.sourceIPAddress')}
  agent: ${events.EventField.fromPath('$.detail.userAgent')}

If this was not a release somebody just cut, treat it as a compromise of the
fleet's update path: an agent installs any bundle this key has signed.`,
          ),
        }),
      ],
    });
  }
}
