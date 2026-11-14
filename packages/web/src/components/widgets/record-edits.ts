/**
 * Inline editing of stored records (widget pass, data-grid "one view"), apart from any component. A table whose rows
 * are records of a stored type (`ResultTable.records`) marks the fields the person may change in place
 * (`ResultColumn.editable`); the grid draws those cells as inputs, each change is staged here by record and field, and
 * "Save N changes" sends one `RecordUpdate` per record after one confirm naming them all. A change typed back to what
 * the record holds is no change; a value that doesn't read as its column's kind (letters in a number) is not staged.
 */
import { humanize, lowerFirst, RecordId, type Json, type RecordUpdate, type ResultColumn, type ResultTable } from '@harness/core';
import { computed, shallowRef, type InjectionKey } from 'vue';
import { cellText } from '../results/table.ts';
import { rowName } from './widgets.ts';

/** The input an editable cell is drawn as. */
export type EditInput = 'text' | 'number' | 'checkbox' | 'date';

/** The input a column's cells take in place; undefined when the column isn't editable or its kind has no plain input. */
export function editInput(column: Pick<ResultColumn, 'kind' | 'editable'>): EditInput | undefined {
  if (column.editable !== true) { return undefined; }
  switch (column.kind) {
    case 'text': return 'text';
    case 'integer':
    case 'number': return 'number';
    case 'boolean': return 'checkbox';
    case 'date': return 'date';
    case 'datetime':
    case 'time':
    case 'uuid':
    case 'json':
    case 'binary': return undefined;
  }
}

/**
 * What an input's entry stores in its column: a checkbox's state; a number (whole for an integer column); text as
 * typed; an empty entry is null where the column allows it. Undefined when it doesn't read as the column's kind.
 */
export function enteredValue(column: Pick<ResultColumn, 'kind' | 'nullable'>, entered: string | boolean): Json | undefined {
  if (typeof entered === 'boolean') { return column.kind === 'boolean' ? entered : undefined; }
  if (entered.trim() === '' && column.kind !== 'text') { return column.nullable ? null : undefined; }
  if (column.kind === 'integer' || column.kind === 'number') {
    const value = Number(entered);
    return Number.isFinite(value) && (column.kind === 'number' || Number.isInteger(value)) ? value : undefined;
  }
  if (column.kind === 'text' && entered === '' && column.nullable) { return null; }
  return entered;
}

/** One record's staged change, named for the confirm. */
export interface RecordChange {
  readonly id: RecordId;
  /** The row's name (its first text cell), else its id. */
  readonly name: string;
  readonly set: Readonly<Record<string, Json>>;
  /** What the changed fields held before, as the row shows them (absent when the row isn't held). */
  readonly was: Readonly<Record<string, Json>>;
}

/** The grid's side of inline editing: which cells are inputs, what they show, and staging what is typed. */
export interface CellEditor {
  /** The input a column's cells are drawn as here; undefined draws them as text. */
  input(column: ResultColumn): EditInput | undefined;
  /** A cell's value now: the staged one, else the one the row holds. */
  value(row: readonly Json[], index: number): Json | undefined;
  /** Whether a cell holds a staged change. */
  changed(row: readonly Json[], index: number): boolean;
  /** Stage what was typed in a cell. */
  stage(row: readonly Json[], index: number, entered: string | boolean): void;
}

/** Where a widget view provides its cell editor to the grid. */
export const CELL_EDITOR: InjectionKey<CellEditor> = Symbol('cell-editor');

/** What saving the staged changes came to: how many records were saved, and why the rest weren't. */
export interface SavedEdits {
  readonly saved: number;
  readonly failed: readonly string[];
}

/** The staged inline edits of a table of records. */
export class RecordEdits implements CellEditor {
  readonly #table: () => ResultTable | undefined;
  /** The staged fields, by record. */
  readonly staged = shallowRef<ReadonlyMap<RecordId, Readonly<Record<string, Json>>>>(new Map());

  /** `table` gives the rows edited now, or undefined while editing is off (a write's rows, a host that can't save). */
  constructor(table: () => ResultTable | undefined) {
    this.#table = table;
  }

  input(column: ResultColumn): EditInput | undefined {
    return this.#table()?.records === undefined ? undefined : editInput(column);
  }

  value(row: readonly Json[], index: number): Json | undefined {
    const field = this.#table()?.columns[index]?.name;
    const id = this.#idOf(row);
    const staged = id === undefined || field === undefined ? undefined : this.staged.value.get(id);
    return staged !== undefined && field !== undefined && Object.hasOwn(staged, field) ? staged[field] : row[index];
  }

  changed(row: readonly Json[], index: number): boolean {
    const field = this.#table()?.columns[index]?.name;
    const id = this.#idOf(row);
    const staged = id === undefined ? undefined : this.staged.value.get(id);
    return staged !== undefined && field !== undefined && Object.hasOwn(staged, field);
  }

  stage(row: readonly Json[], index: number, entered: string | boolean): void {
    const column = this.#table()?.columns[index];
    const id = this.#idOf(row);
    if (column === undefined || id === undefined || editInput(column) === undefined) { return; }
    const value = enteredValue(column, entered);
    if (value === undefined) { return; }
    const others = Object.entries(this.staged.value.get(id) ?? {}).filter(([name]) => name !== column.name);
    const same = JSON.stringify(value) === JSON.stringify(row[index] ?? null);
    const fields: Record<string, Json> = Object.fromEntries(same ? others : [...others, [column.name, value]]);
    const next = new Map(this.staged.value);
    if (Object.keys(fields).length === 0) { next.delete(id); } else { next.set(id, fields); }
    this.staged.value = next;
  }

  /** How many fields are staged, over every record. */
  readonly count = computed(() => [...this.staged.value.values()].reduce((sum, fields) => sum + Object.keys(fields).length, 0));

  /** The staged changes, one per record, named by their rows. */
  changes(): RecordChange[] {
    const table = this.#table();
    return [...this.staged.value].map(([id, set]) => {
      const at = table === undefined ? -1 : table.rows.findIndex((row) => this.#idOf(row) === id);
      const row = at < 0 ? undefined : table?.rows[at];
      const was = row === undefined || table === undefined ? {} : Object.fromEntries(Object.keys(set).flatMap((name) => {
        const index = table.columns.findIndex((column) => column.name === name);
        return index < 0 ? [] : [[name, row[index] ?? null]];
      }));
      return { id, name: (table === undefined || at < 0 ? undefined : rowName(table, at)) ?? id, set, was };
    });
  }

  /** A change in words for the confirm, old → new: `Plan the trip: title “Plan the trip” → “Plan the walk”, words 6 → 7`. */
  describe(change: RecordChange): string {
    const columns = this.#table()?.columns ?? [];
    const fields = Object.entries(change.set).map(([name, value]) => {
      const column = columns.find((c) => c.name === name);
      const label = column?.label ?? lowerFirst(humanize(name));
      const say = (held: Json): string => {
        const text = column === undefined ? JSON.stringify(held) : cellText(held, column);
        return text === undefined ? 'empty' : column?.kind === 'text' ? `“${text}”` : text;
      };
      return Object.hasOwn(change.was, name) ? `${label} ${say(change.was[name] ?? null)} → ${say(value)}` : `${label} ${say(value)}`;
    });
    return `${change.name}: ${fields.join(', ')}`;
  }

  /** Drop every staged change. */
  discard(): void {
    this.staged.value = new Map();
  }

  /** Save each record's change (one update each, the rest of the record kept); what saved leaves the staged ones. */
  async save(update: (change: RecordUpdate) => Promise<void>): Promise<SavedEdits> {
    const type = this.#table()?.records?.type;
    if (type === undefined) { return { saved: 0, failed: [] }; }
    let saved = 0;
    const failed: string[] = [];
    for (const change of this.changes()) {
      try {
        await update({ type, id: change.id, set: { ...change.set } });
        saved++;
        const next = new Map(this.staged.value);
        next.delete(change.id);
        this.staged.value = next;
      } catch (error) {
        failed.push(`${change.name}: ${error instanceof Error ? error.message : 'not saved'}`);
      }
    }
    return { saved, failed };
  }

  #idOf(row: readonly Json[]): RecordId | undefined {
    const table = this.#table();
    const column = table?.records?.id;
    const at = column === undefined || table === undefined ? -1 : table.columns.findIndex((c) => c.name === column);
    const parsed = RecordId.safeParse(at < 0 ? undefined : row[at]);
    return parsed.success ? parsed.data : undefined;
  }
}
