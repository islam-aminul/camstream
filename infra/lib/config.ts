import { App } from 'aws-cdk-lib';

/** Resolved deployment configuration, read from `cdk.json` context. */
export interface CamStreamConfig {
  readonly account: string;
  /** Region holding storage, compute, IoT and the registry. */
  readonly primaryRegion: string;
  /** Must be us-east-1 — CloudFront only accepts ACM certs from there. */
  readonly edgeRegion: string;
  readonly domainName: string;
  /** Canonical host the player, API and segments are all served from. */
  readonly appDomain: string;
  /** Extra hostnames the distribution also answers on. */
  readonly altDomains: readonly string[];
  /** Days before live segments are purged by the S3 lifecycle rule. */
  readonly segmentTtlDays: number;
}

function required(app: App, key: string): string {
  const value = app.node.tryGetContext(key);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required context value "${key}" in cdk.json`);
  }
  return value;
}

/**
 * Account id, taken from whichever credentials are deploying.
 *
 * Deliberately not committed: it is not a secret, but it is permanent once
 * published and it makes this deployment's bucket names guessable. `cdk`
 * populates CDK_DEFAULT_ACCOUNT from the active profile.
 */
function resolveAccount(app: App): string {
  const fromContext = app.node.tryGetContext('camstream:account');
  if (typeof fromContext === 'string' && fromContext.length > 0) {
    return fromContext;
  }
  const fromEnv = process.env.CDK_DEFAULT_ACCOUNT;
  if (fromEnv) {
    return fromEnv;
  }
  throw new Error(
    'Cannot determine the target AWS account. Run through the cdk CLI with valid ' +
      'credentials, or pass -c camstream:account=<id>.',
  );
}

export function resolveConfig(app: App): CamStreamConfig {
  const domainName = required(app, 'camstream:domainName');
  const edgeRegion = required(app, 'camstream:edgeRegion');

  if (edgeRegion !== 'us-east-1') {
    throw new Error(`camstream:edgeRegion must be us-east-1 (CloudFront cert requirement), got "${edgeRegion}"`);
  }

  const ttl = app.node.tryGetContext('camstream:segmentTtlDays');
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1) {
    throw new Error('camstream:segmentTtlDays must be an integer >= 1');
  }

  return {
    account: resolveAccount(app),
    primaryRegion: required(app, 'camstream:primaryRegion'),
    edgeRegion,
    domainName,
    // Everything is same-origin on the apex: the player, /api/* and /live/*
    // share one distribution, so CloudFront cookies need no Domain attribute
    // and the player needs no CORS.
    appDomain: domainName,
    altDomains: [`www.${domainName}`],
    segmentTtlDays: ttl,
  };
}
