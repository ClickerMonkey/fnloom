/**
 * The mock hub's stored records beyond the notes: the family's 128 shared tasks and the notes system's one settings
 * value, each with the columns `hub/records_table` gives them and the type a record is drawn as. The mock keeps them
 * with the notes (so every type the data tab counts opens on the same records), the way the hub reads its count and its
 * listing from one records table.
 */
import { DataRecord, QualifiedName, TypeRecord, type ResultColumn } from '@harness/core';
import { NOTE_TYPE, SAMPLE_RECORD_TABLE } from '../src/data/test/samples.ts';

export const TASK_TYPE = QualifiedName.parse('tasks/Task');
export const SETTINGS_TYPE = QualifiedName.parse('notes/Settings');

/** When the samples were written (the same moment the notes samples use). */
const AT = Date.UTC(2026, 10, 12, 9, 0, 0);
const DAY = 86_400_000;

const CHORES = ['Water the plants', 'Take out the bins', 'Pay the water bill', 'Book the dentist', 'Clean the gutters', 'Walk the dog', 'Fix the gate', 'Return library books'] as const;
const PEOPLE = ['Phil', 'Nicole', 'Mason', 'Mackenzie'] as const;
const STATUSES = ['open', 'open', 'doing', 'done'] as const;

/** The 128 tasks: a chore, its status, who it's for, when it's due and how big it is, spread so filters and sorts show something. */
export const TASK_RECORDS: readonly DataRecord[] = Array.from({ length: 128 }, (_, i) => {
  const title = `${CHORES[i % CHORES.length] ?? 'Task'} #${String(Math.floor(i / CHORES.length) + 1)}`;
  const due = new Date(AT + DAY * ((i * 3) % 60 - 20)).toISOString().slice(0, 10);
  return DataRecord.parse({
    id: `rec_task_${String(i + 1).padStart(3, '0')}`, type: TASK_TYPE, title,
    value: { title, status: STATUSES[i % STATUSES.length] ?? 'open', assignee: PEOPLE[i % PEOPLE.length] ?? 'Phil', due_date: due, points: (i % 5) + 1 },
    version: (i % 3) + 1, createdAt: AT - DAY * (128 - i), updatedAt: AT - 3_600_000 * (i % 48), updatedBy: 'act_admin',
  });
});

/** The notes system's settings: one shared value. */
export const SETTINGS_RECORDS: readonly DataRecord[] = [DataRecord.parse({
  id: 'rec_notes_settings', type: SETTINGS_TYPE, title: 'Notes settings', value: { title: 'Notes settings', sort: 'newest', show_done: false, reminder_hour: 9 },
  version: 2, createdAt: AT - DAY * 30, updatedAt: AT - DAY, updatedBy: 'act_admin',
})];

const editable = (name: string, kind: ResultColumn['kind']): ResultColumn => ({ name, kind, nullable: false, editable: true });
const idColumn = (type: QualifiedName): ResultColumn => ({ name: 'id', label: 'Record', kind: 'text', nullable: false, ref: type, key: true });

/** Each stored type's `hub/records_table` columns: a column per field, then the record id. */
export const RECORD_COLUMNS: ReadonlyMap<QualifiedName, readonly ResultColumn[]> = new Map([
  [NOTE_TYPE, SAMPLE_RECORD_TABLE.columns],
  [TASK_TYPE, [editable('title', 'text'), editable('status', 'text'), editable('assignee', 'text'), editable('due_date', 'date'), editable('points', 'integer'), idColumn(TASK_TYPE)]],
  [SETTINGS_TYPE, [editable('title', 'text'), editable('sort', 'text'), editable('show_done', 'boolean'), editable('reminder_hour', 'integer'), idColumn(SETTINGS_TYPE)]],
]);

/** The task and settings types, so a record of either is drawn as its type. */
export function recordTypes(now: number): TypeRecord[] {
  return [
    TypeRecord.parse({
      name: TASK_TYPE, system: 'tasks', instance: 'main', description: 'A task: what to do, its status, who it is for, when it is due and how big it is.', display: { label: 'Task', title: 'title' }, references: [], updatedAt: now - 3_600_000,
      def: { name: 'obj', props: { title: { type: { name: 'text' } }, status: { type: { name: 'text' } }, assignee: { type: { name: 'text' } }, due_date: { type: { name: 'text' } }, points: { type: { name: 'num' } } } },
    }),
    TypeRecord.parse({
      name: SETTINGS_TYPE, system: 'notes', instance: 'main', description: "The notes system's shared settings.", display: { label: 'Settings', title: 'title' }, references: [], updatedAt: now - 3_600_000,
      def: { name: 'obj', props: { title: { type: { name: 'text' } }, sort: { type: { name: 'text' } }, show_done: { type: { name: 'bool' } }, reminder_hour: { type: { name: 'num' } } } },
    }),
  ];
}
