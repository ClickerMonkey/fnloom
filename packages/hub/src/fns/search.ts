/**
 * Fns and context search, in the hub's database. The filters are SQL over the hub's tables: kind, system, instance
 * and mode over `fnFacts` (and what fns change in the hub, build 6, on the rows it lets through), the types read or
 * written over `fnTypes`, systems and the context list's own filters (`FnSearchQuery.filters`, `query/columns.ts`) over
 * `context` (`HubStore.lists`). What they let through is
 * ranked by words and meaning inside the database (the index search's `within`, which FTS5 and sqlite-vec filter
 * themselves), best first; without text it is listed by name. Nothing is loaded whole and no vector is compared here.
 * What the asker may not see is never counted; `visibility` and `available` are checked on each hit as it comes, and a
 * hit that can't be used now (kept with `available: false`) carries what blocks it (`FnSearchHit.blocked`).
 * Context is searched by its own text and by each of its heading sections (`contextSection`, `index/context-sections.ts`):
 * an item found by several counts once, at its best, and says the section that found it. Every hit says which index
 * found it (`matched`: words, meaning or both).
 */
import { contextOff, effectsLine, QualifiedName, type ContextRecord, type Filter, type IndexedKind, type SearchSection, type RegistryEffect, type FnRecord, type FnSearchHit, type FnSearchPage, type FnSearchQuery, type RowOf, type SearchHit, type SearchItemKind } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import type { AccessService } from '../access/index.ts';
import { seesContextAs } from '../access/scope.ts';
import { contextSections, sectionKeyOf } from '../index/context-sections.ts';
import { contextText } from '../index/indexer.ts';
import { CONTEXT_COLUMNS } from '../query/columns.ts';
import type { FnViewSource } from '../contextor/index.ts';
import { unavailableBlock } from '../contextor/views.ts';
import type { Search } from '../index/index.ts';
import type { HubStore, Where } from '../store/index.ts';
import { allRows, rows } from '../store/rows.ts';
import type { FnsTuning } from './env.ts';
import type { Asker, FnSearch } from './index.ts';

/** What search reads. */
export interface FnSearchDeps {
  readonly store: () => HubStore;
  readonly catalog: () => Pick<Catalog, 'fn' | 'context'>;
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

/** What the index searches for some items: each, and a context item's heading sections too. */
function indexKinds(items: readonly SearchItemKind[]): IndexedKind[] {
  return items.flatMap((item): IndexedKind[] => (item === 'context' ? ['context', 'contextSection'] : [item]));
}

/** The context list filters of a query, with its systems as one more (the same SQL either way). */
function contextFilters(query: FnSearchQuery): Filter[] {
  return [...(query.filters ?? []), ...(query.systems === undefined ? [] : [{ field: 'system', op: 'in' as const, values: query.systems }])];
}

/** Whether a query filters on anything only fns have (so context can't match it). */
function fnOnly(query: FnSearchQuery): boolean {
  return query.kinds !== undefined || query.instance !== undefined || query.modes !== undefined || query.types !== undefined || query.visibility !== undefined || query.effects !== undefined;
}

/** Whether a fn's registry effects meet a query's `effects` filter (one of them, with its action and kind when given). */
function changesAsAsked(query: FnSearchQuery, registry: readonly RegistryEffect[] | undefined): boolean {
  if (query.effects === undefined) return true;
  return query.effects.some((wanted) => (registry ?? []).some((effect) => effect.thing === wanted.thing
    && (wanted.action === undefined || effect.action === wanted.action) && (wanted.kind === undefined || effect.kind === wanted.kind)));
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
    // the context list's filters match context only, and the fn-only filters fns only
    const items: SearchItemKind[] = (query.items ?? ['fn', 'context']).filter((item) => (item === 'fn' ? query.filters === undefined : !fnOnly(query)));
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
    if (query.systems === undefined && query.names === undefined && query.filters === undefined && !fnOnly(query)) return undefined;
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
        if (!changesAsAsked(query, row.registry)) continue;
        out.push({ kind: 'fn', key: row.fn });
        if (out.length > cap) return undefined;
      }
    }
    if (items.includes('context')) {
      const found = await this.#contextNames(query, cap + 1 - out.length);
      if (found === undefined) return undefined;
      out.push(...found.map((key) => ({ kind: 'context' as const, key })));
    }
    return out;
  }

  /**
   * The context items the query's context filters let through, by name, from the database (`HubStore.lists`), fewer
   * than `most`; undefined when there are more (the filters then count as none, and each hit is checked on its own).
   */
  async #contextNames(query: FnSearchQuery, most: number): Promise<QualifiedName[] | undefined> {
    const out: QualifiedName[] = [];
    const store = this.#deps.store();
    const filters = contextFilters(query);
    for (let offset = 0; out.length < most; offset += CONTEXT_PAGE) {
      const page = await store.lists.find({ table: 'context', fields: CONTEXT_COLUMNS, filters, keys: query.names, sort: [{ field: 'name', dir: 'asc' }], offset, limit: CONTEXT_PAGE });
      for (const row of page.items) if (query.off === true || !contextOff(row)) out.push(row.name);
      if (page.items.length < CONTEXT_PAGE) return out.length < most ? out : undefined;
    }
    return undefined;
  }

  /** Whether one context item passes the query's context filters, asked of the database (used past the candidate cap). */
  async #contextPasses(query: FnSearchQuery, name: QualifiedName): Promise<boolean> {
    const filters = contextFilters(query);
    if (filters.length === 0) return true;
    const found = await this.#deps.store().lists.find({ table: 'context', fields: CONTEXT_COLUMNS, filters, keys: [name], sort: [], offset: 0, limit: 1 });
    return found.items.length > 0;
  }

  /** The candidates and, for each context item among them, its heading sections (by their parent, in the database). */
  async #within(candidates: readonly Candidate[]): Promise<Array<{ kind: IndexedKind; key: string }>> {
    const contexts = candidates.filter((c) => c.kind === 'context').map((c) => c.key);
    if (contexts.length === 0) return [...candidates];
    const parts = await allRows(this.#deps.store().table('index'), { where: { kind: 'contextSection', parent: { in: contexts } } });
    return [...candidates, ...parts.map((row) => ({ kind: row.kind, key: row.key }))];
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
    // a context item found by its text and by its sections counts once, at its best
    const seen = new Set<string>();
    await this.#deps.search().search({
      text, kinds: indexKinds(items), limit: wanted,
      ...(candidates === undefined ? {} : { within: await this.#within(candidates) }),
      ...(query.match === undefined ? {} : { match: query.match }),
      ...(query.systems === undefined ? {} : { systems: query.systems }),
      keep: async (hit) => {
        const kind = hit.kind === 'contextSection' ? 'context' : hit.kind;
        const name = QualifiedName.safeParse(hit.kind === 'contextSection' ? hit.parent : hit.key);
        if (!name.success || (kind !== 'fn' && kind !== 'context') || seen.has(`${kind}:${name.data}`)) return false;
        // past the candidate cap the filters counted as none: each context hit is asked of the database instead
        if (kind === 'context' && candidates === undefined && !(await this.#contextPasses(query, name.data))) return false;
        const section = hit.kind === 'contextSection' ? sectionKeyOf(hit.key, name.data) : undefined;
        const shown = await this.#hit(query, { kind, key: name.data }, asker, { ...hit, ...(section === undefined ? {} : { section }) });
        if (shown === undefined) return false;
        seen.add(`${kind}:${name.data}`);
        out.push(shown);
        return true;
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
      for await (const row of rows(store.table('context'), { order: [['name', 'asc']] })) if ((query.off === true || !contextOff(row)) && await take({ kind: 'context', key: row.name })) return out;
    }
    return out;
  }

  /** A candidate as a hit, or undefined when the asker may not have it (or a per-hit filter leaves it out). */
  async #hit(query: FnSearchQuery, candidate: Candidate, asker: Asker, found: Scored | undefined): Promise<FnSearchHit | undefined> {
    if (asker.keep !== undefined && !asker.keep(candidate.kind, candidate.key)) return undefined;
    const catalog = this.#deps.catalog();
    if (candidate.kind === 'context') {
      const record = await catalog.context(candidate.key);
      if (record === undefined || (query.off !== true && contextOff(record)) || !seesContextAs(asker.access, record, asker.session)) return undefined;
      return contextHit(record, found);
    }
    const record = await catalog.fn(candidate.key);
    if (record === undefined || record.disabled || !asker.access.seesFn(record)) return undefined;
    if (query.visibility !== undefined && !(await this.#visible(record, query.visibility, asker))) return undefined;
    // an unavailable fn is a hit too when the query keeps them (`available: false`), marked with what blocks it
    const blocked = unavailableBlock(record, asker.access);
    if (query.available !== false && blocked !== undefined) return undefined;
    const facts = await this.#deps.store().table('fnFacts').get(record.name);
    // checked on each hit too: over the candidate cap the filters count as none
    if (!changesAsAsked(query, facts?.registry)) return undefined;
    const effects = effectsLine(facts?.registry ?? []);
    const view = await this.#deps.views().view(record.name);
    return {
      item: 'fn', name: record.name, system: record.system, description: record.decl.description, kind: record.decl.kind,
      ...(facts === undefined ? {} : { mode: facts.mode }),
      ...(view === undefined ? {} : { signature: `${record.name}(${view.args}) → ${view.returns}` }),
      ...(effects === undefined ? {} : { effects }),
      ...(facts?.instance === undefined ? {} : { instance: facts.instance }),
      ...scoresOf(found),
      available: blocked === undefined,
      ...(blocked === undefined ? {} : { blocked }),
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

/** A context item as a hit, with the heading section that found it when one did. */
function contextHit(record: ContextRecord, found: Scored | undefined): FnSearchHit {
  const section = found?.section === undefined ? undefined : sectionOf(record, found.section);
  return {
    item: 'context', name: record.name, system: record.system, description: record.decl.description, ...scoresOf(found),
    ...(section === undefined ? {} : { section }), available: true,
  };
}

/** A context item's heading section by key, as its text is cut now (`contextSections`). */
function sectionOf(record: ContextRecord, key: string): SearchSection | undefined {
  const section = contextSections(contextText(record.name, record.decl)).find((s) => s.key === key);
  return section === undefined ? undefined : { key: section.key, path: [...section.path], title: section.title };
}

/** How a text search scored a hit, when it was one, and the section key that found a context item. */
type Scored = Pick<SearchHit, 'rank' | 'similarity' | 'matched'> & { readonly section?: string };

/**
 * A hit's `rank` (its place in the order), `similarity` (its measured fit, when there is one) and `matched` (which
 * index found it), each its own field.
 */
function scoresOf(found: Scored | undefined): Pick<FnSearchHit, 'rank' | 'similarity' | 'matched'> {
  if (found === undefined) return {};
  return { rank: found.rank, ...(found.similarity === undefined ? {} : { similarity: found.similarity }), ...(found.matched === undefined ? {} : { matched: found.matched }) };
}

/** Context rows read per page while gathering the filters' candidates. */
const CONTEXT_PAGE = 200;
