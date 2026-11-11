/**
 * Test fixtures: a small shop database in a fresh SQLite file (customers and their orders), the config of an
 * instance over it, and an instance with a scripted enricher over a recording hub that keeps its types and their meta.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { InstanceName, SystemName, TypeRecord, qualify, type FleetInstance, type Json, type TypeDecl, type TypeDefinitions } from '@harness/core';
import BetterSqlite3 from 'better-sqlite3';
import type { DatabaseConfig } from '../shared/shapes.ts';
import type { Enricher } from './author.ts';
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
