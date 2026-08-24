/**
 * Runtime configuration, fetched rather than baked in at build time so that a
 * redeploy of the infrastructure does not require rebuilding the bundle.
 * `scripts/deploy-web.sh` writes this file from the CloudFormation outputs.
 */
export interface RuntimeConfig {
  userPoolId: string;
  userPoolClientId: string;
  region: string;
}

let cached: Promise<RuntimeConfig> | undefined;

export function loadConfig(): Promise<RuntimeConfig> {
  cached ??= fetch('/config.json', { cache: 'no-store' })
    .then((res) => {
      if (!res.ok) throw new Error(`config.json returned ${res.status}`);
      return res.json() as Promise<RuntimeConfig>;
    })
    .then((config) => {
      if (!config.userPoolId || config.userPoolId.startsWith('REPLACED')) {
        throw new Error('Deployment is missing its Cognito configuration');
      }
      return config;
    })
    .catch((err) => {
      cached = undefined;
      throw err;
    });
  return cached;
}
