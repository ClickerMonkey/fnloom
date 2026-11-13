/**
 * The mock hub's build 8 samples: stored types with their records (kept in memory, so editing and removing work end to
 * end), the records as a result table (searched, filtered and sorted here the way the hub does it in its database),
 * saved widgets, the actions a note's row offers, and version histories for records and any item.
 */
import {
  ApprovalPreview, ChangeSet, DataRecord, SystemName, TypeRecord, WIDGET_KIND_V1, type DataSetPage, type DataSetQuery, type FnSearchPage, type FnSearchQuery, type ItemVersionsPage, type ItemVersionsQuery,
  type RecordGet, type RecordRemove, type RecordSave, type RecordTableQuery, type RecordVersionsPage, type RecordVersionsQuery, type ResultTable, type WidgetActionOptionV1,
} from '@harness/core';
import { NOTE_TYPE, NOTES_WIDGET, SAMPLE_ACTIONS, SAMPLE_RECORDS, SAMPLE_SETS, SAMPLE_TABLE, sampleItemVersions, sampleRecordVersions } from '../src/data/test/samples.ts';

const HUB = SystemName.parse('hub');

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
    if (query.kinds?.includes(WIDGET_KIND_V1) !== true) { return undefined; }
    return {
      items: [
        { item: 'fn', name: NOTES_WIDGET, system: HUB, description: 'Open notes, with words per note as a bar chart. Archive or rename a note from its row.', kind: WIDGET_KIND_V1, mode: 'read', available: true },
        { item: 'fn', name: 'hub/orders_by_city', system: HUB, description: "This month's orders per city, from the shop database.", kind: WIDGET_KIND_V1, mode: 'read', available: false, unavailable: 'The database system is offline.' },
      ],
    };
  }

  /** The stored note type, so a record is drawn as its type. */
  types(now: number): TypeRecord[] {
    return [TypeRecord.parse({
      name: NOTE_TYPE, system: 'notes', instance: 'main', description: 'A note: a title, its text, open or done, and how many words.', display: { label: 'Note', title: 'title' }, references: [], updatedAt: now - 3_600_000,
      def: { name: 'obj', props: { title: { type: { name: 'text' } }, body: { type: { name: 'text' } }, status: { type: { name: 'text' } }, words: { type: { name: 'num' } } } },
    })];
  }

  actions(): WidgetActionOptionV1[] {
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
