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

/** Regex a thing name must satisfy, for validating request bodies. */
export const THING_NAME_PATTERN = /^[a-z0-9-]{3,32}--[a-z0-9-]{3,32}--[a-z0-9-]{3,32}$/;

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
