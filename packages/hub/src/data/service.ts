/**
 * The data system on the hub store (build 8). Records live in the `records` table with a version per change in
 * `recordVersions`, written together in one transaction. Reads go to the database (`HubStore.recordQueries`: filters
 * and sorts on the value's top-level fields, counted and offset-paged); text search goes to the store's text index and,
 * for a type that asks for it (`records.search.embed`), meaning too through the hub's search, keyed
 * `<type>#<record id>` (`<type>#<owner>#<record id>` for a person-owned type), so the index query itself keeps a search
 * to one type and, for anyone but an admin, to their own records. Nothing loads a whole set. A change's `run` is the
 * asker's (the run the hub checked), never one the caller names.
 */
import { reject } from '@ayepi/core';
import {
  DataRecord, mintId, OPS_BY_TYPE, recordVersionId,
  type DataSetPage, type DataSetQuery, type DataSetView, type Filter, type IdRandom, type QualifiedName, type RecordGet, type RecordId, type RecordPage,
  type RecordQuery, type RecordRemove, type RecordSave, type RecordStorage, type RecordTableQuery, type RecordUpdate, type RecordVersion, type RecordVersionsPage,
  type RecordVersionsQuery, type ResultTable, type Sort, type TypeRecord,
} from '@harness/core';
import type { Catalog } from '../catalog/index.ts';
import type { Indexer, Search } from '../index/index.ts';
import type { HubStore } from '../store/index.ts';
import { RECORD_FIELD } from '../store/records.ts';
import type { DataEnv } from './env.ts';
import { columnOf, fieldTypeOf, queryable, recordFields, type RecordField } from './fields.ts';
import type { DataAsker, DataService } from './index.ts';

/** What the data service uses. */
export interface DataDeps {
  readonly store: HubStore;
  readonly catalog: Pick<Catalog, 'type' | 'entries' | 'check'>;
  readonly indexer: () => Pick<Indexer, 'upsert' | 'remove'>;
  readonly search: () => Pick<Search, 'search'>;
  readonly settings: DataEnv;
  readonly clock: () => number;
  readonly random?: IdRandom;
}

/** A stored type as the service works with it. */
interface Stored {
  readonly type: TypeRecord & { readonly records: RecordStorage };
  readonly fields: readonly RecordField[];
}

/**
 * The index key of a record: its type, so a search keeps to one type, its owner when it has one, so a search keeps to
 * one person's, and its id (always last).
 */
const indexKey = (record: Pick<DataRecord, 'type' | 'id' | 'owner'>): string => `${indexPrefix(record.type, record.owner)}${record.id}`;

/** The record table's id column (`ResultTable.records.id`). */
const RECORD_ID_COLUMN = 'id';

/** The start of the index keys of a type's records (of one owner's, when given). */
const indexPrefix = (type: QualifiedName, owner: DataRecord['owner']): string => (owner === undefined ? `${type}#` : `${type}#${owner}#`);

/** An offset cursor, as the record pages give them out. */
function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) { return 0; }
  const offset = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(offset) || offset < 0 || String(offset) !== cursor) { throw reject(400, 'BAD_CURSOR', 'That cursor is not one this list gave out.'); }
  return offset;
}

/** The text a record is searched by: its search fields' values, in order. */
function searchText(value: unknown, storage: RecordStorage, title: string): string {
  const fields = typeof value === 'object' && value !== null ? Object.entries(value) : [];
  const texts = storage.search.text.flatMap((name) => fields.filter(([key]) => key === name).map(([, v]) => (typeof v === 'string' ? v : JSON.stringify(v))));
  return [title, ...texts].filter((text) => text !== '').join('\n');
}

/** The data system over the hub store. */
export class StoreDataService implements DataService {
  readonly #deps: DataDeps;

  constructor(deps: DataDeps) {
    this.#deps = deps;
  }

  async sets(query: DataSetQuery, asker: DataAsker): Promise<DataSetPage> {
    const text = query.text?.trim().toLowerCase() ?? '';
    // the stored types come from the catalog's accepted manifests (kept for gin's synchronous lookups), never a table scan
    const entries = (await this.#deps.catalog.entries('types', query.system === undefined ? {} : { system: query.system }))
      .filter((entry) => entry.decl.records !== undefined)
      .filter((entry) => text === '' || `${entry.name} ${entry.decl.description} ${entry.decl.display.label}`.toLowerCase().includes(text))
      .sort((a, b) => a.name.localeCompare(b.name));
    const seen: Array<Stored['type']> = [];
    for (const entry of entries) {
      const type = await this.#deps.catalog.type(entry.name);
      if (type?.records !== undefined && asker.access.seesType(type)) { seen.push({ ...type, records: type.records }); }
    }
    const offset = offsetOf(query.cursor);
    const page = seen.slice(offset, offset + (query.limit ?? this.#deps.settings.HARNESS_DATA_SET_PAGE));
    const counts = this.#deps.store.recordQueries;
    const shared = await counts.counts(page.filter((t) => !this.#ownOnly(t, asker)).map((t) => t.name));
    const own = await counts.counts(page.filter((t) => this.#ownOnly(t, asker)).map((t) => t.name), asker.actor);
    const items = page.map((type): DataSetView => {
      const count = shared.get(type.name) ?? own.get(type.name);
      return {
        type: type.name, system: type.system, description: type.description, storage: type.records, records: count?.count ?? 0,
        ...(count?.updatedAt === undefined ? {} : { updatedAt: count.updatedAt }),
      };
    });
    const next = offset + page.length;
    return next < seen.length ? { items, cursor: String(next) } : { items };
  }

  async find(query: RecordQuery, asker: DataAsker): Promise<RecordPage> {
    const stored = await this.#stored(query.type, asker);
    const list = query.query ?? {};
    const offset = offsetOf(list.cursor);
    const limit = list.limit ?? this.#deps.settings.HARNESS_RECORD_PAGE;
    const { filters, sort } = this.#checked(stored, list.filters ?? [], list.sort ?? []);
    const text = [query.search, list.text].filter((t): t is string => t !== undefined && t.trim() !== '').join(' ');
    const ranked = text === '' ? undefined : await this.#searched(stored, text, asker);
    const found = await this.#deps.store.recordQueries.find({
      type: stored.type.name, owner: this.#ownOnly(stored.type, asker) ? asker.actor : undefined,
      ids: ranked, filters, sort,
      // a search with no sort of its own is read in rank order below, so it pages over the whole ranked set
      offset: ranked !== undefined && sort.length === 0 ? 0 : offset, limit: ranked !== undefined && sort.length === 0 ? ranked.length || 1 : limit,
    });
    const items = ranked !== undefined && sort.length === 0
      ? [...found.items].sort((a, b) => ranked.indexOf(a.id) - ranked.indexOf(b.id)).slice(offset, offset + limit)
      : found.items;
    const next = offset + items.length;
    return next < found.total ? { items, cursor: String(next) } : { items };
  }

  async get(query: RecordGet, asker: DataAsker): Promise<DataRecord | undefined> {
    const stored = await this.#stored(query.type, asker);
    const record = await this.#deps.store.table('records').get(query.id);
    return record === undefined || !this.#sees(record, stored, asker) ? undefined : record;
  }

  async table(query: RecordTableQuery, asker: DataAsker): Promise<ResultTable> {
    const stored = await this.#stored(query.type, asker);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? this.#deps.settings.HARNESS_RECORD_PAGE;
    const page = await this.find({ type: query.type, query: { ...query.query, cursor: offset === 0 ? undefined : String(offset), limit }, ...(query.search === undefined ? {} : { search: query.search }) }, asker);
    const fields = stored.fields;
    return {
      // one column per field (a scalar one editable in place), then the record's id: the key, and a ref to its type so a
      // row's actions find their record
      columns: [
        ...fields.map((field) => ({ ...columnOf(field), ...(queryable(field) ? { editable: true } : {}) })),
        { name: RECORD_ID_COLUMN, label: 'Record', kind: 'text', nullable: false, ref: stored.type.name, key: true },
      ],
      records: { type: stored.type.name, id: RECORD_ID_COLUMN },
      rows: page.items.map((record) => {
        const value = typeof record.value === 'object' && record.value !== null && !Array.isArray(record.value) ? record.value : {};
        return [...fields.map((field) => value[field.name] ?? null), record.id];
      }),
      offset, limit, truncated: page.cursor !== undefined,
      sort: (query.query?.sort ?? []).map((s) => ({ column: s.field, dir: s.dir })),
    };
  }

  async save(input: RecordSave, asker: DataAsker): Promise<DataRecord> {
    const stored = await this.#stored(input.type, asker);
    const problems = await this.#deps.catalog.check(stored.type.system, stored.type.def, input.value);
    if (problems.length > 0) { throw reject(400, 'RECORD_INVALID', `the value doesn't fit ${stored.type.name}: ${problems.join('; ')}`); }
    const now = this.#deps.clock();
    const owner = stored.type.records.owner === 'person' ? asker.actor : undefined;
    const record = await this.#deps.store.tx(async (tx) => {
      const records = tx.table('records');
      const existing = input.id !== undefined ? await records.get(input.id)
        : stored.type.records.shape === 'value' ? (await tx.recordQueries.find({ type: stored.type.name, owner, filters: [], sort: [], offset: 0, limit: 1 })).items[0] : undefined;
      if (input.id !== undefined && (existing === undefined || !this.#sees(existing, stored, asker))) { throw reject(404, 'RECORD_NOT_FOUND', `no record ${input.id} of ${stored.type.name}`); }
      if (input.expect !== undefined && existing !== undefined && existing.version !== input.expect) {
        throw reject(409, 'RECORD_MOVED_ON', `${existing.id} is at version ${String(existing.version)}, not ${String(input.expect)}: read it again and redo the change`);
      }
      const title = this.#titleOf(stored, input.value);
      const next = DataRecord.parse({
        id: existing?.id ?? mintId('record', this.#deps.random), type: stored.type.name, value: input.value, ...(owner === undefined ? {} : { owner: existing?.owner ?? owner }),
        title, version: (existing?.version ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now,
        updatedBy: asker.actor, ...(asker.system === undefined ? {} : { updatedBySystem: asker.system }), ...(asker.run === undefined ? {} : { run: asker.run }),
      });
      await records.put(next);
      await tx.table('recordVersions').put(this.#version(next, existing === undefined ? 'created' : 'updated', next.value));
      return next;
    });
    await this.#index(stored, record);
    return record;
  }

  async update(input: RecordUpdate, asker: DataAsker): Promise<DataRecord> {
    const stored = await this.#stored(input.type, asker);
    const current = await this.#deps.store.table('records').get(input.id);
    if (current === undefined || !this.#sees(current, stored, asker)) { throw reject(404, 'RECORD_NOT_FOUND', `no record ${input.id} of ${stored.type.name}`); }
    const fields = new Set(stored.fields.map((field) => field.name));
    const unknown = Object.keys(input.set).filter((name) => !fields.has(name));
    if (unknown.length > 0) { throw reject(400, 'RECORD_INVALID', `${stored.type.name} has no field ${unknown.join(', ')}`); }
    const value = typeof current.value === 'object' && current.value !== null && !Array.isArray(current.value) ? current.value : {};
    // the save checks the merged value and the version, in its own transaction
    return this.save({ type: input.type, id: input.id, value: { ...value, ...input.set }, expect: input.expect ?? current.version, ...(input.run === undefined ? {} : { run: input.run }) }, asker);
  }

  async remove(input: RecordRemove, asker: DataAsker): Promise<boolean> {
    const stored = await this.#stored(input.type, asker);
    const removed = await this.#deps.store.tx(async (tx) => {
      const record = await tx.table('records').get(input.id);
      if (record === undefined || !this.#sees(record, stored, asker)) { return undefined; }
      await tx.table('records').remove(record.id);
      const gone = { ...record, version: record.version + 1, updatedAt: this.#deps.clock(), updatedBy: asker.actor, ...(asker.run === undefined ? {} : { run: asker.run }) };
      await tx.table('recordVersions').put(this.#version(gone, 'removed', record.value));
      return record;
    });
    if (removed === undefined) { return false; }
    const key = indexKey(removed);
    if (stored.type.records.search.embed) { await this.#deps.indexer().remove('record', [key]); } else { await this.#deps.store.text.remove('record', [key]); }
    return true;
  }

  async versions(query: RecordVersionsQuery, asker: DataAsker): Promise<RecordVersionsPage> {
    const stored = await this.#stored(query.type, asker);
    const page = await this.#deps.store.table('recordVersions').find({
      where: { record: query.id, type: stored.type.name }, order: [['number', 'desc']], limit: query.limit ?? this.#deps.settings.HARNESS_RECORD_PAGE, cursor: query.cursor,
    });
    // a person-owned record's history is its owner's (and admins'), as the record is; a removed one's, whoever wrote it
    if (this.#ownOnly(stored.type, asker)) {
      const current = await this.#deps.store.table('records').get(query.id);
      const theirs = current === undefined ? page.items.every((version) => version.by === asker.actor) : this.#sees(current, stored, asker);
      if (!theirs) { return { items: [] }; }
    }
    return page;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** A stored type the asker sees, with its fields; refused (404) for anything else. */
  async #stored(name: QualifiedName, asker: DataAsker): Promise<Stored> {
    const type = await this.#deps.catalog.type(name);
    if (type?.records === undefined || !asker.access.seesType(type)) { throw reject(404, 'NO_STORED_TYPE', `no stored type ${name}`); }
    return { type: { ...type, records: type.records }, fields: recordFields(type.def) };
  }

  /** Whether reads of a type keep to the asker's own records: a person-owned type, for anyone but an admin or its own system outside a run. */
  #ownOnly(type: Pick<TypeRecord, 'system'> & { readonly records: RecordStorage }, asker: DataAsker): boolean {
    if (type.records.owner !== 'person' || asker.access.admin) return false;
    // a system keeps the records of its own types outside a run (a session's status as it changes): it reads and
    // writes all of them, and a save keeps each record's owner
    return !(asker.system !== undefined && asker.run === undefined && asker.system === type.system);
  }

  /** Whether the asker sees a record of a stored type. */
  #sees(record: DataRecord, stored: Stored, asker: DataAsker): boolean {
    return record.type === stored.type.name && (!this.#ownOnly(stored.type, asker) || record.owner === asker.actor);
  }

  /** Filters and sorts on the type's queryable fields with operators their type takes; refused (400) otherwise. */
  #checked(stored: Stored, filters: readonly Filter[], sort: readonly Sort[]): { filters: Filter[]; sort: Sort[] } {
    const byName = new Map(stored.fields.map((field) => [field.name, field]));
    const problems: string[] = [];
    for (const filter of filters) {
      const field = byName.get(filter.field);
      if (field === undefined || !queryable(field) || !RECORD_FIELD.test(field.name)) { problems.push(`${stored.type.name} has no filterable field "${filter.field}".`); continue; }
      const ops: readonly string[] = OPS_BY_TYPE[fieldTypeOf(field)];
      if (!ops.includes(filter.op)) { problems.push(`${field.name} does not take "${filter.op}".`); }
    }
    for (const key of sort) {
      const field = byName.get(key.field);
      if (field === undefined || !queryable(field) || !RECORD_FIELD.test(field.name)) { problems.push(`${stored.type.name} cannot be sorted by "${key.field}".`); }
    }
    if (problems.length > 0) { throw reject(400, 'BAD_RECORD_QUERY', problems.join(' ')); }
    return { filters: [...filters], sort: [...sort] };
  }

  /**
   * The ids of a type's records that match text (and meaning, when the type is embedded), best first: the index query
   * keeps to the type's keys (and the asker's own, when reads keep to them), so other records never use up the depth.
   */
  async #searched(stored: Stored, text: string, asker: DataAsker): Promise<RecordId[]> {
    const prefix = indexPrefix(stored.type.name, this.#ownOnly(stored.type, asker) ? asker.actor : undefined);
    const depth = this.#deps.settings.HARNESS_RECORD_SEARCH_DEPTH;
    const keys = stored.type.records.search.embed
      ? (await this.#deps.search().search({ text, kinds: ['record'], limit: depth, prefix })).map((hit) => hit.key)
      : (await this.#deps.store.text.search({ text, kinds: ['record'], limit: depth, prefix })).map((hit) => hit.key);
    return keys.flatMap((key) => { const id = DataRecord.shape.id.safeParse(key.slice(key.lastIndexOf('#') + 1)); return id.success ? [id.data] : []; });
  }

  /** Keep a record's search text current. */
  async #index(stored: Stored, record: DataRecord): Promise<void> {
    const text = searchText(record.value, stored.type.records, record.title);
    const key = indexKey(record);
    if (stored.type.records.search.embed) {
      // embedded by the hub's embedder, a model call like any other; the words are searchable at once
      await this.#deps.indexer().upsert([{ kind: 'record', key, text, system: stored.type.system }], { vectors: 'background' });
    } else {
      await this.#deps.store.text.upsert([{ kind: 'record', key, text }]);
    }
  }

  /** A record's title: its type's `display.title` field, else its first text field, else its type's label. */
  #titleOf(stored: Stored, value: unknown): string {
    const fields = new Map<string, unknown>(typeof value === 'object' && value !== null ? Object.entries(value) : []);
    const named = stored.type.display.title === undefined ? undefined : fields.get(stored.type.display.title);
    const first = stored.fields.find((field) => field.kind === 'text' && typeof fields.get(field.name) === 'string');
    const title = typeof named === 'string' ? named : first === undefined ? undefined : fields.get(first.name);
    return typeof title === 'string' && title.trim() !== '' ? title.slice(0, 200) : stored.type.display.label;
  }

  /** A version row of a record. */
  #version(record: DataRecord, change: RecordVersion['change'], value: DataRecord['value']): RecordVersion {
    return {
      id: recordVersionId(record.id, record.version), record: record.id, type: record.type, number: record.version, change, value, at: record.updatedAt,
      ...(record.updatedBy === undefined ? {} : { by: record.updatedBy }), ...(record.updatedBySystem === undefined ? {} : { bySystem: record.updatedBySystem }),
      ...(record.run === undefined ? {} : { run: record.run }),
    };
  }
}

