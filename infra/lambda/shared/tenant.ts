/**
 * Identity and naming.
 *
 * A thing name is `<tenantId>--<premisesId>--<deviceId>`, and that string is
 * also the S3 prefix segment a device writes beneath. Putting premises in the
 * path is what makes per-site access expressible: a CloudFront cookie policy is
 * a single wildcard, so `live/<tenant>--<premises>--*` grants one site and
 * `live/<tenant>--*` grants them all. Neither is possible if premises is only
 * an attribute.
 *
 * The `--` separator is therefore load-bearing, and ids may not contain it —
 * otherwise one tenant's wildcard could match another's prefix.
 */

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What a person types, and what the machine uses, are different strings.
 *
 * A display name is read by people, so it carries spaces and capitals:
 * "HQ North". An id is an AWS IoT thing name segment, an S3 key prefix, a
 * CloudFront cookie wildcard and a URL segment — and IoT thing names forbid
 * spaces outright, permitting only letters, digits, hyphen, underscore and
 * colon. A space therefore cannot live in an id whatever we would prefer.
 *
 * So the id is derived rather than typed. Somebody enters "HQ North" and gets
 * `hq-north` without having to know why.
 */
const DISPLAY_NAME = /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/;

/**
 * A name a person may type.
 *
 * Letters, digits, single spaces and single hyphens. Two hyphens together are
 * refused because `--` separates the parts of a thing name, and two spaces
 * together because they are invisible and make two names that look identical
 * behave differently.
 */
export function isValidDisplayName(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed.length >= 3 &&
    trimmed.length <= 64 &&
    DISPLAY_NAME.test(trimmed) &&
    !trimmed.includes('--') &&
    !trimmed.includes('  ')
  );
}

/**
 * The id a display name becomes.
 *
 * Returns null when the result would not be a usable id, rather than quietly
 * producing something shorter or stranger than the caller expects — a name of
 * "aa" or "---" has no reasonable slug and should be refused at the edge.
 */
export function idFrom(displayName: string): string | null {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return isValidId(slug) ? slug : null;
}

export function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= 32 &&
    ID.test(value) &&
    !value.includes('--')
  );
}

export interface DeviceIdentity {
  tenantId: string;
  premisesId: string;
  deviceId: string;
}

export function thingName(identity: DeviceIdentity): string {
  return `${identity.tenantId}--${identity.premisesId}--${identity.deviceId}`;
}

export function parseThingName(name: string): DeviceIdentity | null {
  const parts = name.split('--');
  if (parts.length !== 3) {
    return null;
  }
  const [tenantId, premisesId, deviceId] = parts;
  if (!isValidId(tenantId) || !isValidId(premisesId) || !isValidId(deviceId)) {
    return null;
  }
  return { tenantId, premisesId, deviceId };
}

/**
 * Whether a string is a well-formed thing name.
 *
 * This replaces a regex that disagreed with `parseThingName`. Because `-` sat
 * inside the character class, the first group swallowed an embedded separator,
 * so `acme--hq--gate-01--evil` matched as three parts and `-ab--cde--fgh`
 * passed with a leading hyphen — names `parseThingName` rejects and the device
 * lambda would therefore refuse forever. Two validators for one format is one
 * too many.
 */
export function isThingName(value: unknown): value is string {
  return typeof value === 'string' && parseThingName(value) !== null;
}

/**
 * Premises a caller may see, from the `custom:premises` claim.
 * Empty means every site in the tenant.
 */
export function premisesScope(claims: Record<string, unknown> | undefined): string[] {
  const raw = claims?.['custom:premises'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }
  return raw.split(',').map((id) => id.trim()).filter(isValidId);
}

/**
 * Whether a thing belongs to a premises this caller may see.
 *
 * Applied to listings as well as playback: a viewer restricted to one site
 * should not learn from a camera list that other sites exist, what their agents
 * are called, or what is watched there.
 */
export function withinScope(thingName: string, scope: string[]): boolean {
  if (scope.length === 0) {
    return true;
  }
  const identity = parseThingName(thingName);
  return identity !== null && scope.includes(identity.premisesId);
}

/**
 * CloudFront resource wildcard for a viewer.
 *
 * A cookie policy statement carries exactly one resource, so a viewer allowed
 * several sites cannot be granted all of them at once. That used to be
 * resolved by issuing the tenant-wide wildcard, which meant a restriction
 * naming two sites granted every site in the customer — a restriction that
 * blocked nothing.
 *
 * It is resolved instead by asking which site is being watched. A viewer
 * watches one site at a time, which the watch endpoint already enforces, so
 * the cookie can be exactly as wide as the screen. The claim remains the
 * authority: naming a site can only narrow what the claim already allows,
 * never widen it, and an unnamed site falls back to one the viewer holds
 * rather than to all of them.
 */
export function cookieResource(
  origin: string,
  tenantId: string,
  premisesIds: string[] | undefined,
  /** The site the viewer is actually watching, when the console has said. */
  watching?: string,
): string {
  const site = (id: string) => `${origin}/live/${tenantId}--${id}--*`;
  const allowed = premisesIds ?? [];

  // A CloudFront policy statement carries exactly one resource, so several
  // sites cannot be granted at once. Naming the one being watched is what
  // closes that: a viewer watches one site at a time — the watch endpoint
  // already enforces it — so the cookie can be as narrow as the screen.
  if (watching && (allowed.length === 0 || allowed.includes(watching))) {
    return site(watching);
  }

  if (allowed.length === 1) {
    return site(allowed[0]!);
  }

  // Restricted to several sites and not told which is being watched. The
  // tenant-wide wildcard used to be issued here, which handed a viewer
  // restricted to two sites every site in the customer. One of their own
  // sites is the honest fallback; the console names the right one as soon as
  // a premises is chosen, which is before anything can be played.
  if (allowed.length > 1) {
    return site([...allowed].sort()[0]!);
  }

  return `${origin}/live/${tenantId}--*`;
}
