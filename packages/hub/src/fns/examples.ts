/**
 * Fn examples in their own table (`fnExamples`), each indexed as an `example` item (its words in FTS5, its vector in
 * sqlite-vec), so a fn can have any number of them and the relevant ones are found in the database. A fn's declared
 * examples are kept in step with its declaration: when it changes they are replaced; when the fn goes they go.
 * Ranking one fn's examples searches only that fn's items (`within`, or a per-hit check past the candidate cap), so the
 * database does all of it.
 */
import { reject } from '@ayepi/core';
import { mintId, qualify, type FnExamplesPatch, type SystemName, type FnExample, type FnExampleRecord, type FnExamplesPage, type FnExamplesQuery, type FnRecord, type QualifiedName } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import type { Indexer, Search } from '../index/index.ts';
import type { HubStore } from '../store/index.ts';
import { allRows } from '../execution/pages.ts';
import type { FnsTuning } from './env.ts';
import type { Asker, FnExamples } from './index.ts';

/** What examples need. */
export interface FnExamplesDeps {
  readonly store: () => HubStore;
  readonly catalog: () => Pick<Catalog, 'fn'>;
  readonly indexer: () => Pick<Indexer, 'upsert' | 'remove'>;
  readonly search: () => Pick<Search, 'search'>;
  readonly clock: () => number;
  readonly tuning: Pick<FnsTuning, 'HARNESS_FN_EXAMPLES_PAGE' | 'HARNESS_FN_SEARCH_CANDIDATES'>;
}

/** The text an example is found by: the fn, what it shows, its args and (when given) its result. */
export function exampleText(fn: QualifiedName, example: FnExample): string {
  return [
    example.note === undefined ? fn : `${fn}: ${example.note}`,
    `args: ${JSON.stringify(example.args)}`,
    example.result === undefined ? undefined : `result: ${JSON.stringify(example.result)}`,
  ].filter((line) => line !== undefined).join('\n');
}

/** Whether a stored example says the same as a declared one. */
function same(row: FnExampleRecord, example: FnExample): boolean {
  return JSON.stringify([row.args, row.result ?? null, row.note ?? null]) === JSON.stringify([example.args, example.result ?? null, example.note ?? null]);
}

/** The examples as a reader sees them. */
function view(row: FnExampleRecord, score?: number): FnExamplesPage['items'][number] {
  return { id: row.id, args: row.args, ...(row.result === undefined ? {} : { result: row.result }), ...(row.note === undefined ? {} : { note: row.note }), ...(score === undefined ? {} : { score }) };
}

/** The examples, on the hub's store and index. */
export class StoreFnExamples implements FnExamples {
  readonly #deps: FnExamplesDeps;

  constructor(deps: FnExamplesDeps) {
    this.#deps = deps;
  }

  async sync(fns: readonly FnRecord[], removed: readonly QualifiedName[]): Promise<void> {
    for (const fn of fns) await this.#syncOne(fn);
    for (const name of removed) await this.#drop(await this.#rows(name));
  }

  async page(query: FnExamplesQuery, asker: Asker): Promise<FnExamplesPage> {
    const fn = await this.#deps.catalog().fn(query.fn);
    if (fn === undefined || !asker.access.seesFn(fn)) throw reject(404, 'NO_FN', `there is no fn ${query.fn}`);
    const limit = query.limit ?? this.#deps.tuning.HARNESS_FN_EXAMPLES_PAGE;
    const offset = query.offset ?? 0;
    const table = this.#deps.store().table('fnExamples');
    const total = await table.count({ fn: fn.name });
    const text = query.query?.trim() ?? '';
    const found = text === '' ? (await this.#inOrder(fn.name, offset + limit)).map((row) => view(row)) : await this.#ranked(fn.name, text, offset + limit);
    const items = found.slice(offset, offset + limit);
    return { fn: fn.name, items, total, ...(offset + limit < (text === '' ? total : found.length) ? { next: offset + limit } : {}) };
  }

  async forPrompt(fn: FnRecord, text: string, count: number): Promise<FnExample[]> {
    if (count < 1) return [];
    const total = await this.#deps.store().table('fnExamples').count({ fn: fn.name });
    if (total === 0) return [];
    // with no more than fit there's nothing to choose: they go in their declared order
    const chosen = total <= count || text.trim() === '' ? (await this.#inOrder(fn.name, count)).map((row) => view(row)) : await this.#ranked(fn.name, text, count);
    const filled = chosen.length > 0 ? chosen : (await this.#inOrder(fn.name, count)).map((row) => view(row));
    return filled.map((example) => ({ args: example.args, ...(example.result === undefined ? {} : { result: example.result }), ...(example.note === undefined ? {} : { note: example.note }) }));
  }

  /** The first `limit` of a fn's examples in declared order. */
  async #inOrder(fn: QualifiedName, limit: number): Promise<FnExampleRecord[]> {
    return (await this.#deps.store().table('fnExamples').find({ where: { fn }, order: [['order', 'asc'], ['createdAt', 'asc']], limit: Math.max(1, limit) })).items;
  }

  /**
   * A fn's examples ranked by words and meaning against `text`, in the database: searched among that fn's items
   * (`within`) when it has no more than the candidate cap, else over every example, keeping only that fn's hits.
   */
  async #ranked(fn: QualifiedName, text: string, limit: number): Promise<FnExamplesPage['items']> {
    const table = this.#deps.store().table('fnExamples');
    const cap = this.#deps.tuning.HARNESS_FN_SEARCH_CANDIDATES;
    const ids = (await table.find({ where: { fn }, order: [['order', 'asc']], limit: cap + 1 })).items;
    if (ids.length === 0) return [];
    const found = new Map<string, FnExampleRecord>(ids.length > cap ? [] : ids.map((row) => [row.id, row]));
    const hits = await this.#deps.search().search({
      text, kinds: ['example'], limit: Math.max(1, limit),
      ...(ids.length > cap
        ? { keep: async (hit) => {
          const row = await table.get(hit.key);
          if (row?.fn !== fn) return false;
          found.set(row.id, row);
          return true;
        } }
        : { within: ids.map((row) => ({ kind: 'example' as const, key: row.id })) }),
    });
    return hits.flatMap((hit) => {
      const row = found.get(hit.key);
      return row === undefined ? [] : [view(row, hit.score)];
    });
  }

  /** A fn's stored examples. */
  async #rows(fn: QualifiedName): Promise<FnExampleRecord[]> {
    return allRows(this.#deps.store().table('fnExamples'), { where: { fn } });
  }

  /** Make the stored declared examples of a fn what it declares now. */
  async #syncOne(fn: FnRecord): Promise<void> {
    const declared = fn.decl.examples ?? [];
    const stored = (await this.#rows(fn.name)).filter((row) => row.source === 'decl');
    const kept = stored.filter((row) => {
      const example = declared[row.order];
      return example !== undefined && same(row, example);
    });
    const keptAt = new Set(kept.map((row) => row.order));
    await this.#drop(stored.filter((row) => !kept.includes(row)));
    const now = this.#deps.clock();
    const fresh: FnExampleRecord[] = declared.flatMap((example, order) => (keptAt.has(order) ? [] : [{
      id: mintId('fnExample'), fn: fn.name, system: fn.system, source: 'decl' as const, order, text: exampleText(fn.name, example),
      args: example.args, ...(example.result === undefined ? {} : { result: example.result }), ...(example.note === undefined ? {} : { note: example.note }), createdAt: now,
    }]));
    if (fresh.length === 0) return;
    const table = this.#deps.store().table('fnExamples');
    for (const row of fresh) await table.put(row);
    await this.#deps.indexer().upsert(fresh.map((row) => ({ kind: 'example', key: row.id, text: row.text, system: row.system })), { vectors: 'background' });
  }

  /**
   * Build 6: a system adds, replaces (by its key) or removes examples of one of its own fns while running. Declared
   * examples are left alone; a replaced example keeps its id, so it is indexed again in place.
   */
  async patch(system: SystemName, patch: FnExamplesPatch): Promise<{ added: number; removed: number }> {
    const name = qualify(system, patch.fn);
    const fn = await this.#deps.catalog().fn(name);
    if (fn?.system !== system) throw reject(404, 'FN_NOT_FOUND', `${system} has no fn ${patch.fn}`);
    const runtime = (await this.#rows(name)).filter((row) => row.source === 'runtime');
    const byKey = new Map(runtime.map((row) => [row.key, row]));
    const upserted = new Set(patch.upsert.map((example) => example.key));
    // a key both removed and upserted is replaced
    const dropped = runtime.filter((row) => row.key !== undefined && patch.remove.includes(row.key) && !upserted.has(row.key));
    await this.#drop(dropped);
    const now = this.#deps.clock();
    const rows: FnExampleRecord[] = patch.upsert.map((example) => ({
      id: byKey.get(example.key)?.id ?? mintId('fnExample'), fn: name, system, source: 'runtime', key: example.key, order: 0, text: exampleText(name, example),
      args: example.args, ...(example.result === undefined ? {} : { result: example.result }), ...(example.note === undefined ? {} : { note: example.note }), createdAt: now,
    }));
    const table = this.#deps.store().table('fnExamples');
    for (const row of rows) await table.put(row);
    if (rows.length > 0) await this.#deps.indexer().upsert(rows.map((row) => ({ kind: 'example', key: row.id, text: row.text, system: row.system })), { vectors: 'background' });
    return { added: patch.upsert.filter((example) => !byKey.has(example.key)).length, removed: dropped.length };
  }

  /** Remove examples and their index items. */
  async #drop(stale: readonly FnExampleRecord[]): Promise<void> {
    if (stale.length === 0) return;
    const table = this.#deps.store().table('fnExamples');
    for (const row of stale) await table.remove(row.id);
    await this.#deps.indexer().remove('example', stale.map((row) => row.id));
  }
}
