/**
 * Per-person connections on the hub store. Connecting makes a `pending` row and asks the system where to send the
 * person, with a signed `state` naming the row; the redirect comes back to `/connect/callback`, the state is checked,
 * the system turns the provider's answer into an account and credentials, and the credentials become a secret owned
 * by the person. A connection's fns act as its owner, for them and for the people it is shared with.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { reject } from '@ayepi/core';
import { z } from 'zod';
import type { Logger } from '@ayepi/log';
import {
  ConnectionId, Json, mintId, qualify, splitName, type ActorId, type ConnectDecl, type ConnectFlow, type ConnectionChange, type ConnectionFnOption, type ConnectionUpdate,
  type ConnectionView, type ConnectPage, type ConnectResult, type IdRandom, type InstanceConnect, type InstanceName, type RunConnection, type SecretId, type SystemName,
  type UserConnection,
} from '@harness/core';
import { fnOwner } from '../catalog/catalog.ts';
import type { ConnectionGate, FnConnection, FnRef } from '../access/index.ts';
import { letsIn } from '../access/scope.ts';
import type { SecretVault } from '../api/index.ts';
import type { EventBus } from '../bus.ts';
import type { Catalog } from '../catalog/index.ts';
import { allRows } from '../store/rows.ts';
import type { LinkService, SystemConnection } from '../link/index.ts';
import type { HubStore } from '../store/index.ts';
import type { ConnectionsEnv } from './env.ts';
import type { CallbackAnswer, ConnectBinding, ConnectionService, ConnectStart } from './index.ts';

/** Where providers send people back to, under the hub's public URL. */
export const CONNECT_CALLBACK_PATH = '/connect/callback';

/** What the connection service uses. */
export interface ConnectionDeps {
  readonly store: HubStore;
  readonly catalog: Pick<Catalog, 'manifest' | 'check' | 'fn'>;
  readonly link: Pick<LinkService, 'connection'>;
  readonly secrets: SecretVault;
  readonly bus: Pick<EventBus, 'publish'>;
  readonly log: Logger;
  readonly clock: () => number;
  readonly random?: IdRandom;
  readonly settings: ConnectionsEnv;
  /** The hub's public URL (`HARNESS_URL`): the redirect is under it. */
  readonly hubUrl: string;
  /** Signs connect states; a new one each start (a person mid-sign-in across a restart connects again). */
  readonly stateKey?: Buffer;
}

/** The view of a connection a page shows (no credentials). */
export function connectionView(row: UserConnection): ConnectionView {
  const { credentials: _credentials, ...view } = row;
  return view;
}

/** The switches of a fn of an instance-scoped system that neither the connection nor the declaration names. */
const ON_WITHOUT_ASKING: ConnectionFnOption = { on: true, ask: false };

/** How one connection is made: the flow, and for an instance whether one admin connection serves everyone. */
interface ConnectHow {
  readonly flow: ConnectFlow;
  readonly instance?: InstanceName | undefined;
  readonly share: boolean;
}

/** The key of an instance in the gate's map. */
function instanceKey(system: string, instance: InstanceName): string {
  return `${system}/${instance}`;
}

/** Connections over the store. */
export class StoreConnectionService implements ConnectionService {
  readonly #deps: ConnectionDeps;
  readonly #key: Buffer;
  /** Sign-ins whose callback is being finished now. */
  readonly #claimed = new Set<ConnectionId>();
  /** The last refresh queued for each connection. */
  readonly #refreshing = new Map<ConnectionId, Promise<void>>();

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
    this.#key = deps.stateKey ?? randomBytes(32);
  }

  get #redirect(): string {
    return new URL(CONNECT_CALLBACK_PATH, this.#deps.hubUrl).toString();
  }

  async pages(asker: ActorId): Promise<ConnectPage[]> {
    const pages: ConnectPage[] = [];
    for (const { system, decl, ready } of await this.#decls()) {
      const connections = await allRows(this.#table(), { where: { owner: asker, system } });
      const instances = decl.scope === 'instance' ? await this.#instancePages(system) : undefined;
      pages.push({ system, decl, ready, connections: connections.sort((a, b) => b.createdAt - a.createdAt).map(connectionView), ...(instances === undefined ? {} : { instances }) });
    }
    return pages;
  }

  async connect(asker: ActorId, system: SystemName, form?: Json, instance?: InstanceName): Promise<ConnectStart> {
    const how = await this.#how(asker, system, await this.#decl(system), instance);
    const now = this.#deps.clock();
    const row: UserConnection = {
      id: mintId('connection', this.#deps.random), system, ...(how.instance === undefined ? {} : { instance: how.instance }), owner: asker, status: 'pending', settings: {}, fns: {},
      // a shared instance connection (an admin's sign-in) serves everyone
      share: how.share ? { visibility: 'public', with: [] } : { visibility: 'private', with: [] }, createdAt: now, updatedAt: now,
    };
    const at = how.instance === undefined ? {} : { instance: how.instance };
    if (how.flow.flow === 'form') {
      if (form === undefined) { throw reject(422, 'FORM_NEEDED', `connecting to ${system} needs its form filled in`); }
      const problems = await this.#deps.catalog.check(system, how.flow.form, form);
      if (problems.length > 0) { throw reject(422, 'INVALID_FORM', problems.join('; ')); }
      await this.#begin(row);
      try {
        const result = await this.#call(system, how.instance, (c, signal) => c.peer.call('connectFinish', { connection: row.id, owner: asker, ...at, redirect: this.#redirect, answer: { form } }, { signal }));
        return { connection: connectionView(await this.#finish(row, result)) };
      } catch (error) {
        await this.#table().remove(row.id);
        throw error;
      }
    }
    await this.#begin(row);
    const window = this.#deps.settings.HARNESS_CONNECT_WINDOW;
    const browser = randomBytes(24).toString('base64url');
    const state = this.#sign(row.id, now + window, sha256(browser));
    try {
      const { url } = await this.#call(system, how.instance, (c, signal) => c.peer.call('connectStart', { connection: row.id, owner: asker, ...at, redirect: this.#redirect, state }, { signal }));
      const binding: ConnectBinding = { cookie: bindingCookie(row.id), value: browser, maxAge: Math.ceil(window / 1000), secure: this.#redirect.startsWith('https:') };
      return { url, binding };
    } catch (error) {
      await this.#table().remove(row.id);
      throw error;
    }
  }

  async callback(params: Readonly<Record<string, string>>, cookies: Readonly<Record<string, string>>): Promise<CallbackAnswer> {
    const state = this.#verify(params['state']);
    const row = state === undefined ? undefined : await this.#table().get(state.connection);
    if (state === undefined || row?.status !== 'pending' || this.#claimed.has(row.id)) {
      return { system: row?.system, problem: 'This sign-in link has expired or was already used. Connect again.' };
    }
    const cookie = bindingCookie(row.id);
    const browser = cookies[cookie];
    if (browser === undefined || !sameText(sha256(browser), state.browser)) {
      // another browser came back with this state (a consent link passed on): the starter's sign-in stays open
      this.#deps.log.warn('connection.wrong-browser', { connection: row.id, system: row.system });
      return { system: row.system, problem: 'This sign-in was started in another browser. Connect again from this one.' };
    }
    // claimed before any wait, so a replayed callback can't finish (or fail) the same sign-in twice
    this.#claimed.add(row.id);
    try {
      const problem = await this.#complete(row, params);
      return { system: row.system, problem, clear: cookie };
    } finally {
      this.#claimed.delete(row.id);
    }
  }

  /** Finish a claimed sign-in: the provider's error, or the system's answer to its code. The problem, if any. */
  async #complete(row: UserConnection, params: Readonly<Record<string, string>>): Promise<string | undefined> {
    const refused = params['error'];
    if (refused !== undefined) {
      const problem = params['error_description'] ?? refused;
      await this.#finish(row, { problem });
      return problem;
    }
    let result: ConnectResult;
    try {
      result = await this.#call(row.system, row.instance, (c, signal) => c.peer.call('connectFinish', {
        connection: row.id, owner: row.owner, ...(row.instance === undefined ? {} : { instance: row.instance }), redirect: this.#redirect, answer: { params: { ...params } },
      }, { signal }));
    } catch (error) {
      result = { problem: error instanceof Error ? error.message : String(error) };
    }
    return (await this.#finish(row, result)).problem;
  }

  async update(asker: ActorId, change: ConnectionChange): Promise<ConnectionView> {
    const row = await this.#own(asker, change.connection);
    const decl = await this.#decl(row.system);
    if (change.settings !== undefined) {
      const problems = await this.#deps.catalog.check(row.system, decl.settings, change.settings);
      if (problems.length > 0) { throw reject(422, 'INVALID_SETTINGS', problems.join('; ')); }
    }
    const unknown = await this.#unknownFns(row, decl, Object.keys(change.fns ?? {}));
    if (unknown.length > 0) { throw reject(422, 'UNKNOWN_FN', `${row.system} has no per-person fn ${unknown.join(', ')}`); }
    const updated = await this.#table().update(row.id, {
      ...(change.settings === undefined ? {} : { settings: change.settings }),
      ...(change.fns === undefined ? {} : { fns: { ...row.fns, ...change.fns } }),
      ...(change.share === undefined ? {} : { share: { visibility: change.share.visibility, with: change.share.visibility === 'shared' ? [...new Set(change.share.with)] : [] } }),
      updatedAt: this.#deps.clock(),
    });
    this.#changed();
    return connectionView(updated);
  }

  async disconnect(asker: ActorId, connection: ConnectionId): Promise<boolean> {
    const row = await this.#own(asker, connection);
    const credentials = await this.#credentials(row);
    if (credentials !== undefined && this.#deps.link.connection(row.system, row.instance) !== undefined) {
      // the provider revokes what it can; the hub forgets the connection whether or not it could
      await this.#call(row.system, row.instance, (c, signal) => c.peer.call('disconnect', { id: row.id, owner: row.owner, credentials }, { signal }))
        .catch((error: unknown) => { this.#deps.log.warn('connection.revoke-failed', { connection: row.id, system: row.system, error: error instanceof Error ? error.message : String(error) }); });
    }
    if (row.credentials !== undefined) await this.#deps.secrets.remove(row.credentials);
    const removed = await this.#table().remove(row.id);
    this.#changed();
    return removed;
  }

  refreshed(system: SystemName, update: ConnectionUpdate, instance?: InstanceName): Promise<void> {
    // one at a time per connection: each reads the secret the one before stored, so every replaced secret is removed
    const before = this.#refreshing.get(update.connection) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(() => this.#refresh(system, update, instance));
    const tail = next.catch(() => undefined);
    this.#refreshing.set(update.connection, tail);
    void tail.then(() => { if (this.#refreshing.get(update.connection) === tail) this.#refreshing.delete(update.connection); });
    return next;
  }

  async #refresh(system: SystemName, update: ConnectionUpdate, instance: InstanceName | undefined): Promise<void> {
    const row = await this.#table().get(update.connection);
    // an instance-scoped connection is refreshed only by its own instance
    if (row?.system !== system || (row.instance !== undefined && row.instance !== instance)) { throw reject(404, 'NOT_FOUND', `${system} has no connection ${update.connection}`); }
    if ('expired' in update.update) {
      await this.#table().update(row.id, { status: 'expired', problem: update.update.expired, updatedAt: this.#deps.clock() });
    } else {
      const secret = await this.#store(row, update.update.credentials);
      await this.#table().update(row.id, {
        status: 'connected', credentials: secret, problem: undefined, updatedAt: this.#deps.clock(),
        ...(update.update.expiresAt === undefined ? {} : { expiresAt: update.update.expiresAt }),
      });
      if (row.credentials !== undefined) await this.#deps.secrets.remove(row.credentials);
    }
    this.#deps.log.info('connection.refreshed', { connection: row.id, system, expired: 'expired' in update.update });
    this.#changed();
  }

  async gate(actor: ActorId, groups: ReadonlySet<ActorId>): Promise<ConnectionGate> {
    const decls = new Map<string, { system: SystemName; decl: ConnectDecl }>((await this.#decls()).map((entry) => [entry.system, entry]));
    // the database keeps to connected rows of systems that connect; who may use each (its JSON sharing) is checked here
    const usable = (await allRows(this.#table(), { where: { status: 'connected', system: { in: [...decls.values()].map((entry) => entry.system) } } }))
      .filter((row) => letsIn({ owner: row.owner, ...row.share }, actor, groups))
      .sort((a, b) => (a.owner === actor ? 0 : 1) - (b.owner === actor ? 0 : 1) || b.createdAt - a.createdAt);
    const connects = await this.#instanceConnects([...decls.values()].filter((entry) => entry.decl.scope === 'instance').map((entry) => entry.system));
    return {
      fn: (record: FnRef): FnConnection | undefined => {
        const entry = decls.get(record.system);
        const local = splitName(record.name).local;
        if (entry?.decl.scope === 'instance') {
          // every fn that runs on an instance people connect to acts as the person
          const instance = record.decl?.routing?.to === 'instance' ? record.decl.routing.instance : undefined;
          if (instance === undefined || connects.get(instanceKey(record.system, instance))?.flow === undefined) return undefined;
          const connection = usable.find((row) => row.system === record.system && row.instance === instance);
          if (connection === undefined) return { state: 'missing', page: entry.decl.title };
          const option = connection.fns[local] ?? entry.decl.fns[local] ?? entry.decl.defaults ?? ON_WITHOUT_ASKING;
          return option.on ? { state: 'ready', connection, option } : { state: 'off' };
        }
        const declared = entry?.decl.fns[local];
        if (entry === undefined || declared === undefined) return undefined;
        const connection = usable.find((row) => row.system === record.system && row.instance === undefined);
        if (connection === undefined) return { state: 'missing', page: entry.decl.title };
        const option = connection.fns[local] ?? declared;
        return option.on ? { state: 'ready', connection, option } : { state: 'off' };
      },
    };
  }

  async forRun(connection: UserConnection): Promise<RunConnection> {
    const credentials = await this.#credentials(connection);
    if (credentials === undefined) { throw reject(409, 'NOT_CONNECTED', `the ${connection.system} connection has no credentials; connect again`); }
    return { id: connection.id, owner: connection.owner, credentials, settings: connection.settings };
  }

  #table() {
    return this.#deps.store.table('connections');
  }

  /** Store a new pending row, dropping the person's earlier sign-ins to the same system that never came back. */
  async #begin(row: UserConnection): Promise<void> {
    for (const stale of await allRows(this.#table(), { where: { owner: row.owner, system: row.system, status: 'pending' } })) {
      if (stale.instance !== row.instance) continue;
      await this.#table().remove(stale.id);
    }
    await this.#table().insert(row);
  }

  #changed(): void {
    this.#deps.bus.publish('capabilities.changed', {});
  }

  /** Every system with a `connect` declaration, and whether it can take connections now. */
  async #decls(): Promise<Array<{ system: SystemName; decl: ConnectDecl; ready: boolean }>> {
    const out: Array<{ system: SystemName; decl: ConnectDecl; ready: boolean }> = [];
    for (const record of await allRows(this.#deps.store.table('systems'))) {
      if (record.status === 'removed') continue;
      const decl = (await this.#deps.catalog.manifest(record.name))?.connect;
      if (decl !== undefined) out.push({ system: record.name, decl, ready: record.status === 'connected' });
    }
    return out.sort((a, b) => a.decl.title.localeCompare(b.decl.title));
  }

  async #decl(system: SystemName): Promise<ConnectDecl> {
    const decl = (await this.#deps.catalog.manifest(system))?.connect;
    if (decl === undefined) { throw reject(404, 'NOT_FOUND', `${system} has no per-person connections`); }
    return decl;
  }

  /**
   * How a connection to a system is made: its declared flow, or for an instance-scoped system the named instance's own
   * (`InstanceConnect`). Refused when the instance is missing, needs no connection, or is shared and the asker is no admin.
   */
  async #how(asker: ActorId, system: SystemName, decl: ConnectDecl, instance: InstanceName | undefined): Promise<ConnectHow> {
    if (decl.scope !== 'instance') {
      if (instance !== undefined) { throw reject(422, 'NOT_PER_INSTANCE', `${system} connects once for the whole system, not per instance`); }
      return { flow: decl.how, share: false };
    }
    if (instance === undefined) { throw reject(422, 'INSTANCE_NEEDED', `say which ${system} instance to connect to`); }
    const record = await this.#deps.store.table('instances').get({ system, instance });
    if (record === undefined || record.status === 'removed') { throw reject(404, 'NOT_FOUND', `${system} has no instance ${instance}`); }
    const flow = record.connect?.flow;
    if (flow === undefined) { throw reject(422, 'NO_CONNECTION_NEEDED', `${system}/${instance} needs no connection`); }
    const share = record.connect?.share === true;
    const actor = share ? await this.#deps.store.table('actors').get(asker) : undefined;
    if (share && (actor?.kind !== 'user' || actor.role !== 'admin')) {
      throw reject(403, 'ADMIN_CONNECTS', `an admin connects ${system}/${instance} once, for everyone`);
    }
    return { flow, instance, share };
  }

  /** The instances of an instance-scoped system people connect to (those that said how), for its page. */
  async #instancePages(system: SystemName): Promise<NonNullable<ConnectPage['instances']>> {
    const rows = await allRows(this.#deps.store.table('instances'), { where: { system } });
    return rows.flatMap((row) => (row.status === 'removed' || row.connect?.flow === undefined ? []
      : [{ instance: row.instance, label: row.description === '' ? row.instance : row.description, connect: row.connect }]));
  }

  /** How people connect to each instance of these systems (`system/instance` to its `InstanceConnect`). */
  async #instanceConnects(systems: readonly SystemName[]): Promise<Map<string, InstanceConnect>> {
    const out = new Map<string, InstanceConnect>();
    for (const system of systems) {
      for (const row of await allRows(this.#deps.store.table('instances'), { where: { system } })) {
        if (row.status !== 'removed' && row.connect !== undefined) out.set(instanceKey(system, row.instance), row.connect);
      }
    }
    return out;
  }

  /** The fn names a connection's switches may not name: not per-person fns of its system (per instance: not its instance's fns). */
  async #unknownFns(row: UserConnection, decl: ConnectDecl, names: readonly string[]): Promise<string[]> {
    if (decl.scope !== 'instance') return names.filter((fn) => !(fn in decl.fns));
    const unknown: string[] = [];
    for (const name of names) {
      const record = await this.#deps.catalog.fn(qualify(row.system, name));
      if (record === undefined || fnOwner(record.decl) !== row.instance) unknown.push(name);
    }
    return unknown;
  }

  async #own(asker: ActorId, id: ConnectionId): Promise<UserConnection> {
    const row = await this.#table().get(id);
    if (row?.owner !== asker) { throw reject(404, 'NOT_FOUND', `you have no connection ${id}`); }
    return row;
  }

  async #call<T>(system: SystemName, instance: InstanceName | undefined, call: (connection: SystemConnection, signal: AbortSignal) => Promise<T>): Promise<T> {
    const connection = this.#deps.link.connection(system, instance);
    const which = instance === undefined ? `the ${system} system` : `${system}/${instance}`;
    if (connection === undefined) { throw reject(503, 'SYSTEM_OFFLINE', `${which} is not connected; try again when it is`); }
    return call(connection, AbortSignal.any([connection.signal, AbortSignal.timeout(this.#deps.settings.HARNESS_CONNECT_TIMEOUT)]));
  }

  /** Record what the system answered: the account and credentials as a secret, or the problem. */
  async #finish(row: UserConnection, result: ConnectResult): Promise<UserConnection> {
    const now = this.#deps.clock();
    if ('problem' in result) {
      this.#deps.log.info('connection.failed', { connection: row.id, system: row.system });
      const failed = await this.#table().update(row.id, { status: 'failed', problem: result.problem, updatedAt: now });
      this.#changed();
      return failed;
    }
    const secret = await this.#store(row, result.credentials);
    const connected = await this.#table().update(row.id, {
      status: 'connected', account: result.account, credentials: secret, problem: undefined, updatedAt: now,
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
    }).catch(async (error: unknown) => {
      // the row went (a new sign-in replaced it): its secret must not outlive it
      await this.#deps.secrets.remove(secret);
      throw error;
    });
    this.#deps.log.info('connection.connected', { connection: row.id, system: row.system });
    this.#changed();
    return connected;
  }

  #store(row: UserConnection, credentials: Json): Promise<SecretId> {
    return this.#deps.secrets.store({ name: `connection:${row.id}`, owner: row.owner, value: JSON.stringify(credentials) });
  }

  async #credentials(row: UserConnection): Promise<Json | undefined> {
    if (row.credentials === undefined) return undefined;
    const text = await this.#deps.secrets.reveal(row.credentials);
    return text === undefined ? undefined : Json.parse(JSON.parse(text));
  }

  /**
   * `<payload>.<signature>`: the connection, when the state stops working and the hash of the browser binding, signed
   * with this start's key.
   */
  #sign(connection: ConnectionId, until: number, browser: string): string {
    const payload = Buffer.from(JSON.stringify({ c: connection, u: until, b: browser })).toString('base64url');
    return `${payload}.${this.#mac(payload)}`;
  }

  #verify(state: string | undefined): { connection: ConnectionId; browser: string } | undefined {
    const [payload, signature] = (state ?? '').split('.');
    if (payload === undefined || signature === undefined) return undefined;
    const expected = Buffer.from(this.#mac(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    const parsed = StatePayload.safeParse(parseJson(Buffer.from(payload, 'base64url').toString('utf8')));
    return parsed.success && parsed.data.u > this.#deps.clock() ? { connection: parsed.data.c, browser: parsed.data.b } : undefined;
  }

  #mac(payload: string): string {
    return createHmac('sha256', this.#key).update(payload).digest('base64url');
  }
}

/** A connect state's signed payload. */
const StatePayload = z.object({ c: ConnectionId, u: z.number(), b: z.string() });

/** The binding cookie's name for a sign-in. */
function bindingCookie(connection: ConnectionId): string {
  return `harness_connect_${connection}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}

/** Equal texts, compared in constant time. */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** JSON text's value, or undefined when it isn't JSON. */
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
