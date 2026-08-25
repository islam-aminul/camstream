import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { isValidId } from './tenant';

/**
 * Authorisation.
 *
 * Roles are Cognito groups rather than token attributes, so removing someone's
 * rights takes effect on their next token refresh instead of whenever their
 * current token happens to expire.
 *
 * Every role except `superadmin` is scoped by the caller's `custom:tenantId`.
 * Superadmin is the vendor operating the platform: it exists so that onboarding
 * a customer does not require shell access to AWS, and it is the only role that
 * may act across tenants.
 */
export const ROLES = ['superadmin', 'admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Rank, lowest number wins. Used to pick the effective role. */
const RANK: Record<Role, number> = { superadmin: 0, admin: 1, operator: 2, viewer: 3 };

export const CAPABILITIES = {
  /** Create tenants and act outside your own. */
  crossTenant: ['superadmin'],
  /** Invite users and change their roles. */
  manageUsers: ['superadmin', 'admin'],
  /** Create premises, enrol agents, approve cameras. */
  manageEstate: ['superadmin', 'admin', 'operator'],
  /**
   * Set camera credentials. Deliberately available to operators: whoever
   * physically installs a camera is who has its password, and splitting those
   * makes every site visit a two-person job. Credentials are write-only for
   * every role, so this grants setting them, never reading them.
   */
  manageCredentials: ['superadmin', 'admin', 'operator'],
  /** Watch streams. */
  viewStreams: ['superadmin', 'admin', 'operator', 'viewer'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export interface Caller {
  sub: string;
  email: string;
  tenantId: string;
  role: Role;
  /** Premises this caller may see. Empty means all within the tenant. */
  premises: string[];
}

/**
 * The `cognito:groups` claim arrives as an array in an ID token but can be a
 * bracketed string once it has passed through the HTTP API authorizer, so both
 * shapes are normalised before membership is tested.
 */
function groupsFrom(claims: Record<string, unknown>): string[] {
  const raw = claims['cognito:groups'];
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw === 'string') {
    return raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

/** Resolves the caller, or null when the token cannot be trusted for any action. */
export function identify(event: APIGatewayProxyEventV2WithJWTAuthorizer): Caller | null {
  const claims = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const sub = claims.sub;
  const tenantId = claims['custom:tenantId'];

  if (typeof sub !== 'string' || sub.length === 0 || !isValidId(tenantId)) {
    return null;
  }

  const held = groupsFrom(claims).filter((group): group is Role => (ROLES as readonly string[]).includes(group));
  // Absence of any group is a viewer: an account that exists but was never
  // granted anything can watch, and nothing more.
  const role = held.sort((a, b) => RANK[a] - RANK[b])[0] ?? 'viewer';

  const premisesClaim = claims['custom:premises'];
  const premises =
    typeof premisesClaim === 'string' && premisesClaim.trim().length > 0
      ? premisesClaim.split(',').map((id) => id.trim()).filter(isValidId)
      : [];

  return {
    sub,
    email: typeof claims.email === 'string' ? claims.email : sub,
    tenantId,
    role,
    premises,
  };
}

export function can(caller: Caller, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly Role[]).includes(caller.role);
}

/**
 * The tenant a request may act on.
 *
 * Only a superadmin may name a different one, and doing so is an explicit
 * parameter rather than something inferred — a cross-tenant write should never
 * be reachable by accident.
 */
export function targetTenant(caller: Caller, requested?: unknown): string | null {
  if (typeof requested !== 'string' || requested === caller.tenantId) {
    return caller.tenantId;
  }
  if (!can(caller, 'crossTenant') || !isValidId(requested)) {
    return null;
  }
  return requested;
}
