/**
 * Tenant and device identifiers appear inside S3 key prefixes, IAM policy
 * variables and CloudFront wildcard resources, so their character set is
 * deliberately narrow. `--` is reserved as the tenant/device separator inside a
 * thing name; forbidding `-` runs in the ids themselves keeps the CloudFront
 * wildcard `live/<tenantId>--*` from ever matching a neighbouring tenant.
 */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 3 && value.length <= 32 && ID.test(value) && !value.includes('--');
}

/** `<tenantId>--<deviceId>` — the IoT thing name, and the S3 prefix segment. */
export function thingName(tenantId: string, deviceId: string): string {
  return `${tenantId}--${deviceId}`;
}

export function parseThingName(name: string): { tenantId: string; deviceId: string } | null {
  const parts = name.split('--');
  if (parts.length !== 2) return null;
  const [tenantId, deviceId] = parts;
  if (!isValidId(tenantId) || !isValidId(deviceId)) return null;
  return { tenantId, deviceId };
}
