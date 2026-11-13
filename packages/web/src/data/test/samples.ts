/**
 * Sample data for the Data pages and widgets (build 8), shared by the component tests and the mock hub: a stored type of
 * notes with its records as a result table, a widget's result over it, the actions its rows offer, and version
 * histories. Plain values only, so the mock hub can serve them too.
 */
import {
  DataRecord, DataSetView, ItemVersionRecord, QualifiedName, RecordVersion, ResultTable, WidgetActionOptionV1, WidgetResultV1,
} from '@harness/core';

/** The stored type the samples are of. */
export const NOTE_TYPE = QualifiedName.parse('notes/Note');
/** The saved widget the samples draw. */
export const NOTES_WIDGET = QualifiedName.parse('hub/open_notes');

const AT = Date.UTC(2026, 10, 12, 9, 0, 0);

/** The stored types the person sees. */
export const SAMPLE_SETS: readonly DataSetView[] = DataSetView.array().parse([
  { type: NOTE_TYPE, system: 'notes', description: 'Short notes people keep.', storage: { shape: 'table', owner: 'person', search: { text: ['title', 'body'], embed: true } }, records: 3, updatedAt: AT },
  { type: 'notes/Settings', system: 'notes', description: "The notes system's shared settings.", storage: { shape: 'value', owner: 'shared', search: { text: [], embed: false } }, records: 1, updatedAt: AT },
  { type: 'tasks/Task', system: 'tasks', description: 'Things to do, shared by the family.', storage: { shape: 'table', owner: 'shared', search: { text: ['title'], embed: false } }, records: 128, updatedAt: AT },
]);

const NOTES = [
  { id: 'rec_note_1', title: 'Plan the trip', body: 'Book the cabin and the ferry.', status: 'open', words: 6 },
  { id: 'rec_note_2', title: 'Groceries', body: 'Milk, eggs, bread.', status: 'open', words: 3 },
  { id: 'rec_note_3', title: 'Old idea', body: 'A garden by the fence.', status: 'done', words: 5 },
] as const;

/** The notes as records. */
export const SAMPLE_RECORDS: readonly DataRecord[] = NOTES.map((note, i) => DataRecord.parse({
  id: note.id, type: NOTE_TYPE, value: { title: note.title, body: note.body, status: note.status, words: note.words }, owner: 'act_admin', title: note.title,
  version: i + 1, createdAt: AT - 86_400_000 * (i + 1), updatedAt: AT - 3_600_000 * i, updatedBy: 'act_admin',
}));

/** The notes as the result grid draws them: a column per field, then `id` referring to the type. */
export const SAMPLE_TABLE: ResultTable = ResultTable.parse({
  columns: [
    { name: 'title', kind: 'text', nullable: false },
    { name: 'body', kind: 'text', nullable: true },
    { name: 'status', kind: 'text', nullable: false },
    { name: 'words', kind: 'integer', nullable: false },
    { name: 'id', kind: 'text', nullable: false, ref: NOTE_TYPE },
  ],
  rows: NOTES.map((note) => [note.title, note.body, note.status, note.words, note.id]),
  offset: 0, total: NOTES.length, truncated: false, sort: [],
});

/** A widget's result over the notes, offering a bar chart of words per title and the table. */
export const SAMPLE_WIDGET: WidgetResultV1 = WidgetResultV1.parse({
  title: 'Open notes',
  table: SAMPLE_TABLE,
  source: { fn: 'hub/records_table', run: 'run_widget_source' },
  visuals: [{ visual: 'bar', label: 'Words per note', bind: { label: ['title'], value: ['words'] } }, { visual: 'table', bind: {} }],
  problems: [],
});

/**
 * A widget over the notes with controls and paging: Status limited to its choices (a select), Owner typed freely, and
 * the second page of three (more follow).
 */
export const SAMPLE_PAGED_WIDGET: WidgetResultV1 = WidgetResultV1.parse({
  title: 'Notes by status',
  table: { ...SAMPLE_TABLE, offset: 3, total: 9, truncated: true },
  source: { fn: 'hub/records_table', run: 'run_widget_paged' },
  visuals: [{ visual: 'table', bind: {} }],
  problems: [],
  paging: { arg: 'offset', size: 3 },
  controls: [{ arg: 'status', label: 'Status', choices: ['open', 'done'], custom: false }, { arg: 'owner', label: 'Owner', custom: true }],
});

/** What a note's row offers: archive it (a write, so it confirms) and rename it (a form for the new title). */
export const SAMPLE_ACTIONS: readonly WidgetActionOptionV1[] = WidgetActionOptionV1.array().parse([
  { fn: 'notes/Note.archive', label: 'Archive', mode: 'write', confirm: true, bind: { self: 'id' }, then: 'refresh' },
  { fn: 'notes/Note.rename', label: 'Rename', mode: 'write', confirm: true, bind: { self: 'id' }, form: { name: 'obj', props: { title: { type: { name: 'text' } } } }, then: 'refresh' },
]);

/** A record's history, newest first. */
export function sampleRecordVersions(record: DataRecord): RecordVersion[] {
  return Array.from({ length: record.version }, (_, i) => record.version - i).map((number) => RecordVersion.parse({
    id: `${record.id}#${String(number)}`, record: record.id, type: record.type, number, change: number === 1 ? 'created' : 'updated',
    value: record.value, by: 'act_admin', at: record.updatedAt - (record.version - number) * 3_600_000,
  }));
}

/** An item's history, newest first: added from the contract, then changed while running. */
export function sampleItemVersions(system: string, section: string, name: string): ItemVersionRecord[] {
  return [3, 2, 1].map((number) => ItemVersionRecord.parse({
    id: `${system}:${section}:${name}#${String(number)}`, system, section, name, number, change: number === 1 ? 'added' : 'changed',
    decl: { name, version: number }, hash: `hash${String(number)}`, declaredBy: number === 3 ? 'runtime' : 'contract', savedAt: AT - (3 - number) * 86_400_000,
  }));
}
