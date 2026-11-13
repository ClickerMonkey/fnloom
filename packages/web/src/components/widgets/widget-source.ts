/**
 * What a widget view draws and asks again (widget pass, data-grid "one view"): a `WidgetFrame` is one level of a widget
 * as the view draws it (its first window of rows, the visuals it offers, its chip row, pager, range, actions, drill),
 * made from a widget's result or a plain result table; a `WidgetSource` runs it again with other args. A widget fn (or
 * a drill's fn) is one source; the Data page's records are another, over `hub/records_table`.
 */
import {
  columnFacts, type ExportQuery, type Json, type QualifiedName, type ResultFacts, type ResultTable, type WidgetActionOption, type WidgetDrill, type WidgetPager,
  type WidgetPreset, type WidgetRange, type WidgetResult, type WidgetShownControl, type WidgetVisual,
} from '@harness/core';
import { exportQuery, resultTableOf, widgetResultOf, type WidgetHost } from './widgets.ts';

/** One level of a widget as the view draws it. */
export interface WidgetFrame {
  readonly title: string;
  /** The first window of rows (the pager adds to it). */
  readonly table: ResultTable;
  readonly facts: ResultFacts;
  /** The visuals it offers, in its order; undefined offers every visual that fits. */
  readonly visuals: readonly WidgetVisual[] | undefined;
  readonly controls: readonly WidgetShownControl[];
  readonly presets: readonly WidgetPreset[];
  readonly range: WidgetRange | undefined;
  readonly paging: WidgetPager | undefined;
  /** Its row actions; undefined asks the host for those of the rows' types. */
  readonly actions: readonly WidgetActionOption[] | undefined;
  readonly drill: WidgetDrill | undefined;
  /** The rows came from a write: no chips, pager or drill. */
  readonly readOnly: boolean;
  readonly live: { readonly every: number } | undefined;
  readonly problems: readonly string[];
  /** The streamed export of its whole result, when its source pages. */
  readonly export: ExportQuery | undefined;
}

/** A widget's result as a frame. */
export function resultFrame(result: WidgetResult): WidgetFrame {
  return {
    title: result.title, table: result.table, facts: result.facts, visuals: result.visuals, controls: result.controls, presets: result.presets,
    range: result.readOnly ? undefined : result.range, paging: result.readOnly ? undefined : result.paging, actions: result.actions,
    drill: result.readOnly ? undefined : result.drill, readOnly: result.readOnly, live: result.readOnly ? undefined : result.live, problems: result.problems,
    export: exportQuery(result),
  };
}

/** A plain result table as a frame: every fitting visual, no chips or pager, read-only when it came from a write. */
export function tableFrame(table: ResultTable, title: string): WidgetFrame {
  return {
    title, table, facts: columnFacts(table), visuals: undefined, controls: [], presets: [], range: undefined, paging: undefined, actions: undefined,
    drill: undefined, readOnly: table.write !== undefined, live: undefined, problems: [], export: undefined,
  };
}

/** A run's output as a frame: a widget's result or a result table; undefined for anything else. */
export function frameOf(output: Json | undefined, title: string): WidgetFrame | undefined {
  const result = widgetResultOf(output);
  if (result !== undefined) { return resultFrame(result); }
  const table = resultTableOf(output);
  return table === undefined ? undefined : tableFrame(table, title);
}

/** A widget level's rows, asked again with other args. */
export interface WidgetSource {
  /** Run with these args (the chips' values, a range, the pager's offset) and give the frame drawn. */
  run(args: Readonly<Record<string, Json>>): Promise<WidgetFrame>;
}

/** A fn whose output is a widget's result or a result table (a widget fn, a drill's fn), read through the host. */
export class FnWidgetSource implements WidgetSource {
  readonly #host: WidgetHost;
  readonly #fn: QualifiedName;
  readonly #title: string;

  constructor(host: WidgetHost, fn: QualifiedName, title: string) {
    this.#host = host;
    this.#fn = fn;
    this.#title = title;
  }

  async run(args: Readonly<Record<string, Json>>): Promise<WidgetFrame> {
    const frame = frameOf(await this.#host.read(this.#fn, args), this.#title);
    if (frame === undefined) { throw new Error(`${this.#fn} didn't return a table.`); }
    return frame;
  }
}
