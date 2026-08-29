import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CamStreamConfig } from './config';

export interface StorageProps {
  readonly config: CamStreamConfig;
}

/**
 * Two buckets, both private and reached only through CloudFront OAC.
 *
 * `live` holds LL-HLS output written directly by edge agents under
 * `live/<thingName>/<cameraId>/`. Nothing in it is durable — the lifecycle rule
 * is what keeps this architecture's storage bill at effectively zero.
 */
export class Storage extends Construct {
  public readonly liveBucket: s3.Bucket;
  public readonly webBucket: s3.Bucket;
  public readonly accessLogBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);
    const { config } = props;

    // Server access logs for both buckets. Nothing recorded who read a segment
    // or a page, which is the other half of the question a CCTV customer
    // eventually asks — CloudFront says who asked for it, this says what was
    // actually served. Expired on a schedule so an audit trail does not become
    // a storage bill.
    this.accessLogBucket = new s3.Bucket(this, 'AccessLogs', {
      bucketName: `camstream-access-logs-${config.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ id: 'expire-access-logs', enabled: true, expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.liveBucket = new s3.Bucket(this, 'LiveBucket', {
      bucketName: `camstream-live-${config.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix: 'live/',
      lifecycleRules: [
        {
          id: 'expire-live-segments',
          prefix: 'live/',
          enabled: true,
          expiration: Duration.days(config.segmentTtlDays),
          // Agents upload parts continuously; a crashed agent must not leave
          // billable multipart fragments behind.
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    this.webBucket = new s3.Bucket(this, 'WebBucket', {
      bucketName: `camstream-web-${config.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      serverAccessLogsBucket: this.accessLogBucket,
      serverAccessLogsPrefix: 'web/',
    });
  }
}
