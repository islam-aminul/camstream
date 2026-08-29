/**
 * What a customer, site or agent may be called.
 *
 * A deliberate mirror of infra/lambda/shared/tenant.ts, which is the authority
 * — this copy exists so the console can refuse a name before the round trip
 * and, more importantly, say why. The rule is not arbitrary: names become part
 * of an IoT thing name, `<tenant>--<premises>--<device>`, so a double dash
 * inside any of the three parts would make the name ambiguous to parse and put
 * a device in the wrong site.
 *
 * Single dashes and single spaces are allowed. Two of either in a row are not.
 */

const DISPLAY_NAME = /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/;

export const MIN_NAME = 3;
export const MAX_NAME = 64;

export function isValidDisplayName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= MIN_NAME && trimmed.length <= MAX_NAME
    && DISPLAY_NAME.test(trimmed)
    && !trimmed.includes('--') && !trimmed.includes('  ');
}

/**
 * Why a name was refused, in one sentence, or null if it was not.
 *
 * "Invalid name" tells somebody nothing they can act on. Each branch here
 * names the character that caused it, because the person typing has usually
 * pasted something and cannot see what is wrong with it.
 */
export function nameComplaint(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'A name is needed.';
  if (trimmed.length < MIN_NAME) return `At least ${MIN_NAME} characters.`;
  if (trimmed.length > MAX_NAME) return `At most ${MAX_NAME} characters.`;
  if (trimmed.includes('--')) {
    return 'Two dashes in a row are not allowed — a single dash is fine.';
  }
  if (trimmed.includes('  ')) {
    return 'Two spaces in a row are not allowed — a single space is fine.';
  }
  if (/^[ -]|[ -]$/.test(trimmed)) {
    return 'Start and end with a letter or a number.';
  }
  if (!DISPLAY_NAME.test(trimmed)) {
    const offending = [...trimmed].find((c) => !/[A-Za-z0-9 -]/.test(c));
    return offending
      ? `"${offending}" is not allowed — use letters, numbers, spaces and single dashes.`
      : 'Use letters, numbers, spaces and single dashes.';
  }
  return null;
}

/**
 * The id a display name becomes.
 *
 * Shown while typing, because the id is what appears in URLs, thing names and
 * S3 paths and is permanent once created — somebody naming a site deserves to
 * see what they are actually naming.
 */
export function idFrom(displayName: string): string | null {
  const slug = displayName.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug) && !slug.includes('--') ? slug : null;
}
