/**
 * The hub's fn name registry (plan `injected-context-2026-11-22`, section 1), in its store: every fn the catalog holds
 * (saved fns and methods included) has one row in `modelFnNames` with the name the model calls it by (`modelFnName`),
 * keyed by that name and indexed by fn, written and removed in the transaction that writes or removes the fn. A model
 * name reads back by lookup, never by rule (a cut name can't be read by rule). Names whose fns are gone move to the
 * history table (`modelFnNameHistory`), so an old call in a transcript still reads back for people.
 *
 * Nothing is held in memory: a prompt asks about the names it meets in one batch (`fnsAmong`, `fnsOf`), answered by
 * indexed `in` queries a chunk at a time, however many fns the hub holds. The catalog asks `problem` before it stores a
 * fn (a local name the model name can't carry, or a model name another fn already holds: one lookup by key).
 */
import { fnLocalNameProblem, ModelFnName, modelFnName, splitName, type FnRecord, type ModelFnNameRegistry, type QualifiedName } from '@harness/core';
import type { HubStore } from '../store/index.ts';
import { allRows, rows } from '../store/rows.ts';

/** How many names one `in` query carries. */
const CHUNK = 500;

/** The registry over the hub's store. */
export class StoreFnNames implements ModelFnNameRegistry {
  readonly #store: () => HubStore;

  /** Over this store (a function, so the registry follows a store that is swapped, as in tests). */
  constructor(store: HubStore | (() => HubStore)) {
    this.#store = typeof store === 'function' ? store : () => store;
  }

  async fnsAmong(names: readonly QualifiedName[]): Promise<ReadonlySet<QualifiedName>> {
    const found = new Set<QualifiedName>();
    for (const chunk of chunks([...new Set(names)])) {
      for (const row of await allRows(this.#store().table('modelFnNames'), { where: { fn: { in: chunk } } })) found.add(row.fn);
    }
    return found;
  }

  async fnsOf(models: readonly string[]): Promise<ReadonlyMap<string, QualifiedName>> {
    const found = new Map<string, QualifiedName>();
    const store = this.#store();
    // only a model name's shape can be one: anything else names no fn
    const shaped = [...new Set(models)].flatMap((model) => { const parsed = ModelFnName.safeParse(model); return parsed.success ? [parsed.data] : []; });
    for (const chunk of chunks(shaped)) {
      for (const row of await allRows(store.table('modelFnNames'), { where: { model: { in: chunk } } })) found.set(row.model, row.fn);
    }
    // the names no fn holds now may be a gone fn's
    const gone = shaped.filter((model) => !found.has(model));
    for (const chunk of chunks(gone)) {
      for (const row of await allRows(store.table('modelFnNameHistory'), { where: { model: { in: chunk } } })) found.set(row.model, row.fn);
    }
    return found;
  }

  /**
   * Why a fn can't have this name, in the hub's words: its local name breaks the rule its model name needs
   * (`FnLocalName`), or another fn already has its model name (only possible through a cut name's hash). `claimed` is
   * what the same import gives out before it, so two of one manifest are caught too.
   */
  async problem(fn: QualifiedName, claimed?: Map<string, QualifiedName>): Promise<string | undefined> {
    const local = fnLocalNameProblem(splitName(fn).local);
    if (local !== undefined) return local;
    const model = modelFnName(fn);
    const stored = (await this.#store().table('modelFnNames').get(model))?.fn;
    const holder = (stored === fn ? undefined : stored) ?? (claimed?.get(model) === fn ? undefined : claimed?.get(model));
    if (holder !== undefined) return `${fn} would be called ${model} by the model, which is ${holder}'s name: pick another name`;
    claimed?.set(model, fn);
    return undefined;
  }

  /** Keep a fn's model name, in the transaction that writes the fn (`tx`). */
  async write(tx: HubStore, fn: FnRecord): Promise<void> {
    const model = modelFnName(fn.name);
    const table = tx.table('modelFnNames');
    if ((await table.get(model))?.fn === fn.name) return;
    await table.put({ model, fn: fn.name, system: fn.system });
  }

  /** Take a gone fn's model name out, in the transaction that removes the fn, and keep it in the history. */
  async remove(tx: HubStore, fn: QualifiedName, until: number): Promise<void> {
    const model = modelFnName(fn);
    const table = tx.table('modelFnNames');
    if ((await table.get(model))?.fn !== fn) return;
    await table.remove(model);
    await tx.table('modelFnNameHistory').put({ model, fn, until });
  }

  /**
   * Write the model names of every stored fn, once, on a hub whose fns were stored before the registry was a table: a
   * migration, read page by page. Returns how many it wrote (none when the table already has rows).
   */
  async backfill(): Promise<number> {
    const store = this.#store();
    if ((await store.table('modelFnNames').count()) > 0) return 0;
    let written = 0;
    for await (const fn of rows(store.table('fns'))) {
      await store.table('modelFnNames').put({ model: modelFnName(fn.name), fn: fn.name, system: fn.system });
      written += 1;
    }
    return written;
  }
}

/** A list in chunks of `CHUNK`. */
function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += CHUNK) out.push(items.slice(at, at + CHUNK));
  return out;
}
