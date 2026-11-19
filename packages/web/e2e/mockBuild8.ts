/**
 * The mock hub's build 8 samples: stored types with their records (kept in memory, so editing and removing work end to
 * end), the records as a result table (searched, filtered and sorted here the way the hub does it in its database),
 * saved widgets and what their runs return (a window of notes by offset, a note's words), the actions a note's row
 * offers, and version histories for records and any item.
 */
import {
  ApprovalPreview, ChangeSet, DataRecord, Json, SystemName, TypeRecord, WIDGET_KIND, type DataSetPage, type DataSetQuery, type FnSearchPage, type FnSearchQuery, type ItemVersionsPage, type ItemVersionsQuery,
  type FnRecord, type RecordGet, type RecordRemove, type RecordSave, type RecordUpdate, type RecordTableQuery, type RecordVersionsPage, type RecordVersionsQuery, type ResultTable, type WidgetActionOption,
} from '@harness/core';
import { fnRecord } from '../src/admin/test/fakes.ts';
import { RECORD_COLUMNS, recordTypes, SETTINGS_RECORDS, TASK_RECORDS } from './mockRecords.ts';
import { NOTE_TYPE, NOTE_WORDS, NOTES_WIDGET, SAMPLE_ACTIONS, SAMPLE_PAGED_WIDGET, SAMPLE_WORDS, SAMPLE_RECORDS, SAMPLE_SETS, SAMPLE_TABLE, sampleItemVersions, sampleRecordVersions } from '../src/data/test/samples.ts';

const HUB = SystemName.parse('hub');
const WIDGETS = SystemName.parse('widgets');

/**
 * What a `bash` run changed: two text files with diffs (one renamed, one maybe another call's), a binary file, a
 * sensitive dotfile and a file in a dotted folder (both listed without a diff), and more ignored by git.
 */
export const BASH_CHANGES = ChangeSet.parse({
  source: 'git', cwd: 'C:/work/harness', ignored: 12, truncated: false,
  files: [
    {
      path: 'packages/web/src/app/routes.ts', root: 'work', status: 'modified', certain: true, size: 2_310, added: 3, removed: 1,
      diff: [
        '--- a/packages/web/src/app/routes.ts', '+++ b/packages/web/src/app/routes.ts', '@@ -12,6 +12,8 @@ export const routes = [',
        "   { path: '/chat', component: ChatPage,", "-    props: true },", "+    props: true,", "+    meta: { group: 'chat' } },",
        "   { path: '/data', component: DataPage },", "+  { path: '/data/:system/:type', component: DataTypePage },", "   { path: '/admin', component: AdminPage },",
      ].join('\n'),
    },
    {
      path: 'docs/routing.md', from: 'docs/routes.md', root: 'work', status: 'renamed', certain: false, size: 640, added: 1, removed: 1,
      diff: ['--- a/docs/routes.md', '+++ b/docs/routing.md', '@@ -1,3 +1,3 @@', '-# Routes', '+# Routing', ' ', ' Every page is tied to the URL.'].join('\n'),
    },
    { path: 'packages/web/public/logo.png', root: 'work', status: 'added', certain: true, size: 18_204, noDiff: 'binary' },
    { path: '.env', root: 'work', status: 'modified', certain: true, size: 212, noDiff: 'sensitive', sensitive: 'env' },
    { path: '.github/workflows/ci.yml', root: 'work', status: 'modified', certain: false, size: 1_480, noDiff: 'sensitive', sensitive: 'secret-content' },
  ],
});

/** A `bash` command that reads and writes sensitive files. */
export const FLAGGED_COMMAND = 'cp .env.example .env && echo "OPENAI_API_KEY=$KEY" >> .env && cat ~/.ssh/id_ed25519.pub';

/** That command waiting for approval, its sensitive files listed. */
export const FLAGGED_PREVIEW = ApprovalPreview.parse({
  title: 'Run a shell command in C:/work/harness',
  irreversible: false,
  parts: [
    { type: 'code', language: 'sh', title: 'Command', code: FLAGGED_COMMAND },
    {
      type: 'flags',
      flags: [
        { path: '.env', kind: 'env', rule: 'env files', access: 'write', action: 'ask', why: 'Env files hold keys and passwords.', certain: false },
        { path: '.env.example', kind: 'env', rule: 'env files', access: 'read', action: 'ask', why: 'Env files hold keys and passwords.', certain: false },
        { path: '~/.ssh/id_ed25519.pub', kind: 'key', rule: 'ssh keys', access: 'read', action: 'ask', why: 'Key files let whoever holds them sign in.', certain: false },
      ],
    },
  ],
});

/** The stored types, their records and the saved widgets. */
export class MockData {
  readonly #now: () => number;
  readonly #records = new Map<string, DataRecord>([...SAMPLE_RECORDS, ...TASK_RECORDS, ...SETTINGS_RECORDS].map((record) => [record.id, record]));
  #made = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  sets(query: DataSetQuery): DataSetPage {
    const words = query.text?.toLowerCase() ?? '';
    const items = SAMPLE_SETS
      .filter((set) => (query.system === undefined || set.system === query.system) && (words === '' || `${set.type} ${set.description}`.toLowerCase().includes(words)))
      // counted from the records the listing reads, so a type's count is what opening it shows
      .map((set) => ({ ...set, records: this.#of(set.type).length }));
    return { items };
  }

  /** A type's records, in the order they were kept. */
  #of(type: string): DataRecord[] {
    return [...this.#records.values()].filter((record) => record.type === type);
  }

  /** A type's records as a result table: searched by words, filtered and sorted on their fields, a window at a time, each field editable. */
  table(query: RecordTableQuery): ResultTable {
    const columns = RECORD_COLUMNS.get(query.type);
    if (columns === undefined) { return { ...SAMPLE_TABLE, rows: [], total: 0, records: { type: query.type, id: 'id' } }; }
    const at = (name: string): number => columns.findIndex((c) => c.name === name);
    const words = query.search?.toLowerCase() ?? '';
    let rows = this.#of(query.type).map((record) => columns.map((c) => (c.name === 'id' ? record.id : valueOf(record, c.name))));
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
      columns: [...columns], records: { type: query.type, id: 'id' }, rows: rows.slice(offset, offset + limit), offset, limit, total: rows.length, truncated: offset + limit < rows.length,
      sort: sort === undefined ? [] : [{ column: sort.field, dir: sort.dir }],
    };
  }

  record(query: RecordGet): { record?: DataRecord } {
    const record = this.#records.get(query.id);
    return record === undefined || record.type !== query.type ? {} : { record };
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

  /** Change some fields of a note in place, the rest kept. */
  update(query: RecordUpdate, by: string): DataRecord {
    const known = this.#records.get(query.id);
    if (known === undefined) { throw new Error(`No record ${query.id}.`); }
    const value = typeof known.value === 'object' && known.value !== null && !Array.isArray(known.value) ? known.value : {};
    return this.save({ type: query.type, id: query.id, value: { ...value, ...query.set } }, by);
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
        { item: 'fn', name: NOTES_WIDGET, system: WIDGETS, description: 'Open notes, with words per note as a bar chart. Archive or rename a note from its row.', kind: WIDGET_KIND, mode: 'read', available: true },
        { item: 'fn', name: 'hub/orders_by_city', system: HUB, description: "This month's orders per city, from the shop database.", kind: WIDGET_KIND, mode: 'read', available: false, blocked: { code: 'system-disconnected', reason: 'The database system is offline.', system: SystemName.parse('database') } },
      ],
    };
  }

  /** The widgets system's fns: the saved notes widget, so its fn page draws its latest run. */
  widgetFns(now: number): FnRecord[] {
    return [fnRecord({
      name: NOTES_WIDGET, system: 'widgets', version: 'v3', origin: 'runtime', available: true, paused: false, disabled: false, updatedAt: now - 3_600_000,
      decl: { ...fnRecord().decl, name: 'open_notes', description: 'Open notes, with words per note as a bar chart. Archive or rename a note from its row.', kind: WIDGET_KIND, tags: ['widget'] },
    })];
  }

  /** The stored types, so a record is drawn as its type. */
  types(now: number): TypeRecord[] {
    return [...recordTypes(now), TypeRecord.parse({
      name: NOTE_TYPE, system: 'notes', instance: 'main', description: 'A note: a title, its text, open or done, and how many words.', display: { label: 'Note', title: 'title' }, references: [], updatedAt: now - 3_600_000,
      def: { name: 'obj', props: { title: { type: { name: 'text' } }, body: { type: { name: 'text' } }, status: { type: { name: 'text' } }, words: { type: { name: 'num' } } } },
    })];
  }

  actions(): WidgetActionOption[] {
    return [...SAMPLE_ACTIONS];
  }

  itemVersions(query: ItemVersionsQuery): ItemVersionsPage {
    return { items: sampleItemVersions(query.system, query.section, query.name) };
  }
}

/**
 * What a widget fn's run returns in the mock: the notes widget a window of two notes from its `offset` (an empty one
 * past the end), a note's words for its drill; undefined for any other fn.
 */
export function widgetRunOutput(fn: string, args: Json | undefined): Json | undefined {
  if (fn === NOTE_WORDS) { return Json.parse(SAMPLE_WORDS); }
  if (fn !== NOTES_WIDGET) { return undefined; }
  const given = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {};
  const offset = typeof given['offset'] === 'number' ? given['offset'] : 0;
  const rows = SAMPLE_TABLE.rows.slice(offset, offset + 2);
  const table = { ...SAMPLE_TABLE, rows, offset, truncated: offset + rows.length < SAMPLE_TABLE.rows.length, limit: 2 };
  return Json.parse({ ...SAMPLE_PAGED_WIDGET, table, paging: { offset: 'offset', limit: 'limit', window: 2, more: rows.length === 2 } });
}

function valueOf(record: DataRecord, field: string): DataRecord['value'] {
  const value = record.value;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value[field] ?? null : null;
}
