import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

/** Header carrying the hostname the viewer actually asked for. */
export const VIEWER_HOST_HEADER = 'x-camstream-viewer-host';

/**
 * Preserves the viewer's Host header for the control plane.
 *
 * The `/api/*` behaviour forwards everything except Host, because API Gateway
 * rejects a request whose Host is not its own. That leaves the session Lambda
 * unable to see which of the distribution's aliases the browser used — and it
 * needs exactly that, since a CloudFront cookie policy is scoped to a specific
 * origin, and one signed for the apex will not validate on www.
 *
 * Copying the value into a custom header before CloudFront rewrites it is the
 * only place the original is still available.
 */
export class HostForwarder extends Construct {
  public readonly function: cloudfront.Function;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.function = new cloudfront.Function(this, 'Function', {
      functionName: 'camstream-host-forwarder',
      comment: 'Preserve the viewer Host header for /api/*',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.headers.host && request.headers.host.value) {
    request.headers['${VIEWER_HOST_HEADER}'] = { value: request.headers.host.value };
  }
  return request;
}
      `.trim()),
    });
  }
}
