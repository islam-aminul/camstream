import {
  CognitoUser,
  CognitoUserPool,
  AuthenticationDetails,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { loadConfig } from './config';

let poolPromise: Promise<CognitoUserPool> | undefined;

function getPool(): Promise<CognitoUserPool> {
  poolPromise ??= loadConfig().then(
    (config) =>
      new CognitoUserPool({
        UserPoolId: config.userPoolId,
        ClientId: config.userPoolClientId,
      }),
  );
  return poolPromise;
}

export class NewPasswordRequired extends Error {
  readonly user: CognitoUser;

  constructor(user: CognitoUser) {
    super('A new password is required');
    this.name = 'NewPasswordRequired';
    this.user = user;
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
      // Admin-created users land here on first sign-in.
      newPasswordRequired: () => reject(new NewPasswordRequired(user)),
    });
  });
}

export function completeNewPassword(user: CognitoUser, password: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(password, {}, { onSuccess: resolve, onFailure: reject });
  });
}

/** Returns a valid session, refreshing the ID token if it has expired. */
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
