/**
 * One drawn widget's state (widget pass), apart from any component:
 *
 * - **Levels.** The widget's own level, then a level per drill (a click on a row's mark runs the widget's drill fn with
 *   args from the row, else the drill through the query its result declares, `ResultTable.drill`) or per action whose
 *   rows open; a breadcrumb leads back. Drill levels are kept in the URL (`level`, through the host) and replayed when
 *   the page opens again. A widget view on a page opens a drill in a modal instead (`drillStep`), whose own view
 *   drills again as levels.
 * - **The buffer.** Each level holds the rows read so far; the grid pages through them locally and the pager asks the
 *   source again (offset = rows held) only when a page needs more. An empty answer means "No more rows".
 * - **The chip row.** Chip changes are staged and applied together (relative dates resolved then); a preset sets its
 *   args and runs at once; a chart's zoom or calendar period sets the range args and runs.
 * - **Actions.** A row's menu lists what it can take; picking one shows its form (args left after binding), then the
 *   confirm for anything above a read, then runs it as an ordinary run; what follows is its `then` (refresh, its rows
 *   as a new level, or a status line).
 * - **Live.** A live widget re-runs in place while shown, never two at once, when the host's reads stay out of the
 *   page's history.
 *
 * Nothing runs until a person clicks, but a live widget's re-runs and a URL's drill levels.
 */
import { columnFacts, Json, type ResultFacts, type ResultTable, type WidgetActionOption, type WidgetPreset } from '@harness/core';
import { computed, ref, shallowRef } from 'vue';
import { Task } from '../../state/loaded.ts';
import { csvFileName } from '../results/table.ts';
import type { VisualRange } from '../results/visuals.ts';
import { FnWidgetSource, frameOf, type WidgetFrame, type WidgetSource } from './widget-source.ts';
import {
  actionArgs, actionsForRow, chipArgs, crumbLabel, drillStepOf, localZone, readLevels, rowArgs, rowName, rowTypes, sameValue, type ChipValue, type DrillStep, type WidgetHost,
} from './widgets.ts';

/** One level of the widget: its frame, the args it ran with, the rows held and how it is asked again. */
export interface WidgetLevel {
  /** Its crumb. */
  readonly label: string;
  readonly frame: WidgetFrame;
  /** The args it ran with (no paging offset). */
  readonly args: Readonly<Record<string, Json>>;
  /** Every row read so far, from the first. */
  readonly rows: ResultTable['rows'];
  /** Whether the source may have more after them. */
  readonly more: boolean;
  /** Its row actions. */
  readonly actions: readonly WidgetActionOption[];
  /** How it is asked again; undefined when it can't be (a preview, an action's rows). */
  readonly source: WidgetSource | undefined;
  /** The drill that opened it, for the URL. */
  readonly step: DrillStep | undefined;
}

/** Where a picked action is: choosing one for the row, filling its form, or confirming it. */
export type ActionStep = 'choose' | 'form' | 'confirm';

/** What the widget starts from: its first frame, the args it ran with, and how it is asked again. */
export interface WidgetStart {
  readonly frame: WidgetFrame;
  readonly args: Readonly<Record<string, Json>>;
  readonly source: WidgetSource | undefined;
  /** The view's key: whose drill levels the URL's `level` holds. */
  readonly key: string;
}

/** The clock and time zone relative dates resolve in. */
export interface WidgetClock {
  now(): Date;
  zone(): string;
}

const SYSTEM_CLOCK: WidgetClock = { now: () => new Date(), zone: localZone };

/** One drawn widget. */
export class WidgetState {
  readonly #host: WidgetHost | undefined;
  readonly #key: string;
  readonly #clock: WidgetClock;
  readonly levels = shallowRef<readonly WidgetLevel[]>([]);
  /** Fetching rows (the pager, a chip set, a range, a refresh, a drill). */
  readonly reading = new Task();
  /** Running a row's action. */
  readonly acting = new Task();
  /** A line after something that shows nothing else ("No more rows", an action's status). */
  readonly status = ref('');
  /** The chip values staged and not yet applied, by arg. */
  readonly staged = shallowRef<Readonly<Record<string, ChipValue>>>({});

  /** The row whose actions are open (its index in the rows held), the actions it can take, and the one picked. */
  readonly row = ref<number | undefined>(undefined);
  readonly offered = shallowRef<readonly WidgetActionOption[]>([]);
  readonly picked = shallowRef<WidgetActionOption | undefined>(undefined);
  readonly step = ref<ActionStep>('choose');
  #form: Json | undefined;

  /**
   * The read generation: every read and every change of level takes the next one, and a read's answer lands only while
   * its generation is still the latest (a late refresh, zoom or page never overwrites a level opened after it).
   */
  #generation = 0;

  #liveTimer: ReturnType<typeof setTimeout> | undefined;
  #shown: () => boolean = () => true;

  constructor(host: WidgetHost | undefined, start: WidgetStart, clock: WidgetClock = SYSTEM_CLOCK) {
    this.#host = host;
    this.#key = start.key;
    this.#clock = clock;
    this.levels.value = [{ label: start.frame.title, frame: start.frame, args: start.args, rows: start.frame.table.rows, more: start.frame.paging?.more ?? false, actions: start.frame.actions ?? [], source: start.source, step: undefined }];
  }

  /** The level shown. */
  readonly level = computed((): WidgetLevel => {
    const levels = this.levels.value;
    const top = levels[levels.length - 1];
    if (top === undefined) { throw new Error('A widget always has its own level.'); }
    return top;
  });

  /** The rows held, as one table from the first row (the grid pages through it; `truncated` while more may follow). */
  readonly table = computed((): ResultTable => {
    const { frame, rows, more } = this.level.value;
    return { ...frame.table, rows, offset: 0, truncated: more };
  });

  /** The column facts over the rows held (the source's own while nothing was added). */
  readonly facts = computed((): ResultFacts => {
    const { frame, rows } = this.level.value;
    return rows === frame.table.rows ? frame.facts : columnFacts(this.table.value);
  });

  /** Whether the widget can be asked again (it has a host and a source). */
  readonly live = computed(() => this.#host !== undefined && this.level.value.source !== undefined);
  /** Whether the chip row has changes to apply. */
  readonly dirty = computed(() => this.level.value.frame.controls.some((c) => Object.hasOwn(this.staged.value, c.arg) && !sameValue(this.staged.value[c.arg], c.value)));
  /** Whether rows can be clicked into: the level declares a drill or its rows one through the query, and can be asked. */
  readonly drills = computed(() => {
    const { frame } = this.level.value;
    return this.#host !== undefined && !frame.readOnly && (frame.drill !== undefined || frame.table.drill !== undefined);
  });

  // ── chips ───────────────────────────────────────────────────────────────────

  /** A chip's value now: staged, else the one it ran with. */
  chipValue(arg: string): ChipValue | undefined {
    if (Object.hasOwn(this.staged.value, arg)) { return this.staged.value[arg]; }
    return this.level.value.frame.controls.find((c) => c.arg === arg)?.value;
  }

  /** Stage a chip's value (`null` is "Any"). */
  stage(arg: string, value: ChipValue): void {
    this.staged.value = { ...this.staged.value, [arg]: value };
  }

  /** Drop the staged chip values. */
  discard(): void {
    this.staged.value = {};
  }

  /** Run with the staged chip values; whether it worked. */
  async apply(): Promise<boolean> {
    const level = this.level.value;
    const args = chipArgs(level.frame.controls, this.staged.value, this.#clock.now(), this.#clock.zone());
    const ok = await this.#rerun(args);
    if (ok) { this.discard(); }
    return ok;
  }

  /** A preset: set its args and run at once. */
  async preset(preset: WidgetPreset): Promise<boolean> {
    this.staged.value = { ...this.staged.value, ...preset.sets };
    return this.apply();
  }

  /** A chart's zoom or period: set the range args and run. */
  async range(range: VisualRange): Promise<boolean> {
    const claimed = this.level.value.frame.range;
    if (claimed === undefined || !this.live.value) { return false; }
    return this.#rerun({ ...this.level.value.args, [claimed.from]: range.from, [claimed.to]: range.to });
  }

  /** Run the level again with its args, from its first row. */
  async refresh(): Promise<boolean> {
    return this.#rerun(this.level.value.args);
  }

  // ── the pager ───────────────────────────────────────────────────────────────

  /** Read the next window after the rows held and add it; an empty one ends the buffer ("No more rows"). */
  async more(): Promise<boolean> {
    const level = this.level.value;
    const paging = level.frame.paging;
    if (paging === undefined || !level.more || level.source === undefined || this.reading.busy.value) { return false; }
    const source = level.source;
    const generation = ++this.#generation;
    const outcome = await this.reading.run(() => source.run({ ...level.args, [paging.offset]: level.rows.length }), "Couldn't read more rows.");
    if (!outcome.ok || !this.#current(generation, level)) { return false; }
    const added = outcome.value.table.rows;
    if (added.length === 0) { this.status.value = 'No more rows'; }
    this.#replaceTop({ ...level, rows: [...level.rows, ...added], more: added.length > 0 && (outcome.value.paging?.more ?? false) });
    return true;
  }

  // ── levels ──────────────────────────────────────────────────────────────────

  /**
   * What a click on a row's mark drills into: the level's own drill with args from the row, else the drill through
   * the query its rows declare; undefined when the row stands for no group it can open (a NULL key) or nothing drills.
   */
  drillStep(rowIndex: number): DrillStep | undefined {
    if (!this.drills.value) { return undefined; }
    return drillStepOf(this.level.value.frame.drill, this.table.value, rowIndex);
  }

  /** A click on a row's mark: run its drill (`drillStep`) as a new level. */
  async drill(rowIndex: number): Promise<boolean> {
    const step = this.drillStep(rowIndex);
    const host = this.#host;
    if (step === undefined || host === undefined) { return false; }
    return this.#open(step, host);
  }

  /** Go back to a level (its index in the breadcrumb). */
  back(index: number): void {
    if (index < 0 || index >= this.levels.value.length - 1) { return; }
    this.#generation++;
    this.levels.value = this.levels.value.slice(0, index + 1);
    this.#close();
    this.#writeLevels();
  }

  /** Open the drill levels the URL holds for this widget, one after the other. */
  async restore(): Promise<void> {
    const host = this.#host;
    const kept = host?.levels === undefined ? undefined : readLevels(host.levels.get());
    if (host === undefined || kept?.of !== this.#key || this.levels.value.length > 1) { return; }
    for (const step of kept.steps) {
      if (!await this.#open(step, host)) { return; }
    }
  }

  async #open(step: DrillStep, host: WidgetHost): Promise<boolean> {
    const source = new FnWidgetSource(host, step.fn, step.label, step.paging);
    const generation = ++this.#generation;
    const outcome = await this.reading.run(() => source.run(step.args), `Couldn't open ${step.label}.`);
    if (!outcome.ok || generation !== this.#generation) { return false; }
    return this.#push(outcome.value, step.label, step.args, source, step);
  }

  /** Put a level on top; false when something else changed the levels while its actions were asked for. */
  async #push(frame: WidgetFrame, label: string, args: Readonly<Record<string, Json>>, source: WidgetSource | undefined, step: DrillStep | undefined): Promise<boolean> {
    const generation = ++this.#generation;
    const actions = await this.#actionsOf(frame);
    if (generation !== this.#generation) { return false; }
    this.levels.value = [...this.levels.value, { label, frame, args, rows: frame.table.rows, more: frame.paging?.more ?? false, actions, source, step }];
    this.discard();
    this.#close();
    this.#writeLevels();
    this.#schedule();
    return true;
  }

  /** The drill steps up to the first level that wasn't a drill, as the URL keeps them. */
  #writeLevels(): void {
    const keep = this.#host?.levels;
    if (keep === undefined) { return; }
    const steps: DrillStep[] = [];
    for (const level of this.levels.value.slice(1)) {
      if (level.step === undefined) { break; }
      steps.push(level.step);
    }
    const now = readLevels(keep.get());
    if (steps.length === 0) {
      if (now?.of === this.#key) { keep.set(''); }
      return;
    }
    keep.set(JSON.stringify({ of: this.#key, steps }));
  }

  // ── row actions ─────────────────────────────────────────────────────────────

  /** Ask the host for the level's row actions when its frame carries none. */
  async loadActions(): Promise<void> {
    const level = this.level.value;
    if (level.frame.actions !== undefined || level.actions.length > 0) { return; }
    const actions = await this.#actionsOf(level.frame);
    if (actions.length > 0 && this.level.value === level) { this.#replaceTop({ ...level, actions }); }
  }

  async #actionsOf(frame: WidgetFrame): Promise<readonly WidgetActionOption[]> {
    if (frame.actions !== undefined) { return frame.actions; }
    const types = rowTypes(frame.table);
    if (this.#host === undefined || types.length === 0) { return []; }
    try {
      return await this.#host.actions({ types });
    } catch {
      return [];
    }
  }

  /** Whether a row (by its index in the rows held) has any action to offer. */
  hasActions(rowIndex: number): boolean {
    return this.#host !== undefined && actionsForRow(this.level.value.actions, this.table.value, rowIndex).length > 0;
  }

  /** Open a row's actions, to choose one. */
  openRow(rowIndex: number): void {
    this.row.value = rowIndex;
    this.offered.value = actionsForRow(this.level.value.actions, this.table.value, rowIndex);
    this.acting.problem.value = '';
    this.picked.value = undefined;
    this.#form = undefined;
    this.step.value = 'choose';
  }

  /** The open row's name, for the menu's title and the confirm. */
  readonly rowName = computed(() => (this.row.value === undefined ? undefined : rowName(this.table.value, this.row.value)));

  /** Pick an action: its form first when it has args left, else its confirm when it asks, else run it. */
  async choose(option: WidgetActionOption): Promise<boolean> {
    this.picked.value = option;
    if (option.form !== undefined) { this.step.value = 'form'; return true; }
    if (option.confirm) { this.step.value = 'confirm'; return true; }
    return this.runAction();
  }

  /** The form is filled: the confirm follows for anything that asks, else it runs. */
  async submitForm(value: Json): Promise<boolean> {
    this.#form = value;
    if (this.picked.value?.confirm === true) { this.step.value = 'confirm'; return true; }
    return this.runAction();
  }

  /** Run the picked action on the open row as an ordinary run, then what follows it; whether it worked. */
  async runAction(): Promise<boolean> {
    const option = this.picked.value;
    const rowIndex = this.row.value;
    const host = this.#host;
    if (option === undefined || rowIndex === undefined || host === undefined) { return false; }
    const bound = rowArgs(option.bind, this.table.value, rowIndex);
    if (bound === undefined) { return false; }
    const name = this.rowName.value;
    const failure = `Couldn't ${option.label.toLowerCase()}.`;
    const outcome = await this.acting.run(async () => {
      // a run that stops for approval is approved in the page (the chat's card), so the dialog steps aside meanwhile
      const ran = await host.run(option.fn, actionArgs(bound, this.#form), () => {
        this.#close();
        this.status.value = `${option.label}: waiting for your approval.`;
      });
      if (!ran.ok) { throw new Error(ran.problem); }
      return ran.output;
    }, failure);
    if (!outcome.ok) { return false; }
    this.#close();
    if (option.then === 'refresh') { await this.refresh(); return true; }
    const frame = option.then === 'open' ? frameOf(outcome.value, crumbLabel(option.label, name)) : undefined;
    if (frame !== undefined) { return this.#push(frame, frame.title, {}, undefined, undefined); }
    this.status.value = `${option.label}: done.`;
    return true;
  }

  /** Close the row's actions. */
  close(): void {
    this.#close();
  }

  #close(): void {
    this.row.value = undefined;
    this.offered.value = [];
    this.picked.value = undefined;
    this.#form = undefined;
    this.step.value = 'choose';
  }

  // ── export and live ─────────────────────────────────────────────────────────

  /** Download the level's whole result as CSV (the hub's streamed export); whether it started. */
  async exportCsv(): Promise<boolean> {
    const query = this.level.value.frame.export;
    const host = this.#host;
    if (query === undefined || host === undefined) { return false; }
    const outcome = await this.reading.run(() => host.exportCsv(query, csvFileName(this.level.value.frame.title)), "Couldn't export it.");
    return outcome.ok;
  }

  /** How often it re-runs on its own, in ms; undefined when it doesn't (not live, or the host's reads aren't quiet). */
  readonly every = computed(() => (this.#host?.quiet === true && this.live.value ? this.level.value.frame.live?.every : undefined));

  /** Start re-running while live; `shown` says whether it is on screen now (a hidden one waits). */
  startLive(shown: () => boolean): void {
    this.#shown = shown;
    this.#schedule();
  }

  /** Stop re-running (the view left). */
  stopLive(): void {
    if (this.#liveTimer !== undefined) { clearTimeout(this.#liveTimer); }
    this.#liveTimer = undefined;
    this.#shown = () => false;
  }

  #schedule(): void {
    if (this.#liveTimer !== undefined) { clearTimeout(this.#liveTimer); }
    this.#liveTimer = undefined;
    const every = this.every.value;
    if (every === undefined) { return; }
    this.#liveTimer = setTimeout(() => {
      this.#liveTimer = undefined;
      if (this.#shown() && !this.reading.busy.value && this.row.value === undefined) { void this.refresh(); } else { this.#schedule(); }
    }, every);
  }

  // ── running again ───────────────────────────────────────────────────────────

  async #rerun(args: Readonly<Record<string, Json>>): Promise<boolean> {
    const level = this.level.value;
    const source = level.source;
    if (source === undefined || this.#host === undefined) { return false; }
    const generation = ++this.#generation;
    const outcome = await this.reading.run(() => source.run(args), "Couldn't run the widget.");
    if (!this.#current(generation, level)) { return false; }
    if (outcome.ok) {
      const frame = outcome.value;
      this.status.value = '';
      this.#replaceTop({ ...level, frame, args, rows: frame.table.rows, more: frame.paging?.more ?? false, actions: frame.actions ?? level.actions });
    }
    this.#schedule();
    return outcome.ok;
  }

  /** Whether a read that took `generation` on `level` may still land (nothing read or changed level since). */
  #current(generation: number, level: WidgetLevel): boolean {
    return generation === this.#generation && this.level.value === level;
  }

  #replaceTop(level: WidgetLevel): void {
    this.levels.value = [...this.levels.value.slice(0, -1), level];
  }
}

/** A run's args as widget args (an object; anything else is none), without the pager's offset. */
export function startArgs(args: Json | undefined, offset: string | undefined): Record<string, Json> {
  const given = Json.safeParse(args);
  const value = given.success ? given.data : undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { return {}; }
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== offset));
}
