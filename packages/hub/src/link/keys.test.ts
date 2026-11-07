import { describe, expect, it } from 'vitest';
import { fingerprint, isPublicKey, makeKeyPair, pairingCode, randomToken, sha256Hex, signNonce, verifyNonce } from './keys.ts';

describe('pairing keys', () => {
  it('signs and verifies a nonce with an Ed25519 pair', () => {
    const keys = makeKeyPair();
    const signature = signNonce(keys.privateKey, 'nonce-1');
    expect(verifyNonce(keys.publicKey, 'nonce-1', signature)).toBe(true);
    expect(verifyNonce(keys.publicKey, 'nonce-2', signature)).toBe(false);
    expect(verifyNonce(makeKeyPair().publicKey, 'nonce-1', signature)).toBe(false);
    expect(verifyNonce('not a key', 'nonce-1', signature)).toBe(false);
  });

  it('knows an Ed25519 public key and fingerprints it', () => {
    const { publicKey } = makeKeyPair();
    expect(isPublicKey(publicKey)).toBe(true);
    expect(isPublicKey('AAAA')).toBe(false);
    expect(fingerprint(publicKey)).toMatch(/^([0-9a-f]{4}:){15}[0-9a-f]{4}$/);
    expect(fingerprint(publicKey)).toBe(fingerprint(publicKey));
  });

  it('makes codes and tokens that are hard to mistake or guess', () => {
    expect(pairingCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(randomToken()).toMatch(/^[\w-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
    expect(sha256Hex('a')).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });
});
