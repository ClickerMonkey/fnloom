/**
 * Pairing: an instance the hub has never seen (or a known instance name with a different key) waits for an admin.
 * With a code, the system shows a short code, a link and a QR code of the link (`/pair/:pairing?code=`), and the
 * admin confirms the code matches; with a one-time token made by an admin, the pairing is approved at once. While it
 * waits, the system says what it is (`pairingInfo`: description, instance, config type), so the pairing page can ask
 * for config and the admin can rename the instance as they approve. Either way the hub then tells the waiting socket
 * `paired`, and the system says hello again to get a challenge. Installed instances are paired at install with a key
 * the hub made.
 *
 * An instance is known by its key: a hello whose key matches an instance of the system proves it as that instance,
 * whatever name it asked for (the admin may have renamed it), and its welcome says the name it was paired as.
 *
 * Either way of pairing may grant auto pair (`link/auto-pair.ts`); an instance that later brings its secret with a new
 * key is re-keyed by `autoPaired` once it signs the challenge with that key.
 */
import { reject as refuse, type Peer } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import {
  MAIN_INSTANCE, instanceLabel, isReservedSystemName, mintId, type ActorId, type GinTypeDef, type Hello, type HelloReply, type InstanceRecord,
  type InstanceRef, type Json, type PairingId, type PairingInfo, type PairingRequest, type PairingToken, type SystemLinkSpec, type SystemName,
  type SystemRecord, type Timestamp, type AutoPairChoice, type ConfigPath,
} from '@harness/core';
import type { EventBus } from '../bus.ts';
import { allRows } from '../catalog/rows.ts';
import { messageOf } from '../catalog/scope.ts';
import type { HubStore } from '../store/index.ts';
import type { AutoPairService } from './auto-pair.ts';
import type { PairingChoice, PairingService } from './index.ts';
import { fingerprint, pairingCode, randomToken, sha256Hex } from './keys.ts';
import type { ConfigSecretKeeper } from './config-secrets.ts';
import type { InstanceKeeper } from './status.ts';

/** What pairing needs. */
export interface PairingOptions {
  readonly store: HubStore;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly clock: () => number;
  readonly instances: InstanceKeeper;
  /** Auto-pair secrets, granted when an admin chose auto pair. */
  readonly autoPairs: AutoPairService;
  /** Checks a config value against a config type (the catalog's `check`); the problems, none when it fits. */
  readonly check: (system: SystemName, type: GinTypeDef, value: Json) => Promise<string[]>;
  /** The config type of a system whose contract the hub has (it wins over what a waiting system said). */
  readonly configType: (system: SystemName) => Promise<GinTypeDef | undefined>;
  /** The secret fields of a system's config, from its contract when the hub has it. */
  readonly configSecrets: (system: SystemName) => Promise<readonly ConfigPath[] | undefined>;
  /** Seals the secret fields of a config chosen at approval. */
  readonly secrets: ConfigSecretKeeper;
  /** The hub as phones reach it (`HARNESS_PUBLIC_URL`); unset, links use the address the system dialed. */
  readonly publicUrl?: string | undefined;
  /** How long a pairing request waits for an admin. */
  readonly timeout: number;
}

/** Where a socket asking to pair came from. */
export interface PairingAsker {
  readonly address: string;
  /** The origin the system reached the hub at (`http://192.168.50.112:4300`), for the pairing link. */
  readonly origin: string;
  /** The socket's peer, told `paired` once the request is approved. */
  readonly peer: Peer<SystemLinkSpec>;
}

/** A known instance a hello's key matches, so it gets a challenge rather than a pairing. */
export interface KnownKey {
  readonly instance: InstanceRecord;
}

/** Pairing requests and tokens, kept in the hub store. */
export class StorePairingService implements PairingService {
  readonly #options: PairingOptions;
  /** Sockets waiting on a request, with the origin they dialed (for links made later). */
  readonly #waiting = new Map<PairingId, { peer: Peer<SystemLinkSpec>; origin: string }>();
  /** The secret fields a waiting system named (`PairingInfo.configSecrets`), for a config chosen before its contract comes. */
  readonly #secretPaths = new Map<PairingId, readonly ConfigPath[]>();

  constructor(options: PairingOptions) {
    this.#options = options;
  }

  /** Where an admin approves a pairing: the pairing page, with the code when there is one (so a scan carries it). */
  approvalUrl(request: Pick<PairingRequest, 'id' | 'code'>, origin: string): string {
    const base = (this.#options.publicUrl ?? origin).replace(/\/$/, '');
    return `${base}/pair/${encodeURIComponent(request.id)}${request.code === undefined ? '' : `?code=${encodeURIComponent(request.code)}`}`;
  }

  /** The instance of a system whose paired key a hello carries, if any (an instance is known by its key). */
  async known(hello: Hello): Promise<KnownKey | undefined> {
    const keyFingerprint = fingerprint(hello.publicKey);
    const matching = (await this.#options.instances.of(hello.name)).filter((i) => i.status !== 'removed' && i.keyFingerprint === keyFingerprint);
    const instance = matching.find((i) => i.instance === hello.instance) ?? matching[0];
    return instance === undefined ? undefined : { instance };
  }

  /**
   * Start pairing for a hello the hub can't accept with a challenge. With a valid pairing token it is approved at
   * once; otherwise it waits for an admin with a code (an unexpired request for the same instance and key is reused).
   * A token replaces the key of an instance already paired only when it was made for that system's name, so a token
   * meant for a new system can't take over an existing one. Names the hub keeps for itself are refused.
   */
  async start(hello: Hello, asker: PairingAsker): Promise<HelloReply> {
    if (isReservedSystemName(hello.name)) { throw refuse(403, 'RESERVED_NAME', `${hello.name} is a name the hub keeps for itself`); }
    const { store, clock, timeout } = this.#options;
    const now = clock();
    const keyFingerprint = fingerprint(hello.publicKey);
    const rekeys = await this.#rekeys({ system: hello.name, instance: hello.instance }, keyFingerprint);
    const base = {
      name: hello.name, instance: hello.instance, keyFingerprint, publicKey: hello.publicKey, version: hello.version, address: asker.address,
      createdAt: now, expiresAt: now + timeout, ...(rekeys ? { replaces: hello.name } : {}),
    };

    if (hello.pairingToken !== undefined) {
      const token = await this.#redeem(hello.pairingToken, hello.name, rekeys);
      const request = await store.table('pairings').insert({ ...base, id: mintId('pairing'), method: 'token', status: 'approved' });
      const record = await this.#pair(request, token.createdBy, {});
      if (token.autoPair !== undefined) { await this.#options.autoPairs.grant(record, token.autoPair, token.createdBy); }
      this.#options.bus.publish('pairing', { pairing: request });
      await this.#supersede(request);
      this.#tellPaired(request.id, asker.peer);
      return { kind: 'pairing', pairing: request.id, url: this.approvalUrl(request, asker.origin), expiresAt: request.expiresAt };
    }

    const open = (await allRows(store.table('pairings'), { name: hello.name, status: 'pending' }))
      .find((r) => r.keyFingerprint === keyFingerprint && (r.instance ?? MAIN_INSTANCE) === hello.instance && r.expiresAt > now);
    const request = open ?? await store.table('pairings').insert({ ...base, id: mintId('pairing'), method: 'code', code: pairingCode(), status: 'pending' });
    this.#waiting.set(request.id, { peer: asker.peer, origin: asker.origin });
    if (open === undefined) {
      this.#options.bus.publish('pairing', { pairing: request });
      this.#options.log.info('pairing.requested', { pairing: request.id, system: request.name, instance: hello.instance, method: 'code', replaces: request.replaces });
    }
    return {
      kind: 'pairing', pairing: request.id, ...(request.code === undefined ? {} : { code: request.code }),
      url: this.approvalUrl(request, asker.origin), expiresAt: request.expiresAt,
    };
  }

  /**
   * What a waiting system says about itself, kept on its request for the pairing page. Only the socket that started
   * the pairing may say it, and only while the request waits. The instance it names may differ from its hello's, so
   * whether approving replaces a paired instance's key (`replaces`) is worked out again for that name.
   */
  async info(info: PairingInfo, peer: Peer<SystemLinkSpec>): Promise<PairingRequest> {
    const waiting = this.#waiting.get(info.pairing);
    if (waiting?.peer !== peer) { throw refuse(403, 'NOT_YOUR_PAIRING', 'only the socket that started a pairing may describe it'); }
    const { replaces: _before, ...request } = await this.#open(info.pairing);
    const rekeys = await this.#rekeys({ system: request.name, instance: info.instance }, request.keyFingerprint);
    if (info.configSecrets !== undefined) { this.#secretPaths.set(info.pairing, info.configSecrets); }
    const updated = await this.#options.store.table('pairings').put({
      ...request, description: info.description, instance: info.instance, ...(info.configType === undefined ? {} : { configType: info.configType }),
      ...(rekeys ? { replaces: request.name } : {}),
    });
    this.#options.bus.publish('pairing', { pairing: updated });
    return updated;
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

  async get(pairing: PairingId): Promise<PairingRequest> {
    const request = await this.#options.store.table('pairings').get(pairing);
    if (request === undefined) { throw refuse(404, 'NO_PAIRING', `no pairing ${pairing}`); }
    if (request.status === 'pending' && request.expiresAt <= this.#options.clock()) {
      this.#waiting.delete(pairing);
      return this.#options.store.table('pairings').update(pairing, { status: 'expired' });
    }
    return request;
  }

  async approve(pairing: PairingId, by: ActorId, choice: PairingChoice = {}): Promise<InstanceRecord> {
    const request = await this.#open(pairing);
    const record = await this.#pair(request, by, choice);
    if (choice.autoPair !== undefined) { await this.#options.autoPairs.grant(record, choice.autoPair, by); }
    const approved = await this.#options.store.table('pairings').update(pairing, { status: 'approved', instance: record.instance });
    this.#options.bus.publish('pairing', { pairing: approved });
    await this.#supersede(approved);
    const waiting = this.#waiting.get(pairing);
    this.#waiting.delete(pairing);
    if (waiting !== undefined) { this.#tellPaired(pairing, waiting.peer); }
    return record;
  }

  async reject(pairing: PairingId, by: ActorId): Promise<void> {
    await this.#open(pairing);
    const rejected = await this.#options.store.table('pairings').update(pairing, { status: 'rejected' });
    this.#waiting.delete(pairing);
    this.#options.bus.publish('pairing', { pairing: rejected });
    this.#options.log.info('pairing.rejected', { pairing, system: rejected.name, by });
  }

  async createToken(input: { name?: SystemName; expiresIn: number; autoPair?: AutoPairChoice; by: ActorId }): Promise<{ token: string; expiresAt: Timestamp }> {
    const token = randomToken();
    const expiresAt = this.#options.clock() + input.expiresIn;
    const row: PairingToken = {
      id: mintId('pairingToken'), tokenHash: sha256Hex(token), createdBy: input.by, expiresAt, ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.autoPair === undefined ? {} : { autoPair: input.autoPair }),
    };
    await this.#options.store.table('pairingTokens').insert(row);
    this.#options.log.info('pairing.token.created', { token: row.id, name: input.name, by: input.by, expiresAt, autoPair: input.autoPair !== undefined });
    return { token, expiresAt };
  }

  async pairInstalled(ref: InstanceRef, publicKey: string, version: string, by: ActorId): Promise<InstanceRecord> {
    // an admin installing an instance chose its name, so a key it had before is replaced
    return this.#pair({ name: ref.system, instance: ref.instance, publicKey, keyFingerprint: fingerprint(publicKey), version, address: 'installed', replaces: ref.system }, by, {});
  }

  /**
   * An instance brought a good auto-pair secret and signed the challenge with the key from its hello: that key becomes
   * its key (the instance is made again if the hub forgot it), as the admin who granted the secret.
   */
  async autoPaired(ref: InstanceRef, hello: Hello, address: string, by: ActorId): Promise<InstanceRecord> {
    const keyFingerprint = fingerprint(hello.publicKey);
    return this.#pair({ name: ref.system, instance: ref.instance, publicKey: hello.publicKey, keyFingerprint, version: hello.version, address, replaces: ref.system }, by, {});
  }

  /** Whether pairing `keyFingerprint` as `ref` would replace the key of an instance paired there now. */
  async #rekeys(ref: InstanceRef, keyFingerprint: string): Promise<boolean> {
    const existing = await this.#options.instances.get(ref);
    return existing !== undefined && existing.status !== 'removed' && existing.keyFingerprint !== keyFingerprint;
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
   * An instance is paired: its other requests still waiting (an earlier code it never used, say) can't be approved any
   * more, so they end as expired and are announced, and nobody is left asked to approve them.
   */
  async #supersede(paired: PairingRequest): Promise<void> {
    const { store, bus } = this.#options;
    const instance = paired.instance ?? MAIN_INSTANCE;
    for (const request of await allRows(store.table('pairings'), { name: paired.name, status: 'pending' })) {
      if (request.id === paired.id || (request.instance ?? MAIN_INSTANCE) !== instance) { continue; }
      this.#waiting.delete(request.id);
      bus.publish('pairing', { pairing: await store.table('pairings').update(request.id, { status: 'expired' }) });
    }
  }

  /** Check and use up a one-time token. Re-keying a paired instance needs a token made for its system's name. */
  async #redeem(token: string, name: SystemName, rekeys: boolean): Promise<PairingToken> {
    const tokens = this.#options.store.table('pairingTokens');
    const page = await tokens.find({ where: { tokenHash: sha256Hex(token) }, limit: 1 });
    const found = page.items[0];
    const now = this.#options.clock();
    if (found === undefined || found.usedAt !== undefined || found.expiresAt <= now || (found.name !== undefined && found.name !== name)) {
      throw refuse(401, 'BAD_PAIRING_TOKEN', 'the pairing token is unknown, used, expired or for another name');
    }
    if (rekeys && found.name === undefined) {
      throw refuse(403, 'TOKEN_NOT_FOR_SYSTEM', `${name} is already paired: replacing its key needs a token made for ${name}`);
    }
    return tokens.update(found.id, { usedAt: now });
  }

  /**
   * Make or re-key an instance (and its system's row the first time). A re-keyed instance keeps its config and folders;
   * a system keeps its switches and actor. A config chosen at approval is checked against the system's config type
   * (the contract's when the hub has it, else what the waiting system said) and set as version 1, so the welcome
   * carries it.
   */
  async #pair(
    request: Pick<PairingRequest, 'name' | 'publicKey' | 'keyFingerprint' | 'version' | 'address'> & Partial<Pick<PairingRequest, 'id' | 'instance' | 'configType' | 'replaces'>>,
    by: ActorId,
    choice: PairingChoice,
  ): Promise<InstanceRecord> {
    const { clock, log, instances } = this.#options;
    const ref: InstanceRef = { system: request.name, instance: choice.instance ?? request.instance ?? MAIN_INSTANCE };
    const now = clock();
    const existing = await instances.get(ref);
    // handing a paired instance this key needs the admin to have been shown it (`replaces`) for that very name
    const renamedOnto = choice.instance !== undefined && choice.instance !== (request.instance ?? MAIN_INSTANCE);
    const shown = request.replaces !== undefined && !renamedOnto;
    if (!shown && existing !== undefined && existing.status !== 'removed' && existing.keyFingerprint !== request.keyFingerprint) {
      throw refuse(409, 'INSTANCE_TAKEN', `${instanceLabel(ref)} is another machine's instance: pick a name of its own`);
    }
    const paths = await this.#options.configSecrets(ref.system) ?? (request.id === undefined ? undefined : this.#secretPaths.get(request.id)) ?? [];
    const sealing = choice.config === undefined ? undefined : await this.#options.secrets.seal(ref, choice.config, existing?.config?.value, paths, by);
    if (sealing !== undefined) { await this.#checked(ref, sealing.plain, request.configType); }
    const config = sealing?.sealed;
    await this.#system(request.name, request.version, now);
    const keyed = { keyFingerprint: request.keyFingerprint, publicKey: request.publicKey, pairedAt: now, pairedBy: by, address: request.address };
    const fresh: InstanceRecord = { ...ref, description: '', status: 'disconnected', version: request.version, manifestHash: '', ...keyed };
    const configured = config === undefined ? {} : { config: { value: config, version: (existing?.config?.version ?? 0) + 1, setBy: by, setAt: now } };
    const saved = await instances.sync(ref, (current) => ({
      ...current, ...keyed, ...configured, status: current.status === 'removed' ? 'disconnected' : current.status,
    }), fresh);
    await sealing?.release();
    if (request.id !== undefined) { this.#secretPaths.delete(request.id); }
    log.info('pairing.paired', { system: ref.system, instance: ref.instance, by, replaced: existing !== undefined, configured: config !== undefined });
    return saved;
  }

  /** A config value checked against the system's config type, or a refusal listing the problems. */
  async #checked(ref: InstanceRef, value: Json, waitingType: GinTypeDef | undefined): Promise<Json> {
    const type = await this.#options.configType(ref.system) ?? waitingType;
    const problems = type === undefined
      ? [`${ref.system} hasn't said what its config is yet, so none can be set as it pairs`]
      : await this.#options.check(ref.system, type, value);
    if (problems.length > 0) { throw refuse(422, 'BAD_CONFIG', `the config for ${instanceLabel(ref)} doesn't fit: ${problems.join('; ')}`); }
    return value;
  }

  /** The system's row, made (with its actor) the first time an instance of it is paired. */
  async #system(name: SystemName, version: string, now: number): Promise<SystemRecord> {
    const { store } = this.#options;
    const existing = await store.table('systems').get(name);
    if (existing !== undefined) { return existing; }
    const actor = (await store.table('actors').insert({
      id: mintId('actor'), kind: 'system', system: name, name, about: `The ${name} system.`, createdAt: now, disabled: false,
    })).id;
    return store.table('systems').put({ name, description: '', status: 'disconnected', enabled: { functions: true, renderers: true }, version, manifestHash: '', actor });
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
