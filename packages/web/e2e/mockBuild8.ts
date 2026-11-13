/**
 * The mock hub's build 8 samples: stored types with their records (kept in memory, so editing and removing work end to
 * end), the records as a result table (searched, filtered and sorted here the way the hub does it in its database),
 * saved widgets, the actions a note's row offers, and version histories for records and any item.
 */
import {
  DataRecord, SystemName, WIDGET_KIND, type DataSetPage, type DataSetQuery, type FnSearchPage, type FnSearchQuery, type ItemVersionsPage, type ItemVersionsQuery,
  type RecordGet, type RecordRemove, type RecordSave, type RecordTableQuery, type RecordVersionsPage, type RecordVersionsQuery, type ResultTable, type WidgetActionOption,
} from '@harness/core';
import { NOTE_TYPE, NOTES_WIDGET, SAMPLE_ACTIONS, SAMPLE_RECORDS, SAMPLE_SETS, SAMPLE_TABLE, sampleItemVersions, sampleRecordVersions } from '../src/data/test/samples.ts';

const HUB = SystemName.parse('hub');

/** The stored types, their records and the saved widgets. */
export class MockData {
  readonly #now: () => number;
  readonly #records = new Map<string, DataRecord>(SAMPLE_RECORDS.map((record) => [record.id, record]));
  #made = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  sets(query: DataSetQuery): DataSetPage {
    const words = query.text?.toLowerCase() ?? '';
    const items = SAMPLE_SETS
      .filter((set) => (query.system === undefined || set.system === query.system) && (words === '' || `${set.type} ${set.description}`.toLowerCase().includes(words)))
      .map((set) => (set.type === NOTE_TYPE ? { ...set, records: this.#records.size } : set));
    return { items };
  }

  /** The notes as a result table: searched by words, filtered and sorted on their fields, a page at a time. */
  table(query: RecordTableQuery): ResultTable {
    if (query.type !== NOTE_TYPE) { return { ...SAMPLE_TABLE, rows: [], total: 0 }; }
    const columns = SAMPLE_TABLE.columns;
    const at = (name: string): number => columns.findIndex((c) => c.name === name);
    const words = query.search?.toLowerCase() ?? '';
    let rows = [...this.#records.values()].map((record) => columns.map((c) => (c.name === 'id' ? record.id : valueOf(record, c.name))));
    if (words !== '') { rows = rows.filter((row) => row.some((cell) => typeof cell === 'string' && cell.toLowerCase().includes(words))); }
    for (const filter of query.query?.filters ?? []) {
      const i = at(filter.field);
      if (!('value' in filter)) { continue; }
      rows = rows.filter((row) => {
        const cell = row[i];
        if (filter.op === 'contains') { return typeof cell === 'string' && cell.toLowerCase().includes(String(filter.value).toLowerCase()); }
        if (filter.op === 'gt') { return typeof cell === 'number' && typeof filter.value === 'number' && cell > filter.value; }
        if (filter.op === 'lt') { return typeof cell === 'number' && typeof filter.value === 'number' && cell < filter.value; }
        return cell === filter.value;
      });
    }
    const sort = query.query?.sort?.[0];
    if (sort !== undefined) {
      const i = at(sort.field);
      rows.sort((a, b) => JSON.stringify(a[i] ?? null).localeCompare(JSON.stringify(b[i] ?? null), undefined, { numeric: true }) * (sort.dir === 'asc' ? 1 : -1));
    }
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return {
      columns, rows: rows.slice(offset, offset + limit), offset, limit, total: rows.length, truncated: offset + limit < rows.length,
      sort: sort === undefined ? [] : [{ column: sort.field, dir: sort.dir }],
    };
  }

  record(query: RecordGet): { record?: DataRecord } {
    const record = this.#records.get(query.id);
    return record === undefined ? {} : { record };
  }

  save(query: RecordSave, by: string): DataRecord {
    const known = query.id === undefined ? undefined : this.#records.get(query.id);
    if (known !== undefined && query.expect !== undefined && known.version !== query.expect) { throw new Error('Someone changed this record since you opened it. Open it again to see their change.'); }
    const now = this.#now();
    const value = query.value;
    const title = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value['title'] === 'string' ? value['title'] : 'Untitled';
    const saved = DataRecord.parse({
      id: known?.id ?? `rec_made_${String(++this.#made)}`, type: query.type, value, owner: by, title, version: (known?.version ?? 0) + 1,
      createdAt: known?.createdAt ?? now, updatedAt: now, updatedBy: by,
    });
    this.#records.set(saved.id, saved);
    return saved;
  }

  remove(query: RecordRemove): { removed: boolean } {
    return { removed: this.#records.delete(query.id) };
  }

  versions(query: RecordVersionsQuery): RecordVersionsPage {
    const record = this.#records.get(query.id);
    return { items: record === undefined ? [] : sampleRecordVersions(record) };
  }

  /** The saved widgets, for a fn search by the widget kind; undefined for any other search. */
  widgets(query: FnSearchQuery): FnSearchPage | undefined {
    if (query.kinds?.includes(WIDGET_KIND) !== true) { return undefined; }
    return {
      items: [
        { item: 'fn', name: NOTES_WIDGET, system: HUB, description: 'Open notes, with words per note as a bar chart. Archive or rename a note from its row.', kind: WIDGET_KIND, mode: 'read', available: true },
        { item: 'fn', name: 'hub/orders_by_city', system: HUB, description: "This month's orders per city, from the shop database.", kind: WIDGET_KIND, mode: 'read', available: false, unavailable: 'The database system is offline.' },
      ],
    };
  }

  actions(): WidgetActionOption[] {
    return [...SAMPLE_ACTIONS];
  }

  itemVersions(query: ItemVersionsQuery): ItemVersionsPage {
    return { items: sampleItemVersions(query.system, query.section, query.name) };
  }
}

function valueOf(record: DataRecord, field: string): DataRecord['value'] {
  const value = record.value;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value[field] ?? null : null;
}
