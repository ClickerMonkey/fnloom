/**
 * Fingerprints, codes and tokens for pairing. The keys and the link proof themselves (Ed25519, `key.json`) are the
 * SDK's (`@harness/sdk/server`), the one implementation both ends of the link use; they are re-exported here for the
 * link module. Pairing tokens are shown once; only their sha-256 is stored.
 */
import { createHash, randomBytes } from 'node:crypto';

export { isPublicKey, KEY_FILE, makeKeyPair, signNonce, StoredKeyPair, verifyNonce } from '@harness/sdk/server';

/** The sha-256 of a string, hex. */
export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A public key's fingerprint: the sha-256 of its DER bytes, hex, in groups of four (what an admin compares). */
export function fingerprint(publicKey: string): string {
  return (sha256Hex(Buffer.from(publicKey, 'base64')).match(/.{4}/g) ?? []).join(':');
}

/** Random bytes as base64url: nonces and one-time tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Letters and digits that can't be mistaken for each other. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A short pairing code an admin compares with what the system printed: `K7QF-2MXR`. */
export function pairingCode(): string {
  const chars = Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? 'A');
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}
