/**
 * Pairing: a name the hub has never seen (or a known name with a different key) waits for an admin. With a code, the
 * system prints a short code and a link and the admin confirms the code matches; with a one-time token made by an
 * admin, the pairing is approved at once. Either way the hub then tells the waiting socket `paired`, and the system
 * says hello again to get a challenge. Installed systems are paired at install with a key the hub made.
 */
import { reject as refuse, type Peer } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import {
  mintId, type ActorId, type Hello, type HelloReply, type PairingId, type PairingRequest, type PairingToken, type SystemLinkSpec, type SystemName,
  type SystemRecord, type Timestamp,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import { allRows } from '../catalog/rows.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { PairingService } from './index.ts';
import { fingerprint, pairingCode, randomToken, sha256Hex } from './keys.ts';

/** What pairing needs. */
export interface PairingOptions {
  readonly store: HubStore;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly clock: () => number;
  /** The hub's public URL; the approval link is under it. */
  readonly url: string;
  /** How long a pairing request waits for an admin. */
  readonly timeout: number;
}

/** Where a socket asking to pair came from. */
export interface PairingAsker {
  readonly address: string;
  /** The socket's peer, told `paired` once the request is approved. */
  readonly peer: Peer<SystemLinkSpec>;
}

/** Pairing requests and tokens, kept in the hub store. */
export class StorePairingService implements PairingService {
  readonly #options: PairingOptions;
  readonly #waiting = new Map<PairingId, Peer<SystemLinkSpec>>();

  constructor(options: PairingOptions) {
    this.#options = options;
  }

  /** Where an admin approves a pairing. */
  approvalUrl(pairing: PairingId): string {
    return `${this.#options.url.replace(/\/$/, '')}/admin/systems?pairing=${encodeURIComponent(pairing)}`;
  }

  /**
   * Start pairing for a hello the hub can't accept with a challenge. With a valid pairing token it is approved at
   * once; otherwise it waits for an admin with a code (an unexpired request for the same name and key is reused).
   * A token replaces the key of a system already paired only when it was made for that system's name, so a token
   * meant for a new system can't take over an existing one.
   */
  async start(hello: Hello, asker: PairingAsker): Promise<HelloReply> {
    const { store, clock, timeout } = this.#options;
    const now = clock();
    const keyFingerprint = fingerprint(hello.publicKey);
    const existing = await store.table('systems').get(hello.name);
    const replaces = existing !== undefined && existing.keyFingerprint !== keyFingerprint ? { replaces: existing.name } : {};
    const base = {
      name: hello.name, keyFingerprint, publicKey: hello.publicKey, version: hello.version, address: asker.address, createdAt: now, expiresAt: now + timeout, ...replaces,
    };

    if (hello.pairingToken !== undefined) {
      const token = await this.#redeem(hello.pairingToken, hello.name, existing !== undefined);
      const request = await store.table('pairings').insert({ ...base, id: mintId('pairing'), method: 'token', status: 'approved' });
      await this.#pair(request, token.createdBy);
      this.#options.bus.publish('pairing', { pairing: request });
      await this.#supersede(request);
      this.#tellPaired(request.id, asker.peer);
      return { kind: 'pairing', pairing: request.id, url: this.approvalUrl(request.id), expiresAt: request.expiresAt };
    }

    const open = (await allRows(store.table('pairings'), { name: hello.name, status: 'pending' }))
      .find((r) => r.keyFingerprint === keyFingerprint && r.expiresAt > now);
    const request = open ?? await store.table('pairings').insert({ ...base, id: mintId('pairing'), method: 'code', code: pairingCode(), status: 'pending' });
    this.#waiting.set(request.id, asker.peer);
    if (open === undefined) {
      this.#options.bus.publish('pairing', { pairing: request });
      this.#options.log.info('pairing.requested', { pairing: request.id, system: request.name, method: 'code', replaces: request.replaces });
    }
    return { kind: 'pairing', pairing: request.id, ...(request.code === undefined ? {} : { code: request.code }), url: this.approvalUrl(request.id), expiresAt: request.expiresAt };
  }

  async pending(): Promise<PairingRequest[]> {
    const now = this.#options.clock();
    const out: PairingRequest[] = [];
    for (const request of await allRows(this.#options.store.table('pairings'), { status: 'pending' })) {
      if (request.expiresAt > now) { out.push(request); continue; }
      this.#waiting.delete(request.id);
      this.#options.bus.publish('pairing', { pairing: await this.#options.store.table('pairings').update(request.id, { status: 'expired' }) });
    }
    return out;
  }

  async approve(pairing: PairingId, by: ActorId): Promise<SystemRecord> {
    const request = await this.#open(pairing);
    const record = await this.#pair(request, by);
    const approved = await this.#options.store.table('pairings').update(pairing, { status: 'approved' });
    this.#options.bus.publish('pairing', { pairing: approved });
    await this.#supersede(approved);
    const peer = this.#waiting.get(pairing);
    this.#waiting.delete(pairing);
    if (peer !== undefined) { this.#tellPaired(pairing, peer); }
    return record;
  }

  async reject(pairing: PairingId, by: ActorId): Promise<void> {
    await this.#open(pairing);
    const rejected = await this.#options.store.table('pairings').update(pairing, { status: 'rejected' });
    this.#waiting.delete(pairing);
    this.#options.bus.publish('pairing', { pairing: rejected });
    this.#options.log.info('pairing.rejected', { pairing, system: rejected.name, by });
  }

  async createToken(input: { name?: SystemName; expiresIn: number; by: ActorId }): Promise<{ token: string; expiresAt: Timestamp }> {
    const token = randomToken();
    const expiresAt = this.#options.clock() + input.expiresIn;
    const row: PairingToken = {
      id: mintId('pairingToken'), tokenHash: sha256Hex(token), createdBy: input.by, expiresAt, ...(input.name === undefined ? {} : { name: input.name }),
    };
    await this.#options.store.table('pairingTokens').insert(row);
    this.#options.log.info('pairing.token.created', { token: row.id, name: input.name, by: input.by, expiresAt });
    return { token, expiresAt };
  }

  async pairInstalled(system: SystemName, publicKey: string, by: ActorId): Promise<SystemRecord> {
    const existing = await this.#options.store.table('systems').get(system);
    return this.#pair({ name: system, publicKey, keyFingerprint: fingerprint(publicKey), version: existing?.version ?? '0.0.0', address: 'installed' }, by);
  }

  /** A pending, unexpired request, or a refusal. */
  async #open(pairing: PairingId): Promise<PairingRequest> {
    const request = await this.#options.store.table('pairings').get(pairing);
    if (request?.status !== 'pending') { throw refuse(404, 'NO_PAIRING', `no pending pairing ${pairing}`); }
    if (request.expiresAt <= this.#options.clock()) {
      await this.#options.store.table('pairings').update(pairing, { status: 'expired' });
      throw refuse(410, 'PAIRING_EXPIRED', `pairing ${pairing} expired`);
    }
    return request;
  }

  /**
   * A system is paired: its other requests still waiting (an earlier code it never used, say) can't be approved any
   * more, so they end as expired and are announced, and nobody is left asked to approve them.
   */
  async #supersede(paired: PairingRequest): Promise<void> {
    const { store, bus } = this.#options;
    for (const request of await allRows(store.table('pairings'), { name: paired.name, status: 'pending' })) {
      if (request.id === paired.id) { continue; }
      this.#waiting.delete(request.id);
      bus.publish('pairing', { pairing: await store.table('pairings').update(request.id, { status: 'expired' }) });
    }
  }

  /** Check and use up a one-time token. Re-keying a paired system needs a token made for its name. */
  async #redeem(token: string, name: SystemName, paired: boolean): Promise<PairingToken> {
    const tokens = this.#options.store.table('pairingTokens');
    const page = await tokens.find({ where: { tokenHash: sha256Hex(token) }, limit: 1 });
    const found = page.items[0];
    const now = this.#options.clock();
    if (found === undefined || found.usedAt !== undefined || found.expiresAt <= now || (found.name !== undefined && found.name !== name)) {
      throw refuse(401, 'BAD_PAIRING_TOKEN', 'the pairing token is unknown, used, expired or for another name');
    }
    if (paired && found.name === undefined) {
      throw refuse(403, 'TOKEN_NOT_FOR_SYSTEM', `${name} is already paired: replacing its key needs a token made for ${name}`);
    }
    return tokens.update(found.id, { usedAt: now });
  }

  /** Make or re-key a system's row. A re-keyed system keeps its config, switches and actor. */
  async #pair(request: Pick<PairingRequest, 'name' | 'publicKey' | 'keyFingerprint' | 'version' | 'address'>, by: ActorId): Promise<SystemRecord> {
    const { store, clock, log } = this.#options;
    const now = clock();
    const existing = await store.table('systems').get(request.name);
    const actor = existing?.actor ?? (await store.table('actors').insert({
      id: mintId('actor'), kind: 'system', system: request.name, name: request.name, about: `The ${request.name} system.`, createdAt: now, disabled: false,
    })).id;
    const keyed = { keyFingerprint: request.keyFingerprint, publicKey: request.publicKey, pairedAt: now, pairedBy: by, address: request.address };
    const record: SystemRecord = existing === undefined
      ? { name: request.name, description: '', status: 'disconnected', enabled: { functions: true, renderers: true }, version: request.version, manifestHash: '', actor, ...keyed }
      : { ...existing, ...keyed, status: existing.status === 'removed' ? 'disconnected' : existing.status };
    const saved = await store.table('systems').put(record);
    log.info('pairing.paired', { system: request.name, by, replaced: existing !== undefined });
    return saved;
  }

  /** Tell a waiting socket its pairing went through, once the hello reply has gone out. */
  #tellPaired(pairing: PairingId, peer: Peer<SystemLinkSpec>): void {
    setTimeout(() => {
      if (!peer.open) { return; }
      peer.call('paired', { pairing }).catch((error: unknown) => {
        this.#options.log.warn('pairing.notify.failed', { pairing, error: messageOf(error) });
      });
    }, 0);
  }
}
