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
exports.Edge = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const constructs_1 = require("constructs");
const spa_router_1 = require("./spa-router");
const host_forwarder_1 = require("./host-forwarder");
/**
 * One distribution serves the player, the control API and the media, so that
 * everything is same-origin: CloudFront cookies need no Domain attribute and
 * the player needs no CORS preflights on the segment path.
 */
class Edge extends constructs_1.Construct {
    distribution;
    constructor(scope, id, props) {
        super(scope, id);
        const { config, liveBucket, webBucket, keyGroup, certificate } = props;
        const liveOrigin = origins.S3BucketOrigin.withOriginAccessControl(liveBucket);
        const webOrigin = origins.S3BucketOrigin.withOriginAccessControl(webBucket);
        const apiOrigin = new origins.HttpOrigin(props.apiOriginDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            readTimeout: aws_cdk_lib_1.Duration.seconds(30),
        });
        // Manifests are rewritten every part interval. Anything beyond a ~1s
        // collapse window shows up directly as viewer latency.
        const manifestCachePolicy = new cloudfront.CachePolicy(this, 'ManifestCachePolicy', {
            cachePolicyName: 'camstream-manifest',
            comment: 'LL-HLS manifests — collapse concurrent viewers, never stale by more than 1s',
            minTtl: aws_cdk_lib_1.Duration.seconds(0),
            defaultTtl: aws_cdk_lib_1.Duration.seconds(0),
            maxTtl: aws_cdk_lib_1.Duration.seconds(1),
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
            minTtl: aws_cdk_lib_1.Duration.seconds(1),
            defaultTtl: aws_cdk_lib_1.Duration.hours(6),
            maxTtl: aws_cdk_lib_1.Duration.days(1),
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
                    accessControlMaxAge: aws_cdk_lib_1.Duration.days(365),
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
                        function: new spa_router_1.SpaRouter(this, 'SpaRouter').function,
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
                            function: new host_forwarder_1.HostForwarder(this, 'HostForwarder').function,
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
exports.Edge = Edge;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWRnZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImVkZ2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXVDO0FBRXZDLHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFFOUQsMkNBQXVDO0FBRXZDLDZDQUF5QztBQUN6QyxxREFBaUQ7QUFXakQ7Ozs7R0FJRztBQUNILE1BQWEsSUFBSyxTQUFRLHNCQUFTO0lBQ2pCLFlBQVksQ0FBMEI7SUFFdEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFnQjtRQUN4RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ2pCLE1BQU0sRUFBRSxNQUFNLEVBQUUsVUFBVSxFQUFFLFNBQVMsRUFBRSxRQUFRLEVBQUUsV0FBVyxFQUFFLEdBQUcsS0FBSyxDQUFDO1FBRXZFLE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxjQUFjLENBQUMsdUJBQXVCLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDOUUsTUFBTSxTQUFTLEdBQUcsT0FBTyxDQUFDLGNBQWMsQ0FBQyx1QkFBdUIsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUM1RSxNQUFNLFNBQVMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsS0FBSyxDQUFDLGVBQWUsRUFBRTtZQUM5RCxjQUFjLEVBQUUsVUFBVSxDQUFDLG9CQUFvQixDQUFDLFVBQVU7WUFDMUQsV0FBVyxFQUFFLHNCQUFRLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztTQUNsQyxDQUFDLENBQUM7UUFFSCxxRUFBcUU7UUFDckUsdURBQXVEO1FBQ3ZELE1BQU0sbUJBQW1CLEdBQUcsSUFBSSxVQUFVLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxxQkFBcUIsRUFBRTtZQUNsRixlQUFlLEVBQUUsb0JBQW9CO1lBQ3JDLE9BQU8sRUFBRSw2RUFBNkU7WUFDdEYsTUFBTSxFQUFFLHNCQUFRLENBQUMsT0FB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