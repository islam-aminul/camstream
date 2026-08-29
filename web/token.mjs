import pkg from 'amazon-cognito-identity-js';
const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;
const pool = new CognitoUserPool({ UserPoolId: 'ap-south-1_5rsbiNjqE', ClientId: '4piqju89e29gt9nieifm2hub61' });
const u = new CognitoUser({ Username: process.env.CS_USER, Pool: pool });
u.authenticateUser(new AuthenticationDetails({ Username: process.env.CS_USER, Password: process.env.CS_PASS }), {
  onSuccess: (s) => console.log(s.getIdToken().getJwtToken()),
  onFailure: (e) => { console.error('FAIL', e.message ?? e); process.exit(1); },
});
