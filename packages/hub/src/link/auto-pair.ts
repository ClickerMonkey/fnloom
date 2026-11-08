/**
 * Auto pair: an instance the admin let re-pair by itself holds a secret unique to it, and brings it in its `hello`
 * when its key is lost or the hub forgot it. The hub stores only the secret's sha-256, compares in constant time,
 * rate limits attempts per address and per secret, refuses an unknown, expired or revoked secret the same way, and
 * rotates the secret on every use (the new one rides that welcome). The secret is handed out at the instance's welcome,
 * never at pairing, so nothing waits in memory: a welcome to an instance that holds no current secret (its first, or
 * one whose grant was lost) brings a fresh one. The secret before the last rotation stays good only until the instance
 * shows it holds the new one. Secrets and hashes are never logged.
 */
import { timingSafeEqual } from 'node:crypto';
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { limiter, type Limiter, type RateLimitStore } from '@ayepi/rate';
import {
  mintId, type ActorId, type AutoPairChoice, type AutoPairGrant, type AutoPairId, type AutoPairProof, type AutoPairSecret, type AutoPairView,
  type InstanceRef, type SystemName,
} from '@harness/core';
import { allRows } from '../catalog/rows.ts';
import type { HubStore } from '../store/index.ts';
import { randomToken, sha256Hex } from './keys.ts';

/** Random bytes in a secret (base64url-encoded). */
const SECRET_BYTES = 32;

/** What auto pair needs. */
export interface AutoPairOptions {
  readonly store: HubStore;
  readonly log: Logger;
  readonly clock: () => number;
  /** Where attempt counts live (the hub database); in memory when absent. */
  readonly rate?: RateLimitStore | undefined;
  /** Most re-pair attempts per address, and per secret, in `window`. */
  readonly limit: number;
  readonly window: number;
}

/** A secret a hello proved, ready to re-pair its instance once the hello's key signs the challenge. */
export interface AutoPairMatch {
  readonly secret: AutoPairSecret;
  /** Which of the row's hashes it matched: the current one, or the one before the last rotation. */
  readonly matched: 'current' | 'previous';
  /** The hash it matched, checked again at rotation so two sockets can't both spend one secret. */
  readonly hash: string;
}

/** Auto-pair secrets: granted at pairing, checked and rotated at re-pair, listed and revoked by admins. */
export interface AutoPairService {
  /** Let an instance just paired auto pair (revoking its older secrets); its secret goes out in its next welcome. */
  grant(ref: InstanceRef, choice: AutoPairChoice, by: ActorId): Promise<AutoPairView>;
  /**
   * An instance proved its own key and brought `proof` (or none): a fresh secret when it may auto pair but holds no
   * current one; else nothing, dropping the previous hash now that it showed the current one.
   */
  deliver(ref: InstanceRef, proof: AutoPairProof | undefined): Promise<AutoPairGrant | undefined>;
  /** Check a hello's proof for `system`; refused (401, or 429 when rate limited) unless it is good. */
  check(proof: AutoPairProof, system: SystemName, address: string): Promise<AutoPairMatch>;
  /** The instance re-paired: count the use and rotate the secret; the grant goes in the same welcome. */
  rotate(match: AutoPairMatch): Promise<AutoPairGrant>;
  /** The secrets, newest first, optionally of one system: no hashes. */
  list(system?: SystemName): Promise<AutoPairView[]>;
  /** Revoke a secret; whether it was live. */
  revoke(id: AutoPairId, by: ActorId): Promise<boolean>;
}

/** The one refusal for every secret that can't be used, so a caller learns nothing about which it was. */
export function autoPairRefused(): Error {
  return refuse(401, 'AUTO_PAIR_REFUSED', 'the auto-pair secret is unknown, expired or revoked');
}

/** Whether two sha-256 hex digests are equal, in constant time. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** A secret as admins see it: no hashes. */
const viewOf = ({ secretHash: _hash, previousHash: _previous, ...view }: AutoPairSecret): AutoPairView => view;

/** A row with its previous hash dropped. */
const withoutPrevious = ({ previousHash: _previous, ...row }: AutoPairSecret): AutoPairSecret => row;

/** The grant handing out `secret` for a row. */
const grantOf = (row: AutoPairSecret, secret: string): AutoPairGrant => ({ id: row.id, secret, ...(row.expiresAt === undefined ? {} : { expiresAt: row.expiresAt }) });

/** Auto-pair secrets kept in the hub store (`autoPairSecrets`). */
export class StoreAutoPairs implements AutoPairService {
  readonly #options: AutoPairOptions;
  readonly #limiter: Limiter;
  /** The last write queued on each secret: its read-check-write steps run one at a time (the hub is one process). */
  readonly #writes = new Map<AutoPairId, Promise<unknown>>();

  constructor(options: AutoPairOptions) {
    this.#options = options;
    this.#limiter = limiter({
      limit: options.limit, window: options.window, algorithm: 'sliding-window', prefix: 'auto-pair', ...(options.rate === undefined ? {} : { store: options.rate }),
    });
  }

  async grant(ref: InstanceRef, choice: AutoPairChoice, by: ActorId): Promise<AutoPairView> {
    const { store, clock, log } = this.#options;
    const now = clock();
    for (const old of await this.#live(ref.system)) {
      if (old.instance === ref.instance) { await store.table('autoPairSecrets').update(old.id, { revokedAt: now }); }
    }
    const expiresAt = choice.expiresIn === null ? undefined : now + choice.expiresIn;
    // the hash of a secret nobody holds: the instance's next welcome replaces it with one it is given
    const row: AutoPairSecret = {
      id: mintId('autoPair'), system: ref.system, instance: ref.instance, secretHash: sha256Hex(randomToken(SECRET_BYTES)), createdBy: by, createdAt: now, uses: 0,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
    await store.table('autoPairSecrets').insert(row);
    log.info('pairing.auto.granted', { id: row.id, system: ref.system, instance: ref.instance, by, expiresAt });
    return viewOf(row);
  }

  async deliver(ref: InstanceRef, proof: AutoPairProof | undefined): Promise<AutoPairGrant | undefined> {
    const live = (await this.#live(ref.system)).find((row) => row.instance === ref.instance);
    return live === undefined ? undefined : this.#serial(live.id, () => this.#deliver(live.id, proof));
  }

  async #deliver(id: AutoPairId, proof: AutoPairProof | undefined): Promise<AutoPairGrant | undefined> {
    const { store, log } = this.#options;
    const row = await store.table('autoPairSecrets').get(id);
    if (row === undefined || !this.#usable(row)) { return undefined; }
    if (proof?.id === row.id && sameHash(row.secretHash, sha256Hex(proof.secret))) {
      if (row.previousHash !== undefined) { await store.table('autoPairSecrets').put(withoutPrevious(row)); }
      return undefined;
    }
    const secret = randomToken(SECRET_BYTES);
    await store.table('autoPairSecrets').put({ ...withoutPrevious(row), secretHash: sha256Hex(secret) });
    log.info('pairing.auto.delivered', { id: row.id, system: row.system, instance: row.instance });
    return grantOf(row, secret);
  }

  async check(proof: AutoPairProof, system: SystemName, address: string): Promise<AutoPairMatch> {
    const { store, log } = this.#options;
    for (const key of [`address:${address}`, `secret:${proof.id}`]) {
      const result = await this.#limiter.check(key, { now: this.#options.clock() });
      if (!result.allowed) {
        log.warn('pairing.auto.limited', { id: proof.id, system, address });
        throw refuse(429, 'AUTO_PAIR_LIMITED', `too many auto-pair attempts; try again in ${Math.ceil(result.retryAfter / 1000)}s`);
      }
    }
    const row = await store.table('autoPairSecrets').get(proof.id);
    const hash = sha256Hex(proof.secret);
    const matched = row === undefined ? undefined
      : sameHash(row.secretHash, hash) ? 'current'
        : row.previousHash !== undefined && sameHash(row.previousHash, hash) ? 'previous' : undefined;
    if (row === undefined || matched === undefined || row.system !== system || !this.#usable(row)) {
      log.warn('pairing.auto.refused', { id: proof.id, system, address });
      throw autoPairRefused();
    }
    return { secret: row, matched, hash };
  }

  rotate(match: AutoPairMatch): Promise<AutoPairGrant> {
    return this.#serial(match.secret.id, () => this.#rotate(match));
  }

  async #rotate(match: AutoPairMatch): Promise<AutoPairGrant> {
    const { store, clock, log } = this.#options;
    const row = await store.table('autoPairSecrets').get(match.secret.id);
    // revoked, expired or spent by another socket between the hello and the signed challenge
    const still = row === undefined ? undefined : match.matched === 'current' ? row.secretHash : row.previousHash;
    if (row === undefined || still === undefined || !sameHash(still, match.hash) || !this.#usable(row)) { throw autoPairRefused(); }
    const secret = randomToken(SECRET_BYTES);
    const previousHash = match.matched === 'current' ? row.secretHash : row.previousHash;
    const now = clock();
    await store.table('autoPairSecrets').update(row.id, {
      secretHash: sha256Hex(secret), ...(previousHash === undefined ? {} : { previousHash }), lastUsedAt: now, uses: row.uses + 1,
    });
    log.info('pairing.auto.used', { id: row.id, system: row.system, instance: row.instance, uses: row.uses + 1 });
    return grantOf(row, secret);
  }

  async list(system?: SystemName): Promise<AutoPairView[]> {
    const rows = await allRows(this.#options.store.table('autoPairSecrets'), system === undefined ? {} : { system });
    return rows.sort((a, b) => b.createdAt - a.createdAt).map(viewOf);
  }

  async revoke(id: AutoPairId, by: ActorId): Promise<boolean> {
    const { store, clock, log } = this.#options;
    const row = await store.table('autoPairSecrets').get(id);
    if (row === undefined || row.revokedAt !== undefined) { return false; }
    await store.table('autoPairSecrets').update(id, { revokedAt: clock() });
    log.info('pairing.auto.revoked', { id, system: row.system, instance: row.instance, by });
    return true;
  }

  /** Run `step` once the earlier writes to secret `id` are done. */
  async #serial<T>(id: AutoPairId, step: () => Promise<T>): Promise<T> {
    const before = this.#writes.get(id) ?? Promise.resolve();
    const run = before.then(step, step);
    const settled = run.then(() => undefined, () => undefined);
    this.#writes.set(id, settled);
    try {
      return await run;
    } finally {
      if (this.#writes.get(id) === settled) { this.#writes.delete(id); }
    }
  }

  /** Whether a secret can still be used: not revoked, not expired. */
  #usable(row: AutoPairSecret): boolean {
    return row.revokedAt === undefined && (row.expiresAt === undefined || row.expiresAt > this.#options.clock());
  }

  /** A system's secrets that can still be used. */
  async #live(system: SystemName): Promise<AutoPairSecret[]> {
    return (await allRows(this.#options.store.table('autoPairSecrets'), { system })).filter((row) => this.#usable(row));
  }
}
