/**
 * Things from a start to an end: a gantt chart (`custom` series, a bar per row from its start to its end, one lane per
 * row or per lane value) and a timeline (`scatter` on a time axis, a point at each start). The time axis zooms; a
 * zoom sets the widget's from/to args.
 */
import type { CustomSeriesRenderItem } from 'echarts';
import { bound, chartValue, labelOf, needed, plotGrid, splitRows, tooltip, zoom, type ChartBuilder } from '../chart-data.ts';
import { TIME_LABELS } from './time.ts';

/** A gantt bar: from the start's point to the end's on the row's lane, a little under the lane's height. */
export const ganttBar: CustomSeriesRenderItem = (_params, api) => {
  const lane = api.value(0); const start = api.coord([api.value(1), lane]); const end = api.coord([api.value(2), lane]);
  const size = api.size?.([0, 1]);
  const height = (Array.isArray(size) ? size[1] ?? 16 : 16) * 0.6;
  const [x0 = 0, y0 = 0] = start; const [x1 = 0] = end;
  const fill = api.visual('color');
  return { type: 'rect', shape: { x: x0, y: y0 - height / 2, width: Math.max(2, x1 - x0), height, r: 3 }, style: fill === undefined ? {} : { fill } };
};

export const timeline: ChartBuilder = (input) => {
  const start = needed(input, 'start'); const end = needed(input, 'end'); const label = needed(input, 'label');
  const lane = bound(input, 'series');
  const day = start.facts?.day === true && end.facts?.day === true;
  const lanes = lane === undefined
    ? input.table.rows.map((row, at) => ({ key: chartValue(row[label.index]), rows: [at] }))
    : splitRows(input.table, lane.index);
  const laneOf = new Map(lanes.flatMap((group, i) => group.rows.map((at) => [at, i] as const)));
  const names = lanes.map((group) => labelOf(group.key));
  const source = input.table.rows.map((row, at) => [laneOf.get(at) ?? 0, chartValue(row[start.index]), chartValue(row[end.index]), labelOf(chartValue(row[label.index]))]);
  const base = {
    useUTC: day, tooltip: tooltip('item'), grid: plotGrid(input.phone ? 8 : 40), dataZoom: zoom(input.phone, { xAxisIndex: [0] }),
    // typed dimensions, so a gantt bar's start and end read as times (text dates otherwise read as names and draw nothing)
    dataset: { dimensions: [{ name: 'lane', type: 'number' as const }, { name: 'start', type: 'time' as const }, { name: 'end', type: 'time' as const }, { name: 'label', type: 'ordinal' as const }], source },
    xAxis: { type: 'time' as const, axisLabel: { hideOverlap: true, formatter: TIME_LABELS } }, yAxis: { type: 'category' as const, data: names, inverse: true, axisLabel: { hideOverlap: true, width: input.phone ? 80 : 160, overflow: 'truncate' as const } },
  };
  const series = input.style === 'timeline'
    ? [{ type: 'scatter' as const, encode: { x: 'start', y: 'lane', tooltip: ['label', 'start', 'end'] }, symbolSize: 10 }]
    : [{ type: 'custom' as const, renderItem: ganttBar, encode: { x: ['start', 'end'], y: 'lane', tooltip: ['label', 'start', 'end'] } }];
  return {
    option: { ...base, series },
    rowOf: (click) => click.dataIndex,
    range: { kind: 'time', values: [], day },
    points: source.length,
    height: Math.max(240, Math.min(640, names.length * 28 + 80)),
  };
};
