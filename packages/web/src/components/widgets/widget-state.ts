/**
 * One widget's state while it is drawn (build 8): the actions its rows offer (asked of the host once per widget and its
 * row types), the row and action a person picked, whether the action waits for a confirm or a form, and running it,
 * then what follows (`then`: run the widget again, or leave its result to show as its own run). Changing a control,
 * paging or refreshing runs the widget again as a new run; nothing runs until a person clicks.
 */
import type { Json, QualifiedName, ResultTable, WidgetActionOption, WidgetResult } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import { Loaded, Task } from '../../state/loaded.ts';
import { actionArgs, boundArgs, rowActions, rowTypes, type WidgetHost } from './widgets.ts';

/** Where a picked action is: choosing one for the row, filling its form, or confirming it. */
export type ActionStep = 'choose' | 'form' | 'confirm';

/** The widget a state is for: its fn (absent for a plain result table) and the args it last ran with. */
export interface WidgetSource {
  readonly fn: QualifiedName | undefined;
  readonly args: Json | undefined;
}

/** One drawn widget's actions, controls and refresh. */
export class WidgetState {
  readonly #host: WidgetHost;
  readonly #source: () => WidgetSource;
  /** The actions rows of this table's types offer. */
  readonly options = new Loaded<readonly WidgetActionOption[]>();
  /** The row whose actions are open, with the actions it can take. */
  readonly row = shallowRef<readonly Json[] | undefined>(undefined);
  readonly offered = shallowRef<readonly WidgetActionOption[]>([]);
  /** The action picked for the row, and what it waits for. */
  readonly picked = shallowRef<WidgetActionOption | undefined>(undefined);
  readonly step = ref<ActionStep>('choose');
  readonly running = new Task();
  /** Whether the row's actions are open. */
  readonly open = computed({ get: () => this.row.value !== undefined, set: (isOpen: boolean) => { if (!isOpen) { this.close(); } } });
  #askedFor = '';

  constructor(host: WidgetHost, source: () => WidgetSource) {
    this.#host = host;
    this.#source = source;
  }

  /** Ask for the actions a table's rows offer, once per set of row types. */
  async load(table: Pick<ResultTable, 'columns'>): Promise<void> {
    const types = rowTypes(table);
    const widget = this.#source().fn;
    const key = `${widget ?? ''}|${types.join(',')}`;
    if (key === this.#askedFor) { return; }
    this.#askedFor = key;
    if (types.length === 0) { this.options.set([]); return; }
    await this.options.load(() => this.#host.actions(types, widget), "Couldn't load this widget's actions.", true);
  }

  /** Whether a row has any action to offer. */
  hasActions(table: Pick<ResultTable, 'columns'>, row: readonly Json[]): boolean {
    return rowActions(this.options.value.value ?? [], table, row).length > 0;
  }

  /** Open a row's actions, to choose one. */
  openRow(table: Pick<ResultTable, 'columns'>, row: readonly Json[]): void {
    this.row.value = row;
    this.offered.value = rowActions(this.options.value.value ?? [], table, row);
    this.running.problem.value = '';
    this.picked.value = undefined;
    this.step.value = 'choose';
  }

  /** Pick an action: its form first when it has args left, else its confirm when it asks, else ready to run. */
  choose(option: WidgetActionOption): void {
    this.picked.value = option;
    this.step.value = option.form !== undefined ? 'form' : 'confirm';
  }

  /** Whether the picked action runs on its own once chosen (no form, no confirm). */
  get runsAtOnce(): boolean {
    const option = this.picked.value;
    return option !== undefined && option.form === undefined && !option.confirm;
  }

  /** Run the picked action on the row (with its form's value), then do what follows it; whether it started. */
  async run(table: Pick<ResultTable, 'columns'>, form?: Json): Promise<boolean> {
    const option = this.picked.value;
    const row = this.row.value;
    if (option === undefined || row === undefined) { return false; }
    const bound = boundArgs(option, table, row);
    if (bound === undefined) { return false; }
    const outcome = await this.running.run(async () => {
      if (!await this.#host.run(option.fn, actionArgs(bound, form))) { throw new Error(`Couldn't ${option.label.toLowerCase()}.`); }
      if (option.then === 'refresh') { await this.refresh(); }
    }, `Couldn't ${option.label.toLowerCase()}.`);
    if (outcome.ok) { this.close(); }
    return outcome.ok;
  }

  /** Run the widget again with its args (a new run that shows the fresh result). */
  async refresh(): Promise<boolean> {
    const { fn, args } = this.#source();
    return fn === undefined ? false : this.#host.run(fn, args ?? {});
  }

  /** Run the widget for the page at `offset` (its paging arg set to it, every other arg kept). */
  async page(paging: NonNullable<WidgetResult['paging']>, offset: number): Promise<boolean> {
    const { args } = this.#source();
    const kept = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {};
    return this.apply({ ...kept, [paging.arg]: Math.max(0, Math.floor(offset)) });
  }

  /** Run the widget with new control values. */
  async apply(args: Json): Promise<boolean> {
    const { fn } = this.#source();
    if (fn === undefined) { return false; }
    const outcome = await this.running.run(async () => {
      if (!await this.#host.run(fn, args)) { throw new Error("Couldn't run the widget."); }
    }, "Couldn't run the widget.");
    return outcome.ok;
  }

  close(): void {
    this.row.value = undefined;
    this.offered.value = [];
    this.picked.value = undefined;
    this.step.value = 'choose';
  }
}
