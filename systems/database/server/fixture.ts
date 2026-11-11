/**
 * Test fixtures: a small shop database in a fresh SQLite file (customers and their orders), the config of an
 * instance over it, and an instance with a scripted enricher over a recording hub that keeps its types and their meta.
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InstanceName, Json, SystemName, SystemPackageManifest, TypeRecord, qualify, type FleetInstance, type FnSearchQuery, type OutcomeWire, type RunSettled, type TypeDecl, type TypeDefinitions } from '@harness/core';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub } from '@harness/sdk/server/testing';
import BetterSqlite3 from 'better-sqlite3';
import { database } from '../shared/index.ts';
import type { DatabaseConfig } from '../shared/shapes.ts';
import type { Enricher } from './author.ts';
import { databaseEnv } from './env.ts';
import { SELF_FLEET, createDatabaseImpl, type DatabaseServer } from './impl.ts';
import { DatabaseInstance, type HubSide } from './instance.ts';
import { tableMetaOf, type KeptType } from './types.ts';

/** The shop's schema and rows. */
export const SHOP_SQL = `
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, tier TEXT NOT NULL DEFAULT 'basic' CHECK (tier IN ('basic', 'gold')));
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total REAL NOT NULL, status TEXT NOT NULL, placed DATE NOT NULL);
INSERT INTO customers (name, email, tier) VALUES ('Ada', 'ada@example.com', 'gold'), ('Bo', 'bo@example.com', 'basic'), ('Cy', NULL, 'basic');
INSERT INTO orders (customer_id, total, status, placed) VALUES
  (1, 120.5, 'paid', '2026-10-01'), (1, 80, 'open', '2026-10-20'), (2, 15, 'paid', '2026-09-12'),
  (2, 42, 'open', '2026-11-02'), (3, 7.25, 'refunded', '2026-08-30');
`;

/** The projects/owners sample: an enum, a number, a date, a unique column and a foreign key (generated table fns, e2e). */
export const PROJECTS_SQL = `
CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES owners(id),
  value REAL NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'done')), started DATE NOT NULL
);
INSERT INTO owners (name) VALUES ('Ada'), ('Bo');
INSERT INTO projects (code, name, owner_id, value, status, started) VALUES
  ('P1', 'Roof', 1, 100, 'done', '2026-01-05'), ('P2', 'Deck', 1, 300, 'active', '2026-02-10'),
  ('P3', 'Shed', 2, 50, 'active', '2026-03-15');
`;

/** A fresh folder under `.harness-test/`. */
export function testFolder(name: string): string {
  mkdirSync('.harness-test', { recursive: true });
  return mkdtempSync(join('.harness-test', `${name}-`));
}

/** A shop database file in a fresh folder: its folder and file name. */
export function shopFile(name = 'shop'): { dir: string; file: string } {
  const dir = testFolder(name);
  const db = new BetterSqlite3(join(dir, 'shop.db'));
  db.exec(SHOP_SQL);
  db.close();
  return { dir, file: 'shop.db' };
}

/** An instance's config over a new SQLite file in its data folder. */
export function shopConfig(overrides: Partial<DatabaseConfig> = {}): DatabaseConfig {
  return {
    label: 'Shop',
    connection: { kind: 'sqlite-new', path: 'shop.db' },
    data: 'read-write',
    schema: 'allowed',
    enrich: { on: false },
    audience: { visibility: 'public', with: [] },
    ...overrides,
  };
}

/** An enricher that never runs (enrichment is off), or one that answers from a script. */
export const NO_ENRICHER: Enricher = { enrich: () => Promise.resolve({ problems: ['not in this test'] }) };

/** The hub's side, recording what it was given and keeping the table types as the hub would. */
export class RecordingHub implements HubSide {
  readonly upserts: string[][] = [];
  readonly removals: string[][] = [];
  /** The saved query fns the hub says read each type. */
  readonly reading = new Map<string, string[]>();
  /** The table types the hub keeps, by local name. */
  readonly kept = new Map<string, TypeDecl>();

  known(): Promise<ReadonlyMap<string, KeptType>> {
    return Promise.resolve(new Map([...this.kept].map(([name, decl]) => [name, { def: decl.def, meta: tableMetaOf(decl.meta) }])));
  }

  /** The hub's fleet as `ctx.fleet()` lists it: one online instance with this config and the kept types. */
  fleet(instance: InstanceName, config: Json): FleetInstance[] {
    return [{ instance, description: '', online: true, config, types: [...this.kept.values()].map((decl) => ({ name: qualify('database', decl.name), description: decl.description })) }];
  }

  /** The kept types' definitions, as `ctx.types.definitions` answers. */
  definitions(names: readonly string[]): TypeDefinitions {
    const types = [...this.kept.values()].flatMap(({ name, methods: _methods, ...decl }) => (names.includes(qualify('database', name))
      ? [TypeRecord.parse({ ...decl, name: qualify('database', name), system: SystemName.parse('database'), references: [], updatedAt: 1_000 })]
      : []));
    return { types, missing: [] };
  }

  readers(type: string): Promise<string[]> {
    return Promise.resolve(this.reading.get(type) ?? []);
  }

  types(upsert: readonly TypeDecl[], remove: readonly string[]): Promise<void> {
    this.upserts.push(upsert.map((decl) => decl.name));
    this.removals.push([...remove]);
    for (const decl of upsert) { this.kept.set(decl.name, decl); }
    for (const name of remove) { this.kept.delete(name); }
    return Promise.resolve();
  }
}

/** An instance over a fresh shop database. */
export function shopInstance(options: { config?: Partial<DatabaseConfig>; enricher?: Enricher; hub?: RecordingHub; dir?: string } = {}): { instance: DatabaseInstance; hub: RecordingHub; dir: string } {
  const dir = options.dir ?? shopFile().dir;
  const hub = options.hub ?? new RecordingHub();
  const instance = new DatabaseInstance(shopConfig(options.config), {
    instance: InstanceName.parse('main'), dataDir: dir, enricher: options.enricher ?? NO_ENRICHER, hub,
    limits: { page: 50, max: 500 }, distinctMax: 12, now: () => 1_000,
  });
  return { instance, hub, dir };
}

/** The system's version, as its `system.json` says. */
const SYSTEM_VERSION = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8'))).version;

/** The database system served over the SDK's link runtime to a fake hub, on one instance, ready for calls. */
export interface ServedDatabase {
  readonly hub: FakeHub;
  readonly server: DatabaseServer;
  readonly types: RecordingHub;
  stop(): Promise<void>;
}

/** A run's outcome as a child call settles. */
export function settledOf(outcome: OutcomeWire): RunSettled {
  if (outcome.status === 'done') { return { status: 'done', result: outcome.result }; }
  if (outcome.status === 'invalid-input') { return { status: 'failed', error: { class: 'caller', message: outcome.invalid.problems.map((problem) => problem.message).join(' ') } }; }
  if (outcome.status === 'failed') { return { status: 'failed', error: outcome.error }; }
  return { status: 'cancelled' };
}

/**
 * Serve the database system over the link to a fake hub: the hub keeps the table types it is sent and lists them on
 * its fleet, searches its saved fns (and, for `types.reads`, the saved queries whose payload names a table), and
 * forwards a tool's work to this instance. `afterPatch` runs after each table type patch reaches the hub.
 */
export async function serveDatabase(options: { dir: string; config?: DatabaseConfig; afterPatch?: () => Promise<void> }): Promise<ServedDatabase> {
  const config = options.config ?? shopConfig();
  const hub = new FakeHub({ config });
  const types = new RecordingHub();
  hub.onFleet = () => Promise.resolve(types.fleet(InstanceName.parse('main'), Json.parse(config)));
  hub.onTypes = (names) => Promise.resolve(types.definitions(names));
  const searchFns = (query: FnSearchQuery) => {
    const reads = query.types?.reads?.map((type) => type.slice(type.lastIndexOf('.') + 1)) ?? [];
    const page = hub.fns.search({ ...query, types: undefined });
    return Promise.resolve(reads.length === 0 ? page : {
      items: page.items.filter((hit) => reads.some((table) => JSON.stringify(hub.fns.kept.get(hit.name)?.saved.payload).includes(`"${table}"`))),
    });
  };
  const server = createDatabaseImpl({
    settings: databaseEnv.parse(), instance: InstanceName.parse('main'), dataDir: options.dir, fleet: SELF_FLEET, enricher: NO_ENRICHER, now: () => 1_000,
    hub: () => ({ types: async (upsert, remove) => { await types.types(upsert, remove); await options.afterPatch?.(); }, searchFns }),
  });
  hub.onCall = async (call) => hub.fns.settle(call) ?? settledOf(await hub.run(call.fn, call.args));
  const running: RunningSystem<'database'> = await serve(database, server.impl, { hub: 'ws://hub.test/link', state: 'unused', version: SYSTEM_VERSION }, hub.host());
  await running.ready();
  for (let wait = 0; server.current() === undefined && wait < 200; wait += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); }
  return { hub, server, types, stop: async () => { await running.stop(); await server.close(); } };
}
