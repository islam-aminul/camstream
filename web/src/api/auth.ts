import {
  CognitoUser,
  CognitoUserPool,
  AuthenticationDetails,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';

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

let configPromise: Promise<RuntimeConfig> | undefined;

export function loadConfig(): Promise<RuntimeConfig> {
  configPromise ??= fetch('/config.json', { cache: 'no-store' })
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
      configPromise = undefined;
      throw err;
    });
  return configPromise;
}

let poolPromise: Promise<CognitoUserPool> | undefined;

function getPool(): Promise<CognitoUserPool> {
  poolPromise ??= loadConfig().then(
    (config) => new CognitoUserPool({
      UserPoolId: config.userPoolId,
      ClientId: config.userPoolClientId,
    }),
  );
  return poolPromise;
}

export class NewPasswordRequired extends Error {
  constructor(readonly user: CognitoUser) {
    super('A new password is required');
    this.name = 'NewPasswordRequired';
  }
}

/** Signs in with SRP — the password itself never leaves the browser. */
export async function signIn(email: string, password: string): Promise<CognitoUserSession> {
  const pool = await getPool();
  const user = new CognitoUser({ Username: email, Pool: pool });
  return new Promise((resolve, reject) => {
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: resolve,
      onFailure: reject,
      // Admin-created accounts land here on first sign-in.
      newPasswordRequired: () => reject(new NewPasswordRequired(user)),
    });
  });
}

export function completeNewPassword(
  user: CognitoUser,
  password: string,
): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(password, {}, { onSuccess: resolve, onFailure: reject });
  });
}

/** A valid session, refreshing the ID token if it has expired. */
export async function currentSession(): Promise<CognitoUserSession | null> {
  const pool = await getPool();
  const user = pool.getCurrentUser();
  if (!user) return null;
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      resolve(err || !session?.isValid() ? null : session);
    });
  });
}

export async function signOut(): Promise<void> {
  const pool = await getPool();
  pool.getCurrentUser()?.signOut();
}
