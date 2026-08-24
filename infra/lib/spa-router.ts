import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

/**
 * Rewrites extension-less paths to `/index.html` so client-side routes survive
 * a hard refresh.
 *
 * This is a CloudFront Function rather than a distribution-wide custom error
 * response on purpose: custom error responses are global, and would turn a
 * legitimate 403 on a signed `/live/*` segment into a 200 carrying the HTML
 * shell — which the player would then try to parse as a manifest.
 */
export class SpaRouter extends Construct {
  public readonly function: cloudfront.Function;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.function = new cloudfront.Function(this, 'Function', {
      functionName: 'camstream-spa-router',
      comment: 'Rewrite extension-less paths to /index.html',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }
  var lastSegment = uri.slice(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
      `.trim()),
    });
  }
}
