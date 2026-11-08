/**
 * Hub MCP records in the hub store (`McpRegistry`, table `mcps`). Making an MCP also makes its `mcp` actor (what its
 * runs are attributed to, so policies can target it) and its endpoint secret: `hmcp_` and 32 random bytes, shown once
 * and kept only as its sha-256 digest. Rotating gives a new secret and ends the MCP's open sessions. Every change is
 * announced (`mcp.changed`) so its endpoint is rebuilt.
 */
import { randomBytes } from 'node:crypto';
import { reject } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { DAY_MS, mintId, type ActorId, type HubMcp, type HubMcpId, type HubMcpInput, type HubMcpView, type McpActor, type McpSlug, type Timestamp } from '@harness/core';
import type { EventBus } from '../bus.ts';
import { MCP_PATH } from '../api/http.ts';
import type { HubStore } from '../store/index.ts';
import { sha256Hex } from '../link/keys.ts';
import type { McpRegistry } from './index.ts';

/** The prefix every endpoint secret starts with, so a leaked one is easy to find. */
export const SECRET_PREFIX = 'hmcp_';
/** How many MCPs a list reads at most. */
const MAX_MCPS = 500;

/** A new endpoint secret. */
export function newSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** The sha-256 digest of a secret, hex: what the record keeps and a bearer is looked up by. */
export function secretDigest(secret: string): string {
  return sha256Hex(secret);
}

/** The first moment of a time's UTC day. */
function dayStart(at: Timestamp): Timestamp {
  return at - (at % DAY_MS);
}

/** What the registry uses. */
export interface StoreMcpRegistryDeps {
  readonly store: HubStore;
  readonly bus: EventBus;
  readonly clock: () => number;
  readonly log: Logger;
  /** The hub's public URL, which every MCP's URL starts with, so a client elsewhere can connect with it as shown. */
  readonly publicUrl: string;
  /** How many sessions an MCP has open now (the endpoints know). */
  readonly sessions: (mcp: HubMcpId) => number;
}

/** Hub MCPs on the hub store. */
export class StoreMcpRegistry implements McpRegistry {
  readonly #deps: StoreMcpRegistryDeps;

  constructor(deps: StoreMcpRegistryDeps) {
    this.#deps = deps;
  }

  async list(): Promise<HubMcpView[]> {
    const page = await this.#deps.store.table('mcps').find({ order: [['name', 'asc']], limit: MAX_MCPS });
    return Promise.all(page.items.map((record) => this.#view(record)));
  }

  async get(mcp: HubMcpId): Promise<HubMcpView | undefined> {
    const record = await this.record(mcp);
    return record === undefined ? undefined : this.#view(record);
  }

  record(mcp: HubMcpId): Promise<HubMcp | undefined> {
    return this.#deps.store.table('mcps').get(mcp);
  }

  async bySlug(slug: McpSlug): Promise<HubMcp | undefined> {
    return (await this.#deps.store.table('mcps').find({ where: { slug }, limit: 1 })).items[0];
  }

  async create(input: HubMcpInput, by: ActorId): Promise<{ mcp: HubMcpView; secret: string }> {
    const { store, clock } = this.#deps;
    await this.#checkSlug(input.slug, undefined);
    await this.#checkUser(input.user);
    const id = mintId('mcp');
    const now = clock();
    const actor: McpActor = { id: mintId('actor'), kind: 'mcp', mcp: id, name: input.name, about: `Hub MCP /mcp/${input.slug}`, createdAt: now, disabled: false };
    const secret = newSecret();
    const record: HubMcp = { ...input, id, actor: actor.id, secretDigest: secretDigest(secret), createdBy: by, createdAt: now, updatedAt: now };
    await store.tx(async (tx) => {
      await tx.table('actors').insert(actor);
      await tx.table('mcps').insert(record);
    });
    this.#deps.log.info('mcp.created', { mcp: id, slug: input.slug, by });
    this.#deps.bus.publish('mcp.changed', { mcp: id, removed: false });
    return { mcp: await this.#view(record), secret };
  }

  async update(mcp: HubMcpId, change: Partial<HubMcpInput>, by: ActorId): Promise<HubMcpView> {
    const record = await this.#found(mcp);
    if (change.slug !== undefined && change.slug !== record.slug) await this.#checkSlug(change.slug, mcp);
    if (change.user !== undefined) await this.#checkUser(change.user);
    const updated = await this.#deps.store.tx(async (tx) => {
      const row = await tx.table('mcps').update(mcp, { ...change, updatedAt: Math.max(this.#deps.clock(), record.updatedAt + 1) });
      if (change.name !== undefined) await tx.table('actors').update(record.actor, { name: change.name });
      return row;
    });
    this.#deps.log.info('mcp.updated', { mcp, by, fields: Object.keys(change).join(',') });
    this.#deps.bus.publish('mcp.changed', { mcp, removed: false });
    return this.#view(updated);
  }

  async rotate(mcp: HubMcpId, by: ActorId): Promise<{ secret: string }> {
    const record = await this.#found(mcp);
    const secret = newSecret();
    await this.#deps.store.table('mcps').update(mcp, { secretDigest: secretDigest(secret), updatedAt: Math.max(this.#deps.clock(), record.updatedAt + 1) });
    this.#deps.log.info('mcp.secret.rotated', { mcp, by });
    this.#deps.bus.publish('mcp.changed', { mcp, removed: false });
    return { secret };
  }

  async remove(mcp: HubMcpId, by: ActorId): Promise<boolean> {
    const record = await this.record(mcp);
    if (record === undefined) return false;
    await this.#deps.store.tx(async (tx) => {
      await tx.table('mcps').remove(mcp);
      // the actor stays (runs are attributed to it), switched off
      await tx.table('actors').update(record.actor, { disabled: true });
    });
    this.#deps.log.info('mcp.removed', { mcp, by });
    this.#deps.bus.publish('mcp.changed', { mcp, removed: true });
    return true;
  }

  async #found(mcp: HubMcpId): Promise<HubMcp> {
    const record = await this.record(mcp);
    if (record === undefined) throw reject(404, 'MCP_NOT_FOUND', `no hub MCP ${mcp}`);
    return record;
  }

  /** A route is one MCP's. */
  async #checkSlug(slug: McpSlug, self: HubMcpId | undefined): Promise<void> {
    const taken = await this.bySlug(slug);
    if (taken !== undefined && taken.id !== self) throw reject(409, 'MCP_SLUG_TAKEN', `/mcp/${slug} is already another MCP's route`);
  }

  /** An MCP's runs are for a real, active person. */
  async #checkUser(user: ActorId): Promise<void> {
    const actor = await this.#deps.store.table('actors').get(user);
    if (actor?.kind !== 'user' || actor.disabled) throw reject(422, 'MCP_USER_INVALID', `${user} is not an active person`);
  }

  async #view(record: HubMcp): Promise<HubMcpView> {
    const { secretDigest: _digest, ...shown } = record;
    const callsToday = await this.#deps.store.table('runs').count({ caller: record.actor, createdAt: { gte: dayStart(this.#deps.clock()) } });
    return { ...shown, url: `${this.#deps.publicUrl.replace(/\/$/, '')}${MCP_PATH}/${record.slug}`, sessions: this.#deps.sessions(record.id), callsToday };
  }
}
