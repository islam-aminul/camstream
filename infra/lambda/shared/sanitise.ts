/**
 * Bounds for text that originates outside the control plane.
 *
 * Most of these values come from a camera, relayed by an agent — an ONVIF
 * response is attacker-controlled input on the customer's network, and the
 * agent has no more reason to trust it than we do. Unbounded, a single device
 * could push a record past DynamoDB's 400KB item limit, inflate storage for
 * every reader, and make the admin console unreadable.
 */

/** Longest a descriptive field may be once stored. */
export const MAX_LABEL = 128;

/** C0 and C1 control characters, which no device name legitimately contains. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Trims a free-text value to something safe to store and display.
 *
 * Control characters are removed rather than escaped: they have no legitimate
 * place in a device name, and leaving them in makes logs and consoles lie about
 * what a value actually is.
 */
export function label(value: unknown, max: number = MAX_LABEL): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  return cleaned.length === 0 ? undefined : cleaned.slice(0, max);
}

/** An IPv4 address, or undefined. Anything else is not worth storing. */
export function ipAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed.split('.').every((octet) => Number(octet) <= 255) ? trimmed : undefined;
}

/** A MAC address in the agent's normalised form. */
export function macAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(trimmed) ? trimmed : undefined;
}

/** One of a fixed set, or the given fallback. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** A finite integer within range, or undefined. */
export function bounded(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  return rounded >= min && rounded <= max ? rounded : undefined;
}

/** Base64 of a plausible RSA public key or ciphertext. */
export function base64Key(value: unknown, minLength: number, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    return undefined;
  }
  return /^[A-Za-z0-9+/=]+$/.test(trimmed) ? trimmed : undefined;
}
