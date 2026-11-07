/**
 * A system's signing key pair, and the link proof both ends of the link use (the one implementation of it). The hub
 * pairs a system name with its public key once; after that the system proves it holds the private key by signing a
 * challenge nonce. Ed25519; the public key is SPKI DER in base64, the private key PKCS8 DER in base64, and the
 * signature is over the UTF-8 bytes of the nonce, in base64. A pair is kept as `key.json` (`KEY_FILE`) in the
 * system's state folder; the hub writes it there for a system it installs.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { KeyStore } from './index.ts';

/** The file in a system's state folder that holds its key pair. */
export const KEY_FILE = 'key.json';

/** A key pair as stored: SPKI and PKCS8 DER, both base64. */
export const StoredKeyPair = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
export type StoredKeyPair = z.infer<typeof StoredKeyPair>;

/** Make a new Ed25519 key pair. */
export function makeKeyPair(): StoredKeyPair {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Sign a nonce with a stored private key; the signature is base64. */
export function signNonce(privateKey: string, nonce: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return sign(null, Buffer.from(nonce, 'utf8'), key).toString('base64');
}

/** Whether `signature` is the holder of `publicKey` signing `nonce`. A malformed key or signature is simply false. */
export function verifyNonce(publicKey: string, nonce: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(nonce, 'utf8'), key, Buffer.from(signature, 'base64'));
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

/** Keys held in memory, made on first use. For tests and throwaway systems. */
export class MemoryKeyStore implements KeyStore {
  #keys: StoredKeyPair | undefined;

  publicKey(): Promise<string> {
    return Promise.resolve(this.#ensure().publicKey);
  }

  sign(nonce: string): Promise<string> {
    return Promise.resolve(signNonce(this.#ensure().privateKey, nonce));
  }

  #ensure(): StoredKeyPair {
    this.#keys ??= makeKeyPair();
    return this.#keys;
  }
}

/** Keys kept in `key.json` in the system's state folder, made on first use. */
export class FileKeyStore implements KeyStore {
  readonly #file: string;
  #keys: Promise<StoredKeyPair> | undefined;

  constructor(stateFolder: string) {
    this.#file = join(stateFolder, KEY_FILE);
  }

  async publicKey(): Promise<string> {
    return (await this.#load()).publicKey;
  }

  async sign(nonce: string): Promise<string> {
    return signNonce((await this.#load()).privateKey, nonce);
  }

  #load(): Promise<StoredKeyPair> {
    this.#keys ??= this.#read();
    return this.#keys;
  }

  async #read(): Promise<StoredKeyPair> {
    try {
      return StoredKeyPair.parse(JSON.parse(await readFile(this.#file, 'utf8')));
    } catch (error) {
      if (!isMissing(error)) { throw error; }
      const keys = makeKeyPair();
      await mkdir(dirname(this.#file), { recursive: true });
      await writeFile(this.#file, JSON.stringify(keys), { mode: 0o600 });
      return keys;
    }
  }
}

/** Whether a file system error means the file isn't there. */
export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
