/**
 * Suggestions for a message: the fns and context the index finds closest to its text, limited to what the session
 * allows (its systems, and always the hub's own), what is available now, and what people may be offered. Scores are
 * similarities of meaning, so a threshold can tell a fit from noise: while the query can't be embedded (no embedder,
 * or one too busy to answer in time) nothing is suggested, rather than whatever the words ranked first.
 */
import { QualifiedName, splitName, type SessionId, type Suggestion } from '@harness/core';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { Catalog } from '../catalog/index.ts';
import type { HubStore } from '../store/index.ts';
import type { Considered, Search, Suggester } from './index.ts';

/** Suggests fns and context from the index. */
export class IndexSuggester implements Suggester {
  readonly #store: HubStore;
  readonly #catalog: Catalog;
  readonly #search: Search;

  constructor(options: { store: HubStore; catalog: Catalog; search: Search }) {
    this.#store = options.store;
    this.#catalog = options.catalog;
    this.#search = options.search;
  }

  async suggest(input: { session: SessionId; text: string; limit: number }): Promise<Suggestion[]> {
    if (input.limit < 1) { return []; }
    return (await this.consider({ session: input.session, text: input.text, pool: input.limit * 2 })).offered.slice(0, input.limit);
  }

  async consider(input: { session: SessionId; text: string; pool: number }): Promise<Considered> {
    const out: Considered = { offered: [], hidden: [] };
    if (input.pool < 1 || input.text.trim() === '') { return out; }
    const session = await this.#store.table('sessions').get(input.session);
    if (session === undefined) { return out; }
    const allowed = (name: QualifiedName): boolean => {
      const { system } = splitName(name);
      return system === HUB_SYSTEM || session.systems === 'all' || session.systems.some((s) => s === system);
    };
    const hits = await this.#search.search({ text: input.text, kinds: ['fn', 'context'], limit: input.pool, meaning: true });
    for (const hit of hits) {
      const name = QualifiedName.safeParse(hit.key);
      if (!name.success || (hit.kind !== 'fn' && hit.kind !== 'context')) { continue; }
      const suggestion = !allowed(name.data) ? undefined : hit.kind === 'fn' ? await this.#fn(name.data, hit.score) : await this.#context(name.data, hit.score);
      if (suggestion === undefined) { out.hidden.push({ kind: hit.kind, name: name.data, score: hit.score }); }
      else { out.offered.push(suggestion); }
    }
    return out;
  }

  async #fn(name: QualifiedName, score: number): Promise<Suggestion | undefined> {
    const fn = await this.#catalog.fn(name);
    if (fn === undefined || fn.available !== true || fn.decl.visibility === 'none') { return undefined; }
    return { kind: 'fn', name, description: fn.decl.description, score };
  }

  async #context(name: QualifiedName, score: number): Promise<Suggestion | undefined> {
    const context = await this.#catalog.context(name);
    if (context === undefined || context.decl.suggest === 'none' || (await this.#catalog.availability(name)) !== true) { return undefined; }
    return { kind: 'context', name, description: context.decl.description, score };
  }
}
