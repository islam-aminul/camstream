import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CamStreamConfig } from './config';
import { SpaRouter } from './spa-router';
import { HostForwarder } from './host-forwarder';

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
  /** Where access logs land, so other constructs can write beside them. */
  public readonly logBucket: s3.Bucket;

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
        // The player is a same-origin SPA with no third-party scripts, so a
        // strict policy costs nothing — and it is the control that would
        // actually contain an XSS in the admin console, which is the one page
        // that holds decrypted credential plaintext in memory before sealing
        // it. blob: is for hls.js, which appends segments through MSE.
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            // hls.js builds its transmuxer worker with
            // new Worker(URL.createObjectURL(blob)). worker-src falls back to
            // script-src when unset, so without this the player loses its
            // worker and transmuxes on the main thread instead — degraded
            // rather than broken, and silent apart from a console error.
            "worker-src 'self' blob:",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            // Sign-in talks to Cognito directly from the browser: the SRP
            // exchange is several round trips against the user pool endpoint,
            // and it is not proxied through this origin. Without it here the
            // policy blocks the very first request of the very first page and
            // nobody can sign in at all — which is exactly what it did.
            //
            // Named to the one regional host rather than a wildcard, so this
            // stays a policy that would still contain an XSS in the console —
            // the one page that holds credential plaintext in memory before
            // sealing it.
            `connect-src 'self' https://cognito-idp.${Stack.of(this).region}.amazonaws.com`,
            "font-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
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

    // Who watched what, and when. A CCTV customer asks that question sooner or
    // later for compliance reasons, and incident response needs it before
    // that; there was no way to answer it at all. Kept 90 days and then
    // expired, so the audit trail does not quietly become a storage bill.
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // CloudFront writes here directly, which needs an owner-preferred ACL.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ id: 'expire-logs', enabled: true, expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.logBucket = logBucket;

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'CamStream',
      enableLogging: true,
      logBucket,
      logFilePrefix: 'cloudfront/',
      // Cookies carry the signed-cookie policy, which is not useful in a log
      // and is a credential of sorts.
      logIncludesCookies: false,
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
          functionAssociations: [
            {
              function: new HostForwarder(this, 'HostForwarder').function,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
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
