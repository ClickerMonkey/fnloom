/**
 * Fns and context search, in the hub's database. The filters are SQL over the hub's tables: kind, system, instance
 * and mode over `fnFacts`, the types read or written over `fnTypes`, systems over `context`. What they let through is
 * ranked by words and meaning inside the database (the index search's `within`, which FTS5 and sqlite-vec filter
 * themselves), best first; without text it is listed by name. Nothing is loaded whole and no vector is compared here.
 * What the asker may not see is never counted; `visibility` and `available` are checked on each hit as it comes.
 */
import { QualifiedName, type ContextRecord, type FnRecord, type FnSearchHit, type FnSearchPage, type FnSearchQuery, type RowOf, type SearchItemKind } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import type { AccessService } from '../access/index.ts';
import type { FnViewSource } from '../contextor/index.ts';
import type { Search } from '../index/index.ts';
import type { HubStore, Where } from '../store/index.ts';
import { rows } from '../execution/pages.ts';
import type { FnsTuning } from './env.ts';
import type { Asker, FnSearch } from './index.ts';

/** What search reads. */
export interface FnSearchDeps {
  readonly store: () => HubStore;
  readonly catalog: () => Pick<Catalog, 'fn' | 'context' | 'availability'>;
  readonly search: () => Pick<Search, 'search'>;
  readonly views: () => Pick<FnViewSource, 'view'>;
  readonly access: () => Pick<AccessService, 'sharing'>;
  readonly tuning: Pick<FnsTuning, 'HARNESS_FN_SEARCH_LIMIT' | 'HARNESS_FN_SEARCH_CANDIDATES'>;
}

/** An item the filters let through. */
interface Candidate {
  readonly kind: SearchItemKind;
  readonly key: QualifiedName;
}

/** Whether a query filters on anything only fns have (so context can't match it). */
function fnOnly(query: FnSearchQuery): boolean {
  return query.kinds !== undefined || query.instance !== undefined || query.modes !== undefined || query.types !== undefined || query.visibility !== undefined;
}

/** Search over the hub's database. */
export class StoreFnSearch implements FnSearch {
  readonly #deps: FnSearchDeps;

  constructor(deps: FnSearchDeps) {
    this.#deps = deps;
  }

  async search(query: FnSearchQuery, asker: Asker): Promise<FnSearchPage> {
    const limit = query.limit ?? this.#deps.tuning.HARNESS_FN_SEARCH_LIMIT;
    const offset = query.offset ?? 0;
    const items: SearchItemKind[] = (query.items ?? ['fn', 'context']).filter((item) => item === 'fn' || !fnOnly(query));
    if (items.length === 0) return { items: [] };
    const candidates = await this.#candidates(query, items);
    const text = query.text?.trim() ?? '';
    // one more than the page, so the page knows whether another follows
    const wanted = offset + limit + 1;
    const found = text === '' || query.order === 'name'
      ? await this.#byName(query, items, candidates, wanted, asker)
      : await this.#byScore(query, items, candidates, text, wanted, asker);
    const page = found.slice(offset, offset + limit);
    return { items: page, ...(found.length > offset + limit ? { next: offset + limit } : {}) };
  }

  /**
   * The items the filters let through, from the database, or undefined when nothing filters (every item can match). A
   * filter that lets through more than the candidate cap counts as none: the whole index is ranked and each hit
   * checked instead.
   */
  async #candidates(query: FnSearchQuery, items: readonly SearchItemKind[]): Promise<Candidate[] | undefined> {
    if (query.systems === undefined && query.names === undefined && !fnOnly(query)) return undefined;
    const cap = this.#deps.tuning.HARNESS_FN_SEARCH_CANDIDATES;
    const store = this.#deps.store();
    const out: Candidate[] = [];
    if (items.includes('fn')) {
      const typed = await this.#typed(query);
      const where: Where<RowOf<'fnFacts'>> = {
        ...(query.systems === undefined ? {} : { system: { in: query.systems } }),
        ...(query.kinds === undefined ? {} : { kind: { in: query.kinds } }),
        ...(query.modes === undefined ? {} : { mode: { in: query.modes } }),
        ...(query.instance === undefined ? {} : { instance: query.instance }),
        ...(query.names === undefined ? {} : { fn: { in: query.names } }),
      };
      for await (const row of rows(store.table('fnFacts'), { where, order: [['fn', 'asc']] })) {
        if (typed !== undefined && !typed.has(row.fn)) continue;
        out.push({ kind: 'fn', key: row.fn });
        if (out.length > cap) return undefined;
      }
    }
    if (items.includes('context') && (query.systems !== undefined || query.names !== undefined)) {
      const where: Where<RowOf<'context'>> = {
        ...(query.systems === undefined ? {} : { system: { in: query.systems } }),
        ...(query.names === undefined ? {} : { name: { in: query.names } }),
      };
      for await (const row of rows(store.table('context'), { where, order: [['name', 'asc']] })) {
        if (row.disabled === true) continue;
        out.push({ kind: 'context', key: row.name });
        if (out.length > cap) return undefined;
      }
    }
    return out;
  }

  /** The fns that read or write the asked types (from `fnTypes`), or undefined when the query names none. */
  async #typed(query: FnSearchQuery): Promise<ReadonlySet<QualifiedName> | undefined> {
    const reads = query.types?.reads ?? [];
    const writes = query.types?.writes ?? [];
    if (reads.length === 0 && writes.length === 0) return undefined;
    const table = this.#deps.store().table('fnTypes');
    const fns = new Set<QualifiedName>();
    if (reads.length > 0) for await (const row of rows(table, { where: { type: { in: reads }, use: 'read' } })) fns.add(row.fn);
    if (writes.length > 0) for await (const row of rows(table, { where: { type: { in: writes }, use: 'write' } })) fns.add(row.fn);
    return fns;
  }

  /** Ranked by words and meaning in the database, best first, keeping only hits the asker may have. */
  async #byScore(query: FnSearchQuery, items: readonly SearchItemKind[], candidates: Candidate[] | undefined, text: string, wanted: number, asker: Asker): Promise<FnSearchHit[]> {
    if (candidates?.length === 0) return [];
    const out: FnSearchHit[] = [];
    await this.#deps.search().search({
      text, kinds: items, limit: wanted,
      ...(candidates === undefined ? {} : { within: candidates }),
      ...(query.match === undefined ? {} : { match: query.match }),
      ...(query.systems === undefined ? {} : { systems: query.systems }),
      keep: async (hit) => {
        const name = QualifiedName.safeParse(hit.key);
        if (!name.success || (hit.kind !== 'fn' && hit.kind !== 'context')) return false;
        const shown = await this.#hit(query, { kind: hit.kind, key: name.data }, asker, hit.score);
        if (shown !== undefined) out.push(shown);
        return shown !== undefined;
      },
    });
    return out;
  }

  /** Listed by name: the candidates, or every fn (then context) in name order when nothing filters. */
  async #byName(query: FnSearchQuery, items: readonly SearchItemKind[], candidates: Candidate[] | undefined, wanted: number, asker: Asker): Promise<FnSearchHit[]> {
    const out: FnSearchHit[] = [];
    const take = async (candidate: Candidate): Promise<boolean> => {
      const shown = await this.#hit(query, candidate, asker, undefined);
      if (shown !== undefined) out.push(shown);
      return out.length >= wanted;
    };
    if (candidates !== undefined) {
      for (const candidate of [...candidates].sort((a, b) => a.key.localeCompare(b.key))) if (await take(candidate)) break;
      return out;
    }
    const store = this.#deps.store();
    if (items.includes('fn')) {
      for await (const row of rows(store.table('fnFacts'), { order: [['fn', 'asc']] })) if (await take({ kind: 'fn', key: row.fn })) return out;
    }
    if (items.includes('context')) {
      for await (const row of rows(store.table('context'), { order: [['name', 'asc']] })) if (row.disabled !== true && await take({ kind: 'context', key: row.name })) return out;
    }
    return out;
  }

  /** A candidate as a hit, or undefined when the asker may not have it (or a per-hit filter leaves it out). */
  async #hit(query: FnSearchQuery, candidate: Candidate, asker: Asker, score: number | undefined): Promise<FnSearchHit | undefined> {
    if (asker.keep !== undefined && !asker.keep(candidate.kind, candidate.key)) return undefined;
    const catalog = this.#deps.catalog();
    if (candidate.kind === 'context') {
      const record = await catalog.context(candidate.key);
      if (record === undefined || record.disabled === true || !asker.access.seesContext(record)) return undefined;
      return contextHit(record, score);
    }
    const record = await catalog.fn(candidate.key);
    if (record === undefined || record.disabled || !asker.access.seesFn(record)) return undefined;
    if (query.visibility !== undefined && !(await this.#visible(record, query.visibility, asker))) return undefined;
    const availability = await catalog.availability(record.name);
    const available = availability === true && asker.access.mayUse(record);
    if (query.available !== false && !available) return undefined;
    const facts = await this.#deps.store().table('fnFacts').get(record.name);
    const view = await this.#deps.views().view(record.name);
    return {
      item: 'fn', name: record.name, system: record.system, description: record.decl.description, kind: record.decl.kind,
      ...(facts === undefined ? {} : { mode: facts.mode }),
      ...(view === undefined ? {} : { signature: `${record.name}(${view.args}) → ${view.returns}` }),
      ...(facts?.instance === undefined ? {} : { instance: facts.instance }),
      ...(score === undefined ? {} : { score }),
      available,
      ...(available ? {} : { unavailable: availability === true ? 'connect your account to use this fn' : availability.detail }),
    };
  }

  /** Whether a fn has the asked visibility for the asker: theirs, given to them by someone else, or everyone's. */
  async #visible(record: FnRecord, visibility: NonNullable<FnSearchQuery['visibility']>, asker: Asker): Promise<boolean> {
    const sharing = await this.#deps.access().sharing({ kind: 'fn', fn: record.name });
    switch (visibility) {
      case 'mine': return sharing.owner === asker.actor;
      case 'shared': return sharing.owner !== asker.actor && sharing.visibility !== 'public';
      case 'public': return sharing.visibility === 'public';
    }
  }
}

/** A context item as a hit. */
function contextHit(record: ContextRecord, score: number | undefined): FnSearchHit {
  return { item: 'context', name: record.name, system: record.system, description: record.decl.description, ...(score === undefined ? {} : { score }), available: true };
}
