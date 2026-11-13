/**
 * Things from a start to an end, each a bar across its range (`custom` series): a gantt chart (one lane per row, or per
 * lane value, named on the axis) and a timeline (items packed into as few lanes as fit without overlapping, each bar
 * labelled inside). The time axis zooms; a zoom sets the widget's from/to args.
 */
import type { CustomSeriesRenderItem } from 'echarts';
import { bound, chartValue, labelOf, needed, plotGrid, splitRows, tooltip, zoom, type ChartBuilder, type ChartValue } from '../chart-data.ts';
import { timeAxis } from './time.ts';

/** A value as milliseconds, or `null` when it is not a time. */
function msOf(value: ChartValue): number | null {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The lane each item takes when packed: in start order, an item goes in the first lane whose last item has ended by
 * its start, else a new lane. Items without both times take lane 0. Returns one lane per item, in the items' order.
 */
export function packLanes(items: readonly { readonly start: number | null; readonly end: number | null }[]): number[] {
  const lanes = items.map(() => 0);
  const ends: number[] = [];
  const order = items.map((_, i) => i).sort((a, b) => (items[a]?.start ?? 0) - (items[b]?.start ?? 0));
  for (const at of order) {
    const from = items[at]?.start ?? null; const to = items[at]?.end ?? null;
    if (from === null || to === null) { continue; }
    const free = ends.findIndex((end) => end <= from);
    const lane = free < 0 ? ends.length : free;
    ends[lane] = Math.max(to, from);
    lanes[at] = lane;
  }
  return lanes;
}

/**
 * A bar from the start's point to the end's on the item's lane, a little under the lane's height; given `ink` (the
 * label's colour) it writes its label inside.
 */
function bar(ink?: string): CustomSeriesRenderItem {
  return (_params, api) => {
    const lane = api.value(0); const start = api.coord([api.value(1), lane]); const end = api.coord([api.value(2), lane]);
    const size = api.size?.([0, 1]);
    const height = (Array.isArray(size) ? size[1] ?? 16 : 16) * 0.6;
    const [x0 = 0, y0 = 0] = start; const [x1 = 0] = end;
    const width = Math.max(2, x1 - x0);
    const fill = api.visual('color');
    const text = String(api.value(3));
    return {
      type: 'rect', shape: { x: x0, y: y0 - height / 2, width, height, r: 3 }, style: fill === undefined ? {} : { fill },
      // the label rides inside the bar and is cut at its end, so neighbouring bars never collide
      ...(ink === undefined ? {} : { textContent: { type: 'text' as const, style: { text, fill: ink, fontSize: 11, width: Math.max(0, width - 8), overflow: 'truncate' as const } }, textConfig: { position: 'insideLeft' as const } }),
    };
  };
}

/** A gantt bar (no label inside: the lane's name is on the axis). */
export const ganttBar: CustomSeriesRenderItem = bar();

export const timeline: ChartBuilder = (input) => {
  const start = needed(input, 'start'); const end = needed(input, 'end'); const label = needed(input, 'label');
  const lane = bound(input, 'series');
  const day = start.facts?.day === true && end.facts?.day === true;
  const packed = input.style === 'timeline';
  const rows = input.table.rows;
  const lanes = packed
    ? packLanes(rows.map((row) => ({ start: msOf(chartValue(row[start.index])), end: msOf(chartValue(row[end.index])) })))
    : undefined;
  const groups = lane === undefined ? rows.map((row, at) => ({ key: chartValue(row[label.index]), rows: [at] })) : splitRows(input.table, lane.index);
  const laneOf = new Map(groups.flatMap((group, i) => group.rows.map((at) => [at, i] as const)));
  const count = lanes === undefined ? groups.length : Math.max(0, ...lanes) + 1;
  const names = lanes === undefined ? groups.map((group) => labelOf(group.key)) : Array.from({ length: count }, (_, i) => String(i + 1));
  const source = rows.map((row, at) => [lanes?.[at] ?? laneOf.get(at) ?? 0, chartValue(row[start.index]), chartValue(row[end.index]), labelOf(chartValue(row[label.index]))]);
  return {
    option: {
      useUTC: day, tooltip: tooltip('item'), grid: plotGrid(input.phone ? 8 : 40), dataZoom: zoom(input.phone, { xAxisIndex: [0] }),
      // typed dimensions, so a bar's start and end read as times (text dates otherwise read as names and draw nothing)
      dataset: { dimensions: [{ name: 'lane', type: 'number' as const }, { name: 'start', type: 'time' as const }, { name: 'end', type: 'time' as const }, { name: 'label', type: 'ordinal' as const }], source },
      xAxis: timeAxis(day),
      yAxis: { type: 'category' as const, data: names, inverse: true, ...(packed ? { show: false } : { axisLabel: { hideOverlap: true, width: input.phone ? 80 : 160, overflow: 'truncate' as const } }) },
      series: [{ type: 'custom' as const, renderItem: packed ? bar(input.palette.surface) : ganttBar, encode: { x: ['start', 'end'], y: 'lane', tooltip: ['label', 'start', 'end'] } }],
    },
    rowOf: (click) => click.dataIndex,
    range: { kind: 'time', values: [], day },
    points: source.length,
    height: Math.max(packed ? 200 : 240, Math.min(640, count * (packed ? 36 : 28) + 80)),
  };
};
