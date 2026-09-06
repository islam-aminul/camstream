import { Construct } from 'constructs';
import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Duration } from 'aws-cdk-lib';

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
   * the signing was for — and it means `kms:Sign` on this key is now the whole
   * of the answer to "who decides what runs on the fleet". The key material
   * cannot be copied, so the only interesting question is who asked it to sign,
   * and nothing was watching that.
   *
   * A trail into CloudWatch Logs, and not EventBridge, which was tried first
   * and does not work. `kms:Sign` is a management event — it appears in
   * CloudTrail with the key's ARN in `resources` — but it is flagged
   * `readOnly: true`, and EventBridge does not deliver read-only management
   * events. The rule was deployed, the key was signed with, and thirty minutes
   * later `TriggeredRules` had no data points at all. An alarm that cannot
   * fire is worse than no alarm, because somebody believes they have one.
   *
   * A metric filter on the log group sees everything the trail writes,
   * read-only included.
   *
   * Cost: the first copy of management events in a region is free, so this is
   * the S3 storage for a very low-volume trail plus a small log group with a
   * short retention. The events are kept a fortnight here because this is an
   * alerting path — the trail's own S3 copy is the record.
   */
  public notifyOnUse(topic: sns.ITopic): void {
    const trailLogs = new logs.LogGroup(this, 'SigningTrailLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Management events only, and no data events: this exists to watch one
    // key, not to audit the account. Data events are the expensive ones.
    new cloudtrail.Trail(this, 'SigningTrail', {
      cloudWatchLogGroup: trailLogs,
      sendToCloudWatchLogs: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      includeGlobalServiceEvents: false,
      isMultiRegionTrail: false,
    });

    // Anchored on this key's ARN as well as the event name, so another
    // asymmetric key added later cannot quietly start paging this topic.
    // Not 'SigningUse': that id belonged to the EventBridge rule this
    // replaces, and CloudFormation refuses to change a resource's type under
    // an existing logical id. Reusing it fails the deploy rather than the
    // synth, which is a slower way to find out.
    const signings = new logs.MetricFilter(this, 'SigningUseFilter', {
      logGroup: trailLogs,
      metricNamespace: 'CamStream',
      metricName: 'ReleaseKeySignings',
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.eventName', '=', 'Sign'),
        logs.FilterPattern.stringValue('$.eventSource', '=', 'kms.amazonaws.com'),
        logs.FilterPattern.stringValue('$.resources[0].ARN', '=', this.key.keyArn),
      ),
      metricValue: '1',
      // Absent means nothing signed, which is the ordinary state. Without
      // this the alarm sits in INSUFFICIENT_DATA between releases and gets
      // muted by whoever is tired of looking at it.
      defaultValue: 0,
    });

    new cloudwatch.Alarm(this, 'ReleaseKeyUsed', {
      alarmDescription:
        'The CamStream release signing key signed a package. An agent installs '
        + 'any bundle this key has signed, so if this was not a release somebody '
        + 'just cut, treat it as a compromise of the fleet update path.',
      metric: signings.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      // One signature is the whole event. There is no suspicious *rate* to
      // detect: a release signs two bundles and then nothing for days, so any
      // threshold quiet enough to live with would miss the single signature
      // that matters.
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cloudwatchActions.SnsAction(topic));
  }
}
