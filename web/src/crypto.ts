/**
 * Encrypts a camera credential so that only one specific agent can read it.
 *
 * This runs in the administrator's browser. The plaintext never reaches the
 * network: the control plane stores and forwards ciphertext it has no key for,
 * and the agent decrypts it on the customer's own hardware.
 *
 * Must stay byte-compatible with the agent's CredentialEnvelope — RSA-OAEP with
 * SHA-256, over an SPKI public key. The JCE's default MGF1 digest is SHA-1, so
 * the agent states SHA-256 explicitly; WebCrypto has no such ambiguity.
 */

/**
 * Returns an ArrayBuffer rather than a Uint8Array: a Uint8Array's backing store
 * is typed as ArrayBufferLike, which may be a SharedArrayBuffer, and WebCrypto
 * will not accept one.
 */
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return buffer;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i]);
  }
  return btoa(binary);
}

/**
 * @param publicKeyBase64 the agent's SPKI key, as reported in its heartbeat
 * @returns base64 ciphertext safe to hand to the control plane
 */
export async function sealCredential(
  publicKeyBase64: string,
  username: string,
  password: string,
): Promise<string> {
  const payload = JSON.stringify({ username, password });

  // A 2048-bit RSA-OAEP-SHA256 key holds 190 bytes. Failing loudly beats
  // silently storing something the agent will reject at decrypt time.
  const utf8 = new TextEncoder().encode(payload);
  if (utf8.byteLength > 190) {
    throw new Error('Credential is too long to encrypt (limit is 190 bytes)');
  }
  const encoded = new ArrayBuffer(utf8.byteLength);
  new Uint8Array(encoded).set(utf8);

  const key = await crypto.subtle.importKey(
    'spki',
    base64ToBuffer(publicKeyBase64),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );

  const ciphertext = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, encoded);
  return bytesToBase64(ciphertext);
}

/** WebCrypto's subtle API is unavailable on insecure origins. */
export function cryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle?.importKey === 'function';
}
