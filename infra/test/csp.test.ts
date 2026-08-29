import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CamStreamZoneStack } from '../lib/zone-stack';
import { CamStreamCertStack } from '../lib/cert-stack';
import { CamStreamAppStack } from '../lib/app-stack';
import { resolveConfig } from '../lib/config';

/**
 * The Content-Security-Policy, checked at synth.
 *
 * This exists because the policy silently broke the entire product. Sign-in
 * runs an SRP exchange from the browser straight against the Cognito user pool
 * endpoint — it is not proxied through this origin — and `connect-src 'self'`
 * blocked the first request of the first page. Nobody could sign in at all,
 * and nothing failed at deploy time to say so: the site served, the console
 * rendered, and the only symptom was a refusal in a browser console.
 *
 * A header is exactly the kind of thing no unit test covers and no deployment
 * validates, so it is asserted here — both that the things the app needs are
 * permitted, and that the things that make the policy worth having are still
 * refused.
 */
function policy(): string {
  // The same context the deployed stack uses, so the policy under test is the
  // policy that ships — a synth against invented values proves nothing about
  // the header a viewer actually receives.
  const app = new App({
    context: {
      'camstream:account': '123456789012',
      'camstream:primaryRegion': 'ap-south-1',
      'camstream:edgeRegion': 'us-east-1',
      'camstream:domainName': 'camstream.online',
      'camstream:segmentTtlDays': 1,
    },
  });
  const config = resolveConfig(app);
  const edgeEnv = { account: config.account, region: config.edgeRegion };

  const zone = new CamStreamZoneStack(app, 'Zone', { env: edgeEnv, config });
  const cert = new CamStreamCertStack(app, 'Cert', {
    env: edgeEnv, config, hostedZone: zone.hostedZone,
  });
  const stack = new CamStreamAppStack(app, 'App', {
    env: { account: config.account, region: config.primaryRegion },
    config,
    hostedZone: zone.hostedZone,
    certificate: cert.certificate,
    crossRegionReferences: true,
  });

  const headers = Template.fromStack(stack)
    .findResources('AWS::CloudFront::ResponseHeadersPolicy');
  const found = Object.values(headers)
    .map((r) => r.Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig
      ?.ContentSecurityPolicy?.ContentSecurityPolicy)
    .find((value): value is string => typeof value === 'string');

  expect(found, 'no Content-Security-Policy was synthesised at all').toBeTypeOf('string');
  return found!;
}

describe('what the console is allowed to talk to', () => {
  it('permits the Cognito endpoint sign-in actually uses', () => {
    // The regression this is here for. Without it the console renders, looks
    // healthy, and cannot authenticate a single person.
    expect(policy()).toContain('https://cognito-idp.ap-south-1.amazonaws.com');
  });

  it('names one regional host rather than opening the connection wholesale', () => {
    // A wildcard would have fixed sign-in and given up the reason the policy
    // exists: containing an XSS in the one page that holds credential
    // plaintext in memory before sealing it.
    const csp = policy();
    expect(csp).not.toContain('connect-src *');
    expect(csp).not.toContain('*.amazonaws.com');
  });

  it('still lets the player build its transmux worker', () => {
    // hls.js does new Worker(URL.createObjectURL(blob)); worker-src falls back
    // to script-src when unset, so losing this degrades playback silently.
    expect(policy()).toContain("worker-src 'self' blob:");
  });

  it('keeps the restrictions that make the policy worth having', () => {
    const csp = policy();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // No inline or remote script: this console has no third-party scripts, so
    // there is nothing to trade away for.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
