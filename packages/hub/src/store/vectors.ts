/**
 * Vectors on sqlite-vec: one `vec0` table per embedder, with its dimensions fixed when it is made and cosine
 * distance. Each row is keyed by kind + key, keeps the kind as a metadata column (so a nearest search filters by
 * kind inside the KNN) and the key as an auxiliary column. A meta table remembers each embedder's table and
 * dimensions; when an embedder's dimensions change its vectors can't be compared any more, so its table is rebuilt
 * empty (the indexer re-embeds).
 */
import { createHash } from 'node:crypto';
import { IndexedKind, type QualifiedName, compositeKey } from '@harness/core';
import type { Logger } from '@ayepi/log';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Scope } from './db.ts';
import { StoreError } from './errors.ts';
import type { VectorIndex } from './index.ts';

/** The meta table: one row per embedder. */
export const VECTOR_META = '_vectors';

const VectorMeta = z.object({ embedder: z.string(), table: z.string(), dimensions: z.number().int() });
const Nearest = z.object({ kind: IndexedKind, key: z.string(), distance: z.number() });

/** The `vec0` table of an embedder: readable, and unique even when two names slug the same. */
export function vectorTable(embedder: string): string {
  const slug = embedder.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
  const hash = createHash('sha256').update(embedder).digest('hex').slice(0, 8);
  return `_vec_${slug}_${hash}`;
}

/** A vector as sqlite-vec reads it: little-endian float32s. */
function vectorBlob(vector: readonly number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

/** Similarity in [0, 1] from cosine distance in [0, 2]: 1 − distance, floored at 0 (opposite vectors aren't similar). */
export const similarity = (distance: number): number => Math.min(1, Math.max(0, 1 - distance));

/** Make the table that records each embedder's vector table and size. */
async function createVectorMeta(scope: Scope): Promise<void> {
  await scope.db.schema
    .createTable(VECTOR_META)
    .ifNotExists()
    .addColumn('embedder', 'text', (c) => c.primaryKey().notNull())
    .addColumn('table', 'text', (c) => c.notNull())
    .addColumn('dimensions', 'integer', (c) => c.notNull())
    .execute();
}

/** Make one embedder's table at a size, remaking it when it was made at another. Returns whether it was remade. */
async function ensureVectorTable(scope: Scope, embedder: string, size: number, log: Logger): Promise<boolean> {
  const { db } = scope;
  if (!Number.isInteger(size) || size < 1) throw new StoreError('bad-vector', `embedder ${embedder}: dimensions must be a positive whole number, not ${size}`);
  const table = vectorTable(embedder);
  const found = await db.selectFrom(VECTOR_META).selectAll().where('embedder', '=', embedder).executeTakeFirst();
  const meta = found === undefined ? undefined : VectorMeta.parse(found);
  const rebuilt = meta !== undefined && meta.dimensions !== size;
  if (rebuilt) {
    await sql`drop table if exists ${sql.table(meta.table)}`.execute(db);
    log.warn('store.vectors.rebuilt', { embedder, from: meta.dimensions, to: size });
  }
  await sql`create virtual table if not exists ${sql.table(table)} using vec0(
    id text primary key, embedding float[${sql.raw(String(size))}] distance_metric=cosine, kind text, +key text)`.execute(db);
  await db
    .insertInto(VECTOR_META)
    .values({ embedder, table, dimensions: size })
    .onConflict((oc) => oc.column('embedder').doUpdateSet({ table, dimensions: size }))
    .execute();
  return rebuilt;
}

/** Create or check the tables of the embedders known at open. Run inside a transaction. Returns those rebuilt. */
export async function createVectorTables(scope: Scope, dimensions: ReadonlyMap<string, number>, log: Logger): Promise<string[]> {
  await createVectorMeta(scope);
  const rebuilt: string[] = [];
  for (const [embedder, size] of dimensions) {
    if (await ensureVectorTable(scope, embedder, size, log)) rebuilt.push(embedder);
  }
  return rebuilt;
}

/** The vector index, in a scope. */
export class SqliteVectorIndex implements VectorIndex {
  readonly #scope: Scope;
  readonly #dimensions: Map<string, number>;
  readonly #log: Logger;

  constructor(scope: Scope, dimensions: Map<string, number>, log: Logger) {
    this.#scope = scope;
    this.#dimensions = dimensions;
    this.#log = log;
  }

  async ensure(embedder: QualifiedName, dimensions: number): Promise<boolean> {
    if (this.#dimensions.get(embedder) === dimensions) return false;
    const rebuilt = await this.#scope.atomic(async (scope) => {
      await createVectorMeta(scope);
      return ensureVectorTable(scope, embedder, dimensions, this.#log);
    });
    this.#dimensions.set(embedder, dimensions);
    return rebuilt;
  }

  async upsert(embedder: QualifiedName, entries: ReadonlyArray<{ kind: IndexedKind; key: string; vector: readonly number[] }>): Promise<void> {
    const table = this.#table(embedder);
    for (const entry of entries) this.#check(embedder, entry.vector);
    if (entries.length === 0) return;
    await this.#scope.atomic(async ({ db }) => {
      for (const { kind, key, vector } of entries) {
        const id = compositeKey(kind, key);
        // vec0 has no upsert: replace by deleting first
        await sql`delete from ${sql.table(table)} where id = ${id}`.execute(db);
        await sql`insert into ${sql.table(table)} (id, embedding, kind, key) values (${id}, ${vectorBlob(vector)}, ${kind}, ${key})`.execute(db);
      }
    });
  }

  async remove(embedder: QualifiedName, kind: IndexedKind, keys: readonly string[]): Promise<void> {
    const table = this.#table(embedder);
    if (keys.length === 0) return;
    const ids = keys.map((key) => compositeKey(kind, key));
    await sql`delete from ${sql.table(table)} where id in (${sql.join(ids)})`.execute(this.#scope.db);
  }

  async nearest(
    embedder: QualifiedName,
    vector: readonly number[],
    limit: number,
    kinds?: readonly IndexedKind[],
  ): Promise<Array<{ kind: IndexedKind; key: string; score: number }>> {
    const table = this.#table(embedder);
    this.#check(embedder, vector);
    const k = Math.floor(limit);
    if (k < 1 || kinds?.length === 0) return [];
    const byKind = kinds === undefined ? sql`` : sql`and kind in (${sql.join([...kinds])})`;
    const result = await sql`
      select kind, key, distance from ${sql.table(table)}
      where embedding match ${vectorBlob(vector)} and k = ${k} ${byKind}
      order by distance`.execute(this.#scope.db);
    return result.rows.map((row) => {
      const hit = Nearest.parse(row);
      return { kind: hit.kind, key: hit.key, score: similarity(hit.distance) };
    });
  }

  #table(embedder: QualifiedName): string {
    if (!this.#dimensions.has(embedder)) throw new StoreError('unknown-embedder', `the store has no vectors for embedder ${embedder}`);
    return vectorTable(embedder);
  }

  #check(embedder: QualifiedName, vector: readonly number[]): void {
    const size = this.#dimensions.get(embedder);
    if (vector.length !== size) throw new StoreError('bad-vector', `embedder ${embedder} has ${size ?? 0} dimensions; the vector has ${vector.length}`);
    if (!vector.every(Number.isFinite)) throw new StoreError('bad-vector', `embedder ${embedder}: the vector holds a value that isn't finite`);
  }
}
