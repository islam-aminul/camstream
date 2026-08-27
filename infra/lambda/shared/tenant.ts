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
 * A viewer restricted to particular premises gets one policy per site, and
 * CloudFront allows only a single statement — so a viewer scoped to more than
 * one site but not all of them receives the tenant-wide wildcard. Narrowing
 * that further needs one cookie set per site, which the player does not
 * currently support; recorded here so the limit is visible rather than implied.
 */
export function cookieResource(origin: string, tenantId: string, premisesIds: string[] | undefined): string {
  if (premisesIds && premisesIds.length === 1) {
    return `${origin}/live/${tenantId}--${premisesIds[0]}--*`;
  }
  return `${origin}/live/${tenantId}--*`;
}
