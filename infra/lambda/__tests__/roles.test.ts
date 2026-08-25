import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { identify, can, targetTenant } from '../shared/roles';

/** Minimal event carrying only the claims the authorizer would have verified. */
function event(claims: Record<string, unknown>): APIGatewayProxyEventV2WithJWTAuthorizer {
  return { requestContext: { authorizer: { jwt: { claims } } } } as never;
}

const admin = { sub: 'u1', email: 'a@example.com', 'custom:tenantId': 'acme', 'cognito:groups': ['admin'] };

describe('identify', () => {
  it('reads role and tenant from verified claims', () => {
    const caller = identify(event(admin));
    expect(caller).toMatchObject({ tenantId: 'acme', role: 'admin', email: 'a@example.com' });
  });

  it('accepts the bracketed string form the HTTP API authorizer can produce', () => {
    // The same claim arrives as an array in an ID token and as "[admin]" once
    // it has passed through the authorizer; both must resolve identically.
    expect(identify(event({ ...admin, 'cognito:groups': '[admin]' }))?.role).toBe('admin');
    expect(identify(event({ ...admin, 'cognito:groups': '[operator viewer]' }))?.role).toBe('operator');
  });

  it('treats an account with no group as a viewer', () => {
    const { 'cognito:groups': _omitted, ...noGroups } = admin;
    expect(identify(event(noGroups))?.role).toBe('viewer');
  });

  it('takes the most privileged group when several are held', () => {
    expect(identify(event({ ...admin, 'cognito:groups': ['viewer', 'superadmin', 'admin'] }))?.role)
      .toBe('superadmin');
  });

  it('ignores groups that are not roles', () => {
    // A group added for some unrelated purpose must not become an escalation.
    expect(identify(event({ ...admin, 'cognito:groups': ['billing', 'root', 'wheel'] }))?.role)
      .toBe('viewer');
  });

  it('refuses a token without a usable tenant', () => {
    expect(identify(event({ ...admin, 'custom:tenantId': undefined }))).toBeNull();
    // '--' separates the parts of a thing name; permitting it inside a tenant
    // id would let one tenant's CloudFront wildcard match another's prefix.
    expect(identify(event({ ...admin, 'custom:tenantId': 'ac--me' }))).toBeNull();
    expect(identify(event({ ...admin, 'custom:tenantId': 'AC' }))).toBeNull();
  });

  it('parses premises scoping and discards malformed entries', () => {
    // Ids shorter than three characters, upper case, or containing the
    // reserved '--' separator are dropped rather than trusted.
    const caller = identify(event({
      ...admin,
      'custom:premises': 'acme-hq, acme-dc ,HQ,ok--no,xy',
    }));
    expect(caller?.premises).toEqual(['acme-hq', 'acme-dc']);
  });
});

describe('capabilities', () => {
  const roleFor = (role: string) =>
    identify(event({ ...admin, 'cognito:groups': [role] }))!;

  it('grants estate management to operators but not viewers', () => {
    expect(can(roleFor('operator'), 'manageEstate')).toBe(true);
    expect(can(roleFor('viewer'), 'manageEstate')).toBe(false);
  });

  it('lets operators set credentials, since they install the cameras', () => {
    expect(can(roleFor('operator'), 'manageCredentials')).toBe(true);
  });

  it('keeps user management away from operators', () => {
    expect(can(roleFor('operator'), 'manageUsers')).toBe(false);
    expect(can(roleFor('admin'), 'manageUsers')).toBe(true);
  });

  it('reserves cross-tenant access to superadmin', () => {
    expect(can(roleFor('admin'), 'crossTenant')).toBe(false);
    expect(can(roleFor('superadmin'), 'crossTenant')).toBe(true);
  });

  it('lets every role watch', () => {
    for (const role of ['superadmin', 'admin', 'operator', 'viewer']) {
      expect(can(roleFor(role), 'viewStreams')).toBe(true);
    }
  });
});

describe('targetTenant', () => {
  const adminCaller = identify(event(admin))!;
  const superCaller = identify(event({ ...admin, 'cognito:groups': ['superadmin'] }))!;

  it('defaults to the caller own tenant', () => {
    expect(targetTenant(adminCaller, undefined)).toBe('acme');
    expect(targetTenant(adminCaller, 'acme')).toBe('acme');
  });

  it('refuses another tenant for anyone but a superadmin', () => {
    expect(targetTenant(adminCaller, 'other')).toBeNull();
    expect(targetTenant(superCaller, 'other')).toBe('other');
  });

  it('refuses a malformed tenant even from a superadmin', () => {
    expect(targetTenant(superCaller, 'ot--her')).toBeNull();
  });
});
