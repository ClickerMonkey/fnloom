/**
 * Keys, signatures, codes and tokens for pairing. A system holds an Ed25519 key pair; its public key travels as SPKI
 * DER in base64, a challenge signature is Ed25519 over the UTF-8 bytes of the nonce, in base64. An installed system's
 * key pair is made by the hub and written to its state folder as `key.json` (`StoredKeyPair`), which the SDK's key
 * store reads. Pairing tokens are shown once; only their sha-256 is stored.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';
import { z } from 'zod';

/** The file in a system's state folder that holds its key pair. */
export const KEY_FILE = 'key.json';

/** A key pair as a system keeps it: SPKI and PKCS8 DER, both base64. */
export const StoredKeyPair = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
export type StoredKeyPair = z.infer<typeof StoredKeyPair>;

/** The sha-256 of a string, hex. */
export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A public key's fingerprint: the sha-256 of its DER bytes, hex, in groups of four (what an admin compares). */
export function fingerprint(publicKey: string): string {
  return (sha256Hex(Buffer.from(publicKey, 'base64')).match(/.{4}/g) ?? []).join(':');
}

/** Make a new Ed25519 key pair. */
export function makeKeyPair(): StoredKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** Sign a nonce with a stored private key (what the SDK's key store does). */
export function signNonce(privateKey: string, nonce: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return edSign(null, Buffer.from(nonce, 'utf8'), key).toString('base64');
}

/** Whether `signature` is the holder of `publicKey` signing `nonce`. A malformed key or signature is simply false. */
export function verifyNonce(publicKey: string, nonce: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return edVerify(null, Buffer.from(nonce, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** Whether a string is an Ed25519 public key in SPKI DER base64. */
export function isPublicKey(publicKey: string): boolean {
  try {
    return createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
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
