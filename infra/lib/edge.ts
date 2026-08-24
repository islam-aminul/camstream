import { Duration } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CamStreamConfig } from './config';
import { SpaRouter } from './spa-router';

export interface EdgeProps {
  readonly config: CamStreamConfig;
  readonly liveBucket: s3.Bucket;
  readonly webBucket: s3.Bucket;
  readonly apiOriginDomain: string;
  readonly keyGroup: cloudfront.IKeyGroup;
  readonly certificate: acm.ICertificate;
}

/**
 * One distribution serves the player, the control API and the media, so that
 * everything is same-origin: CloudFront cookies need no Domain attribute and
 * the player needs no CORS preflights on the segment path.
 */
export class Edge extends Construct {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);
    const { config, liveBucket, webBucket, keyGroup, certificate } = props;

    const liveOrigin = origins.S3BucketOrigin.withOriginAccessControl(liveBucket);
    const webOrigin = origins.S3BucketOrigin.withOriginAccessControl(webBucket);
    const apiOrigin = new origins.HttpOrigin(props.apiOriginDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: Duration.seconds(30),
    });

    // Manifests are rewritten every part interval. Anything beyond a ~1s
    // collapse window shows up directly as viewer latency.
    const manifestCachePolicy = new cloudfront.CachePolicy(this, 'ManifestCachePolicy', {
      cachePolicyName: 'camstream-manifest',
      comment: 'LL-HLS manifests — collapse concurrent viewers, never stale by more than 1s',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('_HLS_msn', '_HLS_part'),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Segment and part filenames are unique for the life of the stream, so they
    // can be cached hard; the S3 lifecycle rule is what bounds their lifetime.
    const segmentCachePolicy = new cloudfront.CachePolicy(this, 'SegmentCachePolicy', {
      cachePolicyName: 'camstream-segment',
      comment: 'Immutable LL-HLS media parts',
      minTtl: Duration.seconds(1),
      defaultTtl: Duration.hours(6),
      maxTtl: Duration.days(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: false,
      enableAcceptEncodingBrotli: false,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: 'camstream-security-headers',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
          override: true,
        },
      },
    });

    const signedMedia = {
      origin: liveOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      trustedKeyGroups: [keyGroup],
      responseHeadersPolicy: securityHeaders,
    };

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'CamStream',
      domainNames: [config.appDomain, ...config.altDomains],
      certificate,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      // The viewers are the operators of these cameras, not a global audience.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultRootObject: 'index.html',

      defaultBehavior: {
        origin: webOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
        functionAssociations: [
          {
            function: new SpaRouter(this, 'SpaRouter').function,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },

      // Insertion order is precedence order — the manifest pattern must be
      // evaluated before the catch-all media pattern.
      additionalBehaviors: {
        '/live/*.m3u8': { ...signedMedia, cachePolicy: manifestCachePolicy, compress: true },
        '/live/*': { ...signedMedia, cachePolicy: segmentCachePolicy, compress: false },
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forwards Authorization; must exclude Host so API Gateway still
          // recognises its own hostname.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
      },
    });
  }
}
