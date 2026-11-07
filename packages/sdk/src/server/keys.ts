/**
 * A system's signing key pair. The hub pairs a system name with its public key once; after that the system proves it
 * holds the private key by signing a challenge nonce. Ed25519, public key as SPKI DER in base64.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { KeyStore } from './index.ts';

/** A key pair as stored: both halves as DER in base64. */
const StoredKeys = z.object({ publicKey: z.string().min(1), privateKey: z.string().min(1) });
type StoredKeys = z.infer<typeof StoredKeys>;

function newKeys(): StoredKeys {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function privateKeyOf(keys: StoredKeys): KeyObject {
  return createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
}

/** Sign a nonce with an Ed25519 private key; the signature is base64. */
function signNonce(keys: StoredKeys, nonce: string): string {
  return sign(null, Buffer.from(nonce, 'utf8'), privateKeyOf(keys)).toString('base64');
}

/** Check a signature over a nonce against a public key (what the hub does with `prove`). */
export function verifyNonce(publicKey: string, nonce: string, signature: string): boolean {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(nonce, 'utf8'), key, Buffer.from(signature, 'base64'));
}

/** Keys held in memory, made on first use. For tests and throwaway systems. */
export class MemoryKeyStore implements KeyStore {
  #keys: StoredKeys | undefined;

  publicKey(): Promise<string> {
    return Promise.resolve(this.#ensure().publicKey);
  }

  sign(nonce: string): Promise<string> {
    return Promise.resolve(signNonce(this.#ensure(), nonce));
  }

  #ensure(): StoredKeys {
    this.#keys ??= newKeys();
    return this.#keys;
  }
}

/** Keys kept in `key.json` in the system's state folder, made on first use. */
export class FileKeyStore implements KeyStore {
  readonly #file: string;
  #keys: Promise<StoredKeys> | undefined;

  constructor(stateFolder: string) {
    this.#file = join(stateFolder, 'key.json');
  }

  async publicKey(): Promise<string> {
    return (await this.#load()).publicKey;
  }

  async sign(nonce: string): Promise<string> {
    return signNonce(await this.#load(), nonce);
  }

  #load(): Promise<StoredKeys> {
    this.#keys ??= this.#read();
    return this.#keys;
  }

  async #read(): Promise<StoredKeys> {
    try {
      return StoredKeys.parse(JSON.parse(await readFile(this.#file, 'utf8')));
    } catch (error) {
      if (!isMissing(error)) { throw error; }
      const keys = newKeys();
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
