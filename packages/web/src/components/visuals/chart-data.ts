/**
 * What every chart family builds from, and the small reshaping they share: a table's cells as ECharts values, bound
 * columns by channel, rows split by a key, long rows pivoted wide. None of it aggregates; the maths that does
 * (histogram bins, quartiles, a pie's "Other") is in `maths.ts` and runs only over a whole result.
 */
import { labelFor, type ColumnFacts, type Json, type ResultFacts, type ResultTable, type VisualBinding } from '@harness/core';
import type { ChartOption } from './echarts-setup.ts';
import type { ChartPalette } from './palette.ts';

/** One cell as ECharts reads it: numbers and text as they are, a boolean as Yes/No, anything else as JSON. */
export type ChartValue = number | string | null;

/** What a family is drawn from. */
export interface ChartInput {
  readonly table: ResultTable;
  readonly facts: ResultFacts;
  /** Channel → columns: the ranking's default binding with the widget's own over it. */
  readonly bind: VisualBinding;
  readonly style: string;
  readonly palette: ChartPalette;
  /** Drawn narrower than 600px: legends at the bottom, fewer labels, no zoom slider. */
  readonly phone: boolean;
  /** How many periods back from the latest a paged family (the calendar) shows; 0 is the latest. */
  readonly shift: number;
}

/** The part of an ECharts click a family maps back to a row. */
export interface ChartClick {
  readonly seriesIndex?: number | undefined;
  readonly dataIndex?: number | undefined;
  readonly dataType?: string | undefined;
  readonly name?: string | undefined;
}

/** The axis a zoom (or a calendar's period) sets a widget's range from. */
export interface RangeAxis {
  /** `time`: zoom values are instants; `category`: indexes into `values`. */
  readonly kind: 'time' | 'category';
  readonly values: readonly ChartValue[];
  /** A calendar day, written back as `YYYY-MM-DD`. */
  readonly day: boolean;
}

/** The period a paged family shows, with what it sets the range to. */
export interface ChartPeriod {
  readonly label: string;
  readonly from: string;
  readonly to: string;
  /** Whether there is data before or after it. */
  readonly before: boolean;
  readonly after: boolean;
}

/** A family's drawing: its option, how a click maps to a row, and the axis a zoom sets the range from. */
export interface ChartDraw {
  readonly option: ChartOption;
  /** The row (index in `table.rows`) a click lands on; `undefined` for marks that stand for many rows. */
  rowOf?(click: ChartClick): number | undefined;
  readonly range?: RangeAxis | undefined;
  readonly period?: ChartPeriod | undefined;
  /** How many marks it draws, for picking the renderer. */
  readonly points: number;
  /** Its height in pixels, when not the chart's usual. */
  readonly height?: number | undefined;
}

/** Why a family can't draw this data after all (a cycle a flow chart can't lay out); shown instead of the chart. */
export interface ChartProblem {
  readonly problem: string;
}

/** A family's option builder. */
export type ChartBuilder = (input: ChartInput) => ChartDraw | ChartProblem;

/** One cell as ECharts reads it. */
export function chartValue(value: Json | undefined): ChartValue {
  if (value === undefined || value === null) { return null; }
  if (typeof value === 'number' || typeof value === 'string') { return value; }
  if (typeof value === 'boolean') { return value ? 'Yes' : 'No'; }
  return JSON.stringify(value);
}

/** A cell as a number, or `null` for anything that is not one. */
export function numberOf(value: Json | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The column bound to a channel (its first), with its index and facts; `undefined` when the channel is unbound. */
export interface BoundColumn {
  readonly name: string;
  readonly index: number;
  readonly facts: ColumnFacts | undefined;
  /** What a person reads for it (axis names, series names, tooltips): its own label, else its name humanized. */
  readonly label: string;
}

/** Every column bound to a channel, in order. */
export function boundAll(input: Pick<ChartInput, 'table' | 'facts' | 'bind'>, channel: string): BoundColumn[] {
  return (input.bind[channel] ?? []).flatMap((name) => {
    const index = input.table.columns.findIndex((column) => column.name === name);
    const column = input.table.columns[index];
    if (column === undefined) { return []; }
    return [{ name, index, facts: input.facts.columns.find((c) => c.name === name), label: labelFor(column) }];
  });
}

/** The column bound to a channel. */
export function bound(input: Pick<ChartInput, 'table' | 'facts' | 'bind'>, channel: string): BoundColumn | undefined {
  return boundAll(input, channel)[0];
}

/** The column bound to a required channel; ranking never offers a family without it, so its absence is a bug. */
export function needed(input: Pick<ChartInput, 'table' | 'facts' | 'bind'>, channel: string): BoundColumn {
  const column = bound(input, channel);
  if (column === undefined) { throw new Error(`The ${channel} channel is not bound.`); }
  return column;
}

/** A dataset dimension: named for `encode`, with the words a tooltip shows for it (`displayName`). */
export interface Dimension {
  readonly name: string;
  readonly displayName: string;
}

/** The dimension of a bound column: its name for `encode`, its label for the tooltip. */
export function dimension(column: Pick<BoundColumn, 'name' | 'label'>, name = column.name): Dimension {
  return { name, displayName: column.label };
}

/** The whole table as a dataset: a dimension per column (by name, so `encode` names columns; its label for tooltips) and a row per row. */
export function dataset(table: ResultTable): { dimensions: Dimension[]; source: ChartValue[][] } {
  return { dimensions: table.columns.map((column) => ({ name: column.name, displayName: labelFor(column) })), source: table.rows.map((row) => row.map(chartValue)) };
}

/** The distinct values of a column, in the order they first appear. */
export function distinctValues(table: ResultTable, index: number): ChartValue[] {
  const seen = new Map<string, ChartValue>();
  for (const row of table.rows) {
    const value = chartValue(row[index]);
    const key = JSON.stringify(value);
    if (!seen.has(key)) { seen.set(key, value); }
  }
  return [...seen.values()];
}

/** Rows split by a key column's value, each group keeping its rows' indexes. */
export interface RowGroup {
  readonly key: ChartValue;
  readonly rows: readonly number[];
}

/** The rows of each value of a key column, in first-appearance order. */
export function splitRows(table: ResultTable, index: number): RowGroup[] {
  const groups = new Map<string, { key: ChartValue; rows: number[] }>();
  table.rows.forEach((row, at) => {
    const key = chartValue(row[index]);
    const id = JSON.stringify(key);
    const group = groups.get(id) ?? { key, rows: [] };
    group.rows.push(at);
    groups.set(id, group);
  });
  return [...groups.values()];
}

/** Long rows (key, series, value) pivoted wide: a row per key, a column per series value, and where each cell came from. */
export interface Pivot {
  readonly keys: ChartValue[];
  readonly series: ChartValue[];
  /** `[key, value per series…]` per key. */
  readonly source: ChartValue[][];
  /** The row a (key index, series index) cell came from. */
  rowAt(key: number, series: number): number | undefined;
}

/** Pivot a measure by a key and a series column. When a key and series repeat, the last row's value is drawn. */
export function pivot(table: ResultTable, key: number, series: number, value: number): Pivot {
  const keys = distinctValues(table, key);
  const names = distinctValues(table, series);
  const keyAt = new Map(keys.map((k, i) => [JSON.stringify(k), i]));
  const seriesAt = new Map(names.map((s, i) => [JSON.stringify(s), i]));
  const source = keys.map((k): ChartValue[] => [k, ...names.map((): ChartValue => null)]);
  const from = new Map<string, number>();
  table.rows.forEach((row, at) => {
    const k = keyAt.get(JSON.stringify(chartValue(row[key])));
    const s = seriesAt.get(JSON.stringify(chartValue(row[series])));
    const line = k === undefined ? undefined : source[k];
    if (k === undefined || s === undefined || line === undefined) { return; }
    line[s + 1] = numberOf(row[value]);
    from.set(`${String(k)}:${String(s)}`, at);
  });
  return { keys, series: names, source, rowAt: (k, s) => from.get(`${String(k)}:${String(s)}`) };
}

/** A label for a value on a legend or axis. */
export function labelOf(value: ChartValue): string {
  return value === null ? '(empty)' : String(value);
}

/** The legend every multi-series family uses: scrollable, at the bottom, so it never covers the plot on a phone. */
export function legend(show: boolean): NonNullable<ChartOption['legend']> {
  return { show, type: 'scroll', bottom: 0, left: 'center', icon: 'roundRect', itemWidth: 12, itemHeight: 8 };
}

/** The tooltip, kept inside the chart; ECharts shows it on tap as well as hover (its default `triggerOn`), so nothing is hover-only. */
export function tooltip(trigger: 'item' | 'axis'): { trigger: 'item' | 'axis'; confine: true; axisPointer?: { type: 'shadow' } } {
  return { trigger, confine: true, ...(trigger === 'axis' ? { axisPointer: { type: 'shadow' } } : {}) };
}

/** The plot grid: labels contained (outer bounds, not the deprecated containLabel), room at the bottom for a legend or zoom. */
export function plotGrid(bottom: number): NonNullable<ChartOption['grid']> {
  return { left: 8, right: 16, top: 24, bottom, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' };
}

/** Pinch and wheel zoom on an axis, with a slider under it on a wide screen. */
export function zoom(phone: boolean, axes: { readonly xAxisIndex?: number[]; readonly yAxisIndex?: number[] } = {}): NonNullable<ChartOption['dataZoom']> {
  const inside = { type: 'inside' as const, ...axes };
  return phone || axes.yAxisIndex !== undefined ? [inside] : [inside, { type: 'slider' as const, height: 18, bottom: 28, ...axes }];
}

/** An ISO day or instant for a zoom end: a day column gets `YYYY-MM-DD`, anything else the full ISO time. */
export function isoOf(time: number, day: boolean): string {
  const iso = new Date(time).toISOString();
  return day ? iso.slice(0, 10) : iso;
}
