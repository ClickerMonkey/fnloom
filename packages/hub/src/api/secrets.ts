/**
 * Secrets at rest: AES-256-GCM with a key derived from the hub's secret key (`HARNESS_SECRET_KEY`, or the generated
 * one in the keys file). A stored value is `v1.<iv>.<tag>.<ciphertext>` in base64url; the tag makes tampering fail.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mintId, type ActorId, type IdRandom, type SecretId } from '@harness/core';
import type { HubStore } from '../store/index.ts';
import type { SecretVault } from './index.ts';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_LENGTH = 12;

/** Encrypts and decrypts with one key. Its own class so the vault and boot (keys) can share it. */
export class SecretBox {
  readonly #key: Buffer;

  constructor(secret: string) {
    this.#key = createHash('sha256').update(secret).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), body].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
  }

  /** The plain text, or undefined when it was sealed with another key or changed. */
  open(sealed: string): string | undefined {
    const [version, iv, tag, body, ...rest] = sealed.split('.');
    if (version !== VERSION || iv === undefined || tag === undefined || body === undefined || rest.length > 0) { return undefined; }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  }
}

/** Secrets in the hub's `secrets` table, sealed by a `SecretBox`. */
export class AesSecretVault implements SecretVault {
  readonly #store: HubStore;
  readonly #box: SecretBox;
  readonly #clock: () => number;
  readonly #random: IdRandom | undefined;

  constructor(options: { store: HubStore; box: SecretBox; clock: () => number; random?: IdRandom }) {
    this.#store = options.store;
    this.#box = options.box;
    this.#clock = options.clock;
    this.#random = options.random;
  }

  async store(input: { name: string; owner: ActorId; value: string }): Promise<SecretId> {
    const id = mintId('secret', this.#random);
    await this.#store.table('secrets').insert({ id, name: input.name, owner: input.owner, ciphertext: this.#box.seal(input.value), createdAt: this.#clock() });
    return id;
  }

  async reveal(id: SecretId): Promise<string | undefined> {
    const secret = await this.#store.table('secrets').get(id);
    return secret === undefined ? undefined : this.#box.open(secret.ciphertext);
  }

  remove(id: SecretId): Promise<boolean> {
    return this.#store.table('secrets').remove(id);
  }
}
