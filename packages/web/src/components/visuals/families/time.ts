/**
 * Measures over time: line, smooth, area, stacked area, step (`line`), bars (`bar`) and stream (`themeRiver`), on a
 * time axis that zooms (pinch on a phone, a slider on a wide screen); a zoom sets the widget's from/to args. A day
 * axis is drawn in UTC, so a date never shifts by the viewer's zone.
 */
import type { BarSeriesOption, LineSeriesOption } from 'echarts/charts';
import { legend, needed, plotGrid, tooltip, zoom, type ChartBuilder, type ChartValue } from '../chart-data.ts';
import { wide } from './wide.ts';

/** A time value as milliseconds, for ordering; text that is not a time sorts last. */
function timeOf(value: ChartValue): number {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * A time axis's labels at each level: a new month or year names it, a day reads "Mar 3", and hours show only within
 * a day, so an axis never shows a bare day number.
 */
export const TIME_LABELS = {
  year: '{yyyy}', month: '{MMM} {yyyy}', day: '{MMM} {d}', hour: '{HH}:{mm}', minute: '{HH}:{mm}', second: '{HH}:{mm}:{ss}', millisecond: '{HH}:{mm}:{ss}',
} as const;

/** One day in milliseconds: a day axis never ticks finer than this. */
const DAY_MS = 86_400_000;

/** A time axis (an x axis, or a stream's single axis): labels per level, and on a day axis no tick finer than a day. */
export function timeAxis(day: boolean): { type: 'time'; minInterval?: number; axisLabel: { hideOverlap: true; formatter: typeof TIME_LABELS } } {
  return { type: 'time', ...(day ? { minInterval: DAY_MS } : {}), axisLabel: { hideOverlap: true, formatter: TIME_LABELS } };
}

export const time: ChartBuilder = (input) => {
  const data = wide(input, 'x');
  const day = needed(input, 'x').facts?.day === true;
  const order = data.source.map((_, i) => i).sort((a, b) => timeOf(data.source[a]?.[0] ?? null) - timeOf(data.source[b]?.[0] ?? null));
  const source = order.map((i) => data.source[i] ?? []);
  const many = data.names.length > 1;
  const range = { kind: 'time' as const, values: [], day };
  const points = source.length * data.names.length;

  if (input.style === 'river') {
    const river = source.flatMap((row) => {
      const at = row[0];
      return at === undefined || at === null ? [] : data.names.map((name, s): [string | number, number, string] => [at, typeof row[s + 1] === 'number' ? Number(row[s + 1]) : 0, name]);
    });
    return {
      option: {
        useUTC: day, tooltip: { ...tooltip('axis'), axisPointer: { type: 'line' } }, legend: legend(true),
        singleAxis: { ...timeAxis(day), top: 16, bottom: 48, left: 16, right: 16 },
        series: [{ type: 'themeRiver', data: river, label: { show: false } }],
      },
      range, points,
    };
  }

  const dims = ['key', ...data.names.map((_, i) => `s${String(i)}`)];
  const stacked = input.style === 'stacked';
  const series = data.names.map((name, s): BarSeriesOption | LineSeriesOption => {
    const encode = { x: 'key', y: dims[s + 1] ?? 's0' };
    if (input.style === 'bar') { return { type: 'bar', name, encode, barMaxWidth: 24 }; }
    return {
      type: 'line', name, encode, showSymbol: source.length <= 40, connectNulls: false,
      ...(input.style === 'smooth' ? { smooth: true } : {}), ...(input.style === 'step' ? { step: 'end' as const } : {}),
      ...(input.style === 'area' || stacked ? { areaStyle: { opacity: stacked ? 0.5 : 0.16 } } : {}), ...(stacked ? { stack: 'total' } : {}),
    };
  });
  return {
    option: {
      useUTC: day, dataset: { dimensions: dims, source }, tooltip: { ...tooltip('axis'), axisPointer: { type: 'line' } }, legend: legend(many),
      grid: plotGrid((many ? 28 : 0) + (input.phone ? 8 : 40)), xAxis: timeAxis(day), yAxis: { type: 'value' },
      dataZoom: zoom(input.phone, { xAxisIndex: [0] }), series,
    },
    rowOf: (click) => (click.dataIndex === undefined ? undefined : data.rowAt(order[click.dataIndex] ?? -1, click.seriesIndex ?? 0)),
    range, points,
  };
};
