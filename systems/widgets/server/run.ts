/**
 * One widget run, the part the kind's `run` and `make_widget`'s preview share: the source read with the widget's args
 * and the first window, its column facts, the spec's visuals that still draw it (the table always last), the chip row,
 * the pager, the row actions and the summary line the chat model reads. The pure pieces are the SDK's
 * (`widgetRunArgs`, `checkWidget`, `widgetControls`, `widgetPager`, `resultFacts`), so a run means the same thing here,
 * in the hub and in the web app.
 */
import {
  BUILT_IN_VISUALS, VisualFamily, WidgetResult, widgetSummary,
  type ContributionView, type FnLive, type GinTypeDef, type Json, type QualifiedName, type ResultTable, type RowActionsQuery, type RunId,
  type WidgetActionOption, type WidgetSpec, type WidgetVisual,
} from '@harness/core';
import { checkWidget, resultFacts, widgetControls, widgetPager, widgetRunArgs, type WidgetRunOptions } from '@harness/sdk';

/** The table visual a widget always offers last. */
export const TABLE_VISUAL: WidgetVisual = { visual: 'table', style: 'table', bind: {} };

/** What a widget run asks the hub for: the source's table, the visual registry and the row actions. */
export interface WidgetHub {
  /** Read the source with these args: the table and the run that made it. */
  read(fn: QualifiedName, args: Record<string, Json>): Promise<{ readonly table: ResultTable; readonly run: RunId }>;
  /** Every visual of `hub/visuals`. */
  visuals(): Promise<readonly ContributionView[]>;
  /** The actions rows of these types offer the run's person, narrowed by the widget's list. */
  rowActions(query: RowActionsQuery): Promise<WidgetActionOption[]>;
}

/** The source a widget reads, as the hub declares it. */
export interface WidgetSource {
  readonly args: GinTypeDef;
  /** Its rows change on their own (`FnDecl.live`). */
  readonly live?: FnLive | undefined;
}

/** What one run is given besides the hub. */
export interface WidgetRunInput {
  readonly spec: WidgetSpec;
  readonly source: WidgetSource;
  /** The widget's args as the caller gave them (the chips the person set, the pager's offset). */
  readonly given: Readonly<Record<string, Json>>;
  readonly options: WidgetRunOptions;
  /** The shortest time between a live widget's runs (`HARNESS_WIDGET_LIVE_FLOOR`). */
  readonly liveFloor: number;
}

/** The row types a table's rows are: its records' type and every column's ref, each once. */
function rowTypes(table: ResultTable): QualifiedName[] {
  const types = [table.records?.type, ...table.columns.map((column) => column.ref)];
  return [...new Set(types.filter((type): type is QualifiedName => type !== undefined))];
}

/** The visuals in the spec's order with the table last (offered once, the spec's own when it lists one). */
function tableLast(visuals: readonly WidgetVisual[]): [WidgetVisual, ...WidgetVisual[]] {
  const table = visuals.find((visual) => visual.visual === TABLE_VISUAL.visual) ?? TABLE_VISUAL;
  const charts = visuals.filter((visual) => visual.visual !== TABLE_VISUAL.visual);
  const [first, ...rest] = charts;
  return first === undefined ? [table] : [first, ...rest, table];
}

/** A visual's words for the summary: its registry label, else the built-in family's, else its name. */
function labelOf(visual: WidgetVisual, entries: readonly ContributionView[]): string {
  if (visual.label !== undefined) { return visual.label; }
  const entry = entries.find((candidate) => candidate.name === visual.visual);
  const family = VisualFamily.safeParse(visual.visual);
  return entry?.label ?? (family.success ? BUILT_IN_VISUALS[family.data].label : visual.visual);
}

/**
 * Run a widget: its source read as a child run with the resolved args, the bindings checked against what came back (a
 * binding that no longer fits is a problem listed with the result, never a failure), and everything the view draws.
 * Rows that came from a write are read-only: no chips, no pager, no drill; row actions stay.
 */
export async function runWidget(input: WidgetRunInput, hub: WidgetHub): Promise<WidgetResult> {
  const { spec, source, given, options } = input;
  const args = widgetRunArgs(source.args, spec, given, options);
  const [{ table, run }, entries] = await Promise.all([hub.read(spec.source, args), hub.visuals()]);
  const facts = resultFacts(table);
  const checked = checkWidget(spec, { args: source.args, facts, entries, table });
  const visuals = tableLast(checked.visuals);
  const readOnly = table.write !== undefined;
  const types = rowTypes(table);
  const actions = types.length === 0 || spec.actions?.length === 0 ? [] : await hub.rowActions({ types, ...(spec.actions === undefined ? {} : { narrow: spec.actions }) });
  const shown = visuals[0];
  const live = spec.live === true && source.live !== undefined ? { every: Math.max(source.live.every, input.liveFloor) } : undefined;
  return WidgetResult.parse({
    title: spec.title,
    table,
    facts,
    source: { fn: spec.source, run, args },
    visuals,
    problems: checked.problems,
    controls: readOnly ? [] : widgetControls(source.args, spec, given),
    presets: readOnly ? [] : spec.presets,
    ...(spec.range === undefined || readOnly ? {} : { range: spec.range }),
    ...(spec.paging === undefined || readOnly ? {} : { paging: widgetPager(spec.paging, table, options.window) }),
    actions,
    ...(spec.drill === undefined || readOnly ? {} : { drill: spec.drill }),
    readOnly,
    ...(live === undefined ? {} : { live }),
    summary: widgetSummary(labelOf(shown, entries), shown.bind, table),
  });
}
