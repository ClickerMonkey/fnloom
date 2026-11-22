/**
 * The hub's fn name registry (plan `injected-context-2026-11-22`, section 1): every fn the catalog holds (saved fns and
 * methods included), each encoded once as the name the model calls it by (`modelFnName`), so a model name reads back
 * by lookup, never by rule (a cut name can't be read by rule). Names whose fns are gone stay in the history table
 * (`modelFnNameHistory`), so an old call in a transcript still reads back for people.
 *
 * The catalog owns it: it checks each fn it is asked to declare or save (`problem`: a local name the model name can't
 * carry, or a model name another fn already has), and tells it what each import or save added and removed (`changed`).
 * It holds names only, filled once from the store page by page.
 */
import type { Logger } from '@ayepi/log';
import { FnNameIndex, fnLocalNameProblem, modelFnName, splitName, type FnRecord, type ModelFnNameHistory, type QualifiedName } from '@harness/core';
import type { HubStore } from '../store/index.ts';
import { rows } from '../store/rows.ts';

/** What the registry needs. */
export interface FnNamesDeps {
  readonly store: HubStore;
  readonly log: Logger;
  readonly clock: () => number;
}

/** The registry, kept in step with the catalog. */
export class StoreFnNames {
  readonly #deps: FnNamesDeps;
  #index: FnNameIndex | undefined;
  #loading: Promise<FnNameIndex> | undefined;

  constructor(deps: FnNamesDeps) {
    this.#deps = deps;
  }

  /** The registry: every fn's model name and the history, read from the store on first use. */
  index(): Promise<FnNameIndex> {
    if (this.#index !== undefined) return Promise.resolve(this.#index);
    this.#loading ??= this.#load();
    return this.#loading;
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
    const holder = (await this.index()).collision(fn) ?? (claimed?.get(model) === fn ? undefined : claimed?.get(model));
    if (holder !== undefined) return `${fn} would be called ${model} by the model, which is ${holder}'s name: pick another name`;
    claimed?.set(model, fn);
    return undefined;
  }

  /**
   * What an import or a save changed: the fns written join (an availability change re-adds, which changes nothing), a
   * fn that went moves to the history. Names of other sections in `removed` are ignored.
   */
  changed(removed: readonly QualifiedName[], written: readonly FnRecord[]): void {
    const index = this.#index;
    if (index === undefined) return; // not read yet: the store already holds the change, so the first read has it
    for (const fn of written) index.add(fn.name);
    const gone: ModelFnNameHistory[] = [];
    const now = this.#deps.clock();
    for (const name of removed) {
      if (!index.isFn(name)) continue;
      const entry = index.remove(name, now);
      if (entry !== undefined) gone.push(entry);
    }
    if (gone.length === 0) return;
    this.#deps.store.table('modelFnNameHistory').putAll(gone).catch((error: unknown) => {
      this.#deps.log.error('catalog.fn-names.history-failed', { fns: gone.map((entry) => entry.fn) }, error);
    });
  }

  async #load(): Promise<FnNameIndex> {
    const { store } = this.#deps;
    const history: ModelFnNameHistory[] = [];
    for await (const row of rows(store.table('modelFnNameHistory'))) history.push(row);
    const fns: QualifiedName[] = [];
    for await (const row of rows(store.table('fns'))) fns.push(row.name);
    const index = FnNameIndex.of(fns, history);
    this.#index = index;
    return index;
  }
}
