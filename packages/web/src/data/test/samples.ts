/**
 * Sample data for the Data pages and widgets (build 8 and the widget pass), shared by the component tests and the mock
 * hub: a stored type of notes with its records as a result table, widget results over it (one with chips, presets, a
 * pager and a drill), a widget proposal, the actions its rows offer, and version histories. Plain values only, so the
 * mock hub can serve them too.
 */
import {
  columnFacts, DataRecord, DataSetView, ItemVersionRecord, QualifiedName, RecordVersion, ResultTable, WidgetActionOption, WidgetProposal, WidgetResult,
} from '@harness/core';

/** The stored type the samples are of. */
export const NOTE_TYPE = QualifiedName.parse('notes/Note');
/** The saved widget the samples draw. */
export const NOTES_WIDGET = QualifiedName.parse('widgets/open_notes');
/** The fn a note's drill opens: the note's words, one row per word. */
export const NOTE_WORDS = QualifiedName.parse('notes/note_words');

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

/** The notes as `hub/records_table` gives them: each field editable in place, the id the record's key. */
export const SAMPLE_RECORD_TABLE: ResultTable = ResultTable.parse({
  ...SAMPLE_TABLE,
  columns: SAMPLE_TABLE.columns.map((column) => (column.name === 'id' ? { ...column, label: 'Record', key: true } : { ...column, editable: true })),
  records: { type: NOTE_TYPE, id: 'id' },
});

/** What a note's row offers: archive it (a write, so it confirms) and rename it (a form for the new title, then the confirm). */
export const SAMPLE_ACTIONS: readonly WidgetActionOption[] = WidgetActionOption.array().parse([
  { fn: 'notes/Note.archive', label: 'Archive', mode: 'write', confirm: true, bind: { self: 'id' }, then: 'refresh' },
  { fn: 'notes/Note.rename', label: 'Rename', mode: 'write', confirm: true, bind: { self: 'id' }, form: { name: 'obj', props: { title: { type: { name: 'text' } } } }, then: 'refresh' },
]);

/** The records query an open-notes widget pins: status is "open". */
const OPEN_QUERY = { filters: [{ field: 'status', op: 'is', value: 'open' }] };

/** The open notes only, as a widget pinned to `OPEN_QUERY` reads them. */
const OPEN_TABLE: ResultTable = ResultTable.parse({ ...SAMPLE_TABLE, rows: NOTES.filter((note) => note.status === 'open').map((note) => [note.title, note.body, note.status, note.words, note.id]), total: 2 });

/** A widget's result over the open notes, offering a bar chart of words per title and the table, and the notes' actions. */
export const SAMPLE_WIDGET: WidgetResult = WidgetResult.parse({
  title: 'Open notes',
  table: OPEN_TABLE,
  facts: columnFacts(OPEN_TABLE),
  source: { fn: 'hub/records_table', run: 'run_widget_source', args: { type: NOTE_TYPE, query: OPEN_QUERY } },
  visuals: [{ visual: 'category', style: 'bar', label: 'Words per note', bind: { x: ['title'], y: ['words'] } }, { visual: 'table', style: 'table', bind: {} }],
  problems: [], controls: [], presets: [], actions: SAMPLE_ACTIONS, readOnly: false,
  summary: 'Bar chart of words by title, 2 rows, shown to the person',
});

/** The first window of the paged widget: two notes of three, more may follow. */
const FIRST_WINDOW: ResultTable = { ...SAMPLE_TABLE, rows: SAMPLE_TABLE.rows.slice(0, 2), total: 3, truncated: true, limit: 2 };

/**
 * A widget over the notes with chips, presets, a pager and a drill: Status limited to its choices (with "Any"), Owner
 * typed freely, Since a date with relative dates (its default "7 days ago"); presets "Open" and "Done"; a window of two
 * rows (more follow); a click on a note opens its words.
 */
export const SAMPLE_PAGED_WIDGET: WidgetResult = WidgetResult.parse({
  title: 'Notes by status',
  table: FIRST_WINDOW,
  facts: columnFacts(FIRST_WINDOW),
  source: { fn: 'hub/records_table', run: 'run_widget_paged', args: { type: NOTE_TYPE, status: 'open', offset: 0, limit: 2 } },
  visuals: [{ visual: 'table', style: 'table', bind: {} }],
  problems: [],
  controls: [
    { arg: 'status', label: 'Status', argType: { name: 'text' }, optional: true, choices: [{ label: 'Any' }, { label: 'Open', value: { literal: 'open' } }, { label: 'Done', value: { literal: 'done' } }], custom: false, relative: false, value: { literal: 'open' } },
    { arg: 'owner', label: 'Owner', argType: { name: 'text' }, optional: true, custom: true, relative: false },
    { arg: 'since', label: 'Since', argType: { name: 'date' }, optional: true, custom: true, relative: true, value: { relative: 'today-7d' } },
  ],
  presets: [{ label: 'Open', sets: { status: { literal: 'open' } } }, { label: 'Done', sets: { status: { literal: 'done' } } }],
  paging: { offset: 'offset', limit: 'limit', window: 2, more: true },
  actions: SAMPLE_ACTIONS,
  drill: { fn: NOTE_WORDS, label: 'Words', bind: { note: 'id' } },
  readOnly: false,
  summary: 'Table of notes, 2 rows (more held back), shown to the person',
});

/** A note's words, as its drill shows them. */
export const SAMPLE_WORDS: ResultTable = ResultTable.parse({
  columns: [{ name: 'word', kind: 'text', nullable: false }, { name: 'length', kind: 'integer', nullable: false }],
  rows: [['Plan', 4], ['the', 3], ['trip', 4]], offset: 0, total: 3, truncated: false, sort: [],
});

/** What `widgets/make_widget` proposes for "a chart of my notes' words": the open notes widget, its preview drawn. */
export const SAMPLE_PROPOSAL: WidgetProposal = WidgetProposal.parse({
  name: 'open_notes',
  description: 'Open notes as a bar chart of words per note, with the table one tap away.',
  spec: {
    title: 'Open notes', source: 'hub/records_table', args: { type: { show: 'pinned', value: { literal: NOTE_TYPE } }, query: { show: 'pinned', value: { literal: OPEN_QUERY } } }, presets: [],
    visuals: [{ visual: 'category', style: 'bar', label: 'Words per note', bind: { x: ['title'], y: ['words'] } }, { visual: 'table', style: 'table', bind: {} }],
  },
  preview: SAMPLE_WIDGET,
  show: true,
});

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
