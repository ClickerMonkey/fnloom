/**
 * What an instance keeps in its data folder (its saved queries are the hub's fns, not kept here): the enrichment
 * of each table schema it has seen (by hash, so a model refines a table once per schema), and the type
 * changes a rescan found that wait for an admin. `FileStore` keeps them as JSON files; `MemoryStore` is for tests.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Timestamp } from '@harness/core';
import { TableSpec } from '@aeye/query';
import { z } from 'zod';
import { ScannedTable } from './schema.ts';
import { TableEnrichment } from './types.ts';

/** A table type change a rescan found that waits for an admin, with the scan it came from. */
export const PendingChanges = z.object({
  scan: z.string().min(1),
  /** The tables as scanned (each one changed or new). */
  tables: z.array(ScannedTable),
  /** Tables that are gone, by name. */
  dropped: z.array(z.string()),
  foundAt: Timestamp,
});
export type PendingChanges = z.infer<typeof PendingChanges>;

/** An instance's kept state. */
export interface InstanceStore {
  enrichment(hash: string): Promise<TableEnrichment | undefined>;
  putEnrichment(hash: string, enrichment: TableEnrichment): Promise<void>;
  pending(): Promise<PendingChanges | undefined>;
  /** Keep the changes that wait for an admin, or clear them (`undefined`). */
  setPending(changes: PendingChanges | undefined): Promise<void>;
  /** The table shapes the hub's types were last made from, by table name. */
  applied(): Promise<Map<string, TableSpec>>;
  setApplied(tables: ReadonlyMap<string, TableSpec>): Promise<void>;
}

const Stored = z.object({
  enrichments: z.record(z.string(), TableEnrichment).default({}),
  pending: PendingChanges.optional(),
  applied: z.record(z.string(), TableSpec).default({}),
});
type Stored = z.infer<typeof Stored>;

/** The kept state in memory, written out by `persist` after each change. */
class StoreBase implements InstanceStore {
  protected state: Stored = { enrichments: {}, applied: {} };

  async enrichment(hash: string): Promise<TableEnrichment | undefined> {
    return (await this.load()).enrichments[hash];
  }

  async putEnrichment(hash: string, enrichment: TableEnrichment): Promise<void> {
    const state = await this.load();
    this.state = { ...state, enrichments: { ...state.enrichments, [hash]: enrichment } };
    await this.persist();
  }

  async pending(): Promise<PendingChanges | undefined> {
    return (await this.load()).pending;
  }

  async setPending(changes: PendingChanges | undefined): Promise<void> {
    const { pending: _pending, ...rest } = await this.load();
    this.state = changes === undefined ? rest : { ...rest, pending: changes };
    await this.persist();
  }

  async applied(): Promise<Map<string, TableSpec>> {
    return new Map(Object.entries((await this.load()).applied));
  }

  async setApplied(tables: ReadonlyMap<string, TableSpec>): Promise<void> {
    const state = await this.load();
    this.state = { ...state, applied: Object.fromEntries(tables) };
    await this.persist();
  }

  protected load(): Promise<Stored> {
    return Promise.resolve(this.state);
  }

  protected persist(): Promise<void> {
    return Promise.resolve();
  }
}

/** The kept state in memory. */
export class MemoryStore extends StoreBase {}

/** The kept state in `<dataDir>/database.json`, written whole (through a temp file) on each change. */
export class FileStore extends StoreBase {
  readonly #file: string;
  #loaded = false;

  constructor(dataDir: string) {
    super();
    this.#file = join(dataDir, 'database.json');
  }

  protected override async load(): Promise<Stored> {
    if (this.#loaded) { return this.state; }
    let text: string | undefined;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { throw error; }
    }
    this.state = text === undefined ? this.state : Stored.parse(JSON.parse(text));
    this.#loaded = true;
    return this.state;
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(`${this.#file}.tmp`, JSON.stringify(this.state), 'utf8');
    await rename(`${this.#file}.tmp`, this.#file);
  }
}
