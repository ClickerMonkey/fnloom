/**
 * The fake hub's data system, for tests only: records of stored types kept in memory and answered the way the hub
 * answers `records`, `record`, `recordTable`, `saveRecord` and `removeRecord` (filters and sorts on top-level fields,
 * text search over the type's text fields, offset cursors, versions, `expect`, person-owned records). The real hub
 * keeps them in its database and searches them there; nothing here is a pattern for a system's own code.
 */
import { reject } from '@ayepi/core';
import {
  mintId, recordVersionId,
  type ActorId, type ColumnKind, type DataRecord, type Filter, type GinTypeDef, type Json, type ListQuery, type QualifiedName, type RecordGet, type RecordPage,
  type RecordQuery, type RecordRemove, type RecordSave, type RecordStorage, type RecordTableQuery, type RecordVersion, type ResultColumn, type ResultTable, type RunId, type TypeDecl,
} from '@harness/core';

/** A stored type as the fake knows it: its declaration (with `records`). */
export type StoredTypeDecl = TypeDecl & { readonly records: RecordStorage };

/** How many records a page holds when the query names no limit. */
const DEFAULT_PAGE = 50;

/** Records of stored types in memory, answered like the hub's data endpoints. */
export class FakeRecords {
  /** Every record, by id, in the order saved. */
  readonly records = new Map<string, DataRecord>();
  /** Every version written, oldest first. */
  readonly versions: RecordVersion[] = [];
  readonly #types: (name: QualifiedName) => StoredTypeDecl | undefined;
  readonly #owner: () => ActorId;

  /** `types` finds a stored type's declaration (the system's manifest); `owner` is the person a run acts for. */
  constructor(types: (name: QualifiedName) => StoredTypeDecl | undefined, owner: () => ActorId) {
    this.#types = types;
    this.#owner = owner;
  }

  /** The records of one type, newest change first (what a test reads back). */
  of(type: QualifiedName): DataRecord[] {
    return [...this.records.values()].filter((record) => record.type === type).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  find(query: RecordQuery): RecordPage {
    const { rows, offset, limit } = this.#select(query, query.query);
    const items = rows.slice(offset, offset + limit);
    return { items, ...(offset + limit < rows.length ? { cursor: String(offset + limit) } : {}) };
  }

  get(body: RecordGet): { record?: DataRecord } {
    this.#stored(body.type);
    const record = this.records.get(body.id);
    return record === undefined || record.type !== body.type || !this.#sees(record, body.run) ? {} : { record };
  }

  table(body: RecordTableQuery): ResultTable {
    const decl = this.#stored(body.type);
    const offset = body.offset ?? 0;
    const limit = body.limit ?? DEFAULT_PAGE;
    const { rows } = this.#select(body, body.query);
    const fields = Object.entries(decl.def.props ?? {});
    const columns: ResultColumn[] = [
      ...fields.map(([name, prop]): ResultColumn => ({ name, kind: columnKind(prop.type), nullable: prop.type.name === 'optional' })),
      { name: 'id', kind: 'text', nullable: false, ref: body.type },
    ];
    const page = rows.slice(offset, offset + limit);
    return {
      columns,
      rows: page.map((record) => [...fields.map(([name]) => fieldOf(record.value, name) ?? null), record.id]),
      offset,
      limit,
      total: rows.length,
      truncated: offset + limit < rows.length,
      sort: [],
    };
  }

  save(body: RecordSave, time = Date.now()): DataRecord {
    const decl = this.#stored(body.type);
    const existing = body.id === undefined
      ? (decl.records.shape === 'value' ? this.of(body.type).find((record) => this.#sees(record, body.run)) : undefined)
      : this.records.get(body.id);
    if (body.id !== undefined && (existing === undefined || existing.type !== body.type || !this.#sees(existing, body.run))) {
      throw reject(404, 'NOT_FOUND', `No ${body.type} record ${body.id}.`);
    }
    if (body.expect !== undefined && existing !== undefined && existing.version !== body.expect) {
      throw reject(409, 'RECORD_MOVED', `The record is at version ${String(existing.version)}, not ${String(body.expect)}.`);
    }
    const record: DataRecord = {
      id: existing?.id ?? mintId('record'),
      type: body.type,
      value: body.value,
      ...(decl.records.owner === 'person' ? { owner: existing?.owner ?? this.#owner() } : {}),
      title: titleOf(decl, body.value),
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? time,
      updatedAt: time,
      updatedBy: this.#owner(),
      ...(body.run === undefined ? {} : { run: body.run }),
    };
    this.records.set(record.id, record);
    this.#version(record, existing === undefined ? 'created' : 'updated', time);
    return record;
  }

  remove(body: RecordRemove, time = Date.now()): { removed: boolean } {
    this.#stored(body.type);
    const record = this.records.get(body.id);
    if (record === undefined || record.type !== body.type || !this.#sees(record, body.run)) { return { removed: false }; }
    this.records.delete(body.id);
    this.#version({ ...record, version: record.version + 1 }, 'removed', time);
    return { removed: true };
  }

  /** The records a query selects, filtered, searched and sorted, with its offset and limit. */
  #select(query: RecordQuery, list: Omit<ListQuery, 'cursor' | 'limit'> & Partial<Pick<ListQuery, 'cursor' | 'limit'>> | undefined): { rows: DataRecord[]; offset: number; limit: number } {
    const decl = this.#stored(query.type);
    const fields = new Set(Object.keys(decl.def.props ?? {}));
    for (const field of [...(list?.filters ?? []).map((f) => f.field), ...(list?.sort ?? []).map((s) => s.field)]) {
      if (!fields.has(field)) { throw reject(400, 'UNKNOWN_FIELD', `${query.type} has no field ${field}.`); }
    }
    const words = [list?.text, query.search].filter((text): text is string => text !== undefined && text !== '').join(' ').toLowerCase().split(/\s+/).filter((word) => word !== '');
    const rows = this.of(query.type)
      .filter((record) => this.#sees(record, query.run))
      .filter((record) => (list?.filters ?? []).every((filter) => matches(filter, fieldOf(record.value, filter.field))))
      .filter((record) => words.length === 0 || words.every((word) => decl.records.search.text.some((field) => textOf(fieldOf(record.value, field)).toLowerCase().includes(word))));
    for (const sort of [...(list?.sort ?? [])].reverse()) {
      rows.sort((a, b) => compare(fieldOf(a.value, sort.field), fieldOf(b.value, sort.field)) * (sort.dir === 'asc' ? 1 : -1));
    }
    return { rows, offset: Number(list?.cursor ?? '0'), limit: list?.limit ?? DEFAULT_PAGE };
  }

  /** A stored type's declaration (one of the system's own). */
  #stored(type: QualifiedName): StoredTypeDecl {
    const decl = this.#types(type);
    if (decl === undefined) { throw reject(404, 'NOT_FOUND', `${type} is not a stored type (declare it with type({ records })).`); }
    return decl;
  }

  /**
   * Whether the asker sees a record: in a run, a person-owned one only its owner; outside a run the system keeps the
   * records of its own types, every one, as the hub lets it.
   */
  #sees(record: DataRecord, run: RunId | undefined): boolean {
    return run === undefined || record.owner === undefined || record.owner === this.#owner();
  }

  #version(record: DataRecord, change: RecordVersion['change'], at: number): void {
    this.versions.push({
      id: recordVersionId(record.id, record.version), record: record.id, type: record.type, number: record.version, change, value: record.value, at,
      ...(record.updatedBy === undefined ? {} : { by: record.updatedBy }),
      ...(record.run === undefined ? {} : { run: record.run }),
    });
  }
}

/** A field value as text for matching: text as itself, anything else as JSON (a list of tags matches by its items). */
function textOf(value: Json | undefined): string {
  return value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}

/** A top-level field of a JSON value. */
function fieldOf(value: Json, field: string): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value[field] : undefined;
}

/** A record's title: its type's `display.title` field, as text. */
function titleOf(decl: TypeDecl, value: Json): string {
  const field = decl.display.title;
  const title = field === undefined ? undefined : fieldOf(value, field);
  return title === undefined || title === null ? '' : typeof title === 'object' ? JSON.stringify(title) : String(title);
}

/** The result column kind of a field's gin type. */
function columnKind(type: GinTypeDef): ColumnKind {
  const inner = type.name === 'optional' || type.name === 'nullable' ? type.generic?.['T'] ?? type : type;
  switch (inner.name) {
    case 'text': case 'enum': return 'text';
    case 'num': return isWhole(inner) ? 'integer' : 'number';
    case 'bool': return 'boolean';
    case 'date': return 'date';
    case 'timestamp': return 'datetime';
    default: return 'json';
  }
}

/** Whether a num type holds whole numbers. */
function isWhole(type: GinTypeDef): boolean {
  const options: unknown = type.options;
  return typeof options === 'object' && options !== null && 'whole' in options && options.whole === true;
}

/** Order two field values: numbers and text as such, absent last. */
function compare(a: Json | undefined, b: Json | undefined): number {
  if (a === undefined || a === null) { return b === undefined || b === null ? 0 : 1; }
  if (b === undefined || b === null) { return -1; }
  if (typeof a === 'number' && typeof b === 'number') { return a - b; }
  return textOf(a).localeCompare(textOf(b));
}

/** Whether a field value passes one filter. */
function matches(filter: Filter, value: Json | undefined): boolean {
  switch (filter.op) {
    case 'is': return value === filter.value;
    case 'isNot': return value !== filter.value;
    case 'gt': return compare(value, filter.value) > 0 && value !== undefined;
    case 'gte': return compare(value, filter.value) >= 0 && value !== undefined;
    case 'lt': return compare(value, filter.value) < 0 && value !== undefined;
    case 'lte': return compare(value, filter.value) <= 0 && value !== undefined;
    case 'contains': return textOf(value).toLowerCase().includes(String(filter.value).toLowerCase());
    case 'in': return filter.values.some((one) => one === value);
    case 'notIn': return !filter.values.some((one) => one === value);
    case 'between': return value !== undefined && compare(value, filter.from) >= 0 && compare(value, filter.to) <= 0;
    case 'empty': return value === undefined || value === null || value === '';
    case 'notEmpty': return !(value === undefined || value === null || value === '');
  }
}
