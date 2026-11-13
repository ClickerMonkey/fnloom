/**
 * How numbers spread: points and bubbles (`scatter`), rippling points (`effectScatter`), a histogram (`bar` over
 * bins), box plots (`boxplot`, quartiles from ECharts' `boxplot` transform) and parallel axes (`parallel`). A group
 * column makes a series per group. Histogram and box plot are whole-result styles (ranking hides them otherwise).
 */
import type { EffectScatterSeriesOption, ScatterSeriesOption } from 'echarts/charts';
import { bound, boundAll, labelOf, legend, needed, numberOf, plotGrid, splitRows, tooltip, type ChartBuilder, type ChartInput, type RowGroup } from '../chart-data.ts';
import { histogram } from '../maths.ts';

/** The smallest and largest bubble, in pixels. */
const BUBBLE = { min: 6, max: 36 } as const;

/** The rows by the group column, or every row as one group. */
function groupsOf(input: ChartInput): RowGroup[] {
  const group = bound(input, 'group');
  return group === undefined ? [{ key: null, rows: input.table.rows.map((_, i) => i) }] : splitRows(input.table, group.index);
}

export const distribution: ChartBuilder = (input) => {
  const x = needed(input, 'x');
  const groups = groupsOf(input);
  const named = bound(input, 'group') !== undefined;
  const values = (rows: readonly number[], index: number): number[] => rows.flatMap((at) => { const v = numberOf(input.table.rows[at]?.[index]); return v === null ? [] : [v]; });

  if (input.style === 'histogram') {
    const bins = histogram(values(input.table.rows.map((_, i) => i), x.index));
    return {
      option: {
        tooltip: tooltip('axis'), grid: plotGrid(8),
        dataset: { dimensions: ['bin', 'count'], source: bins.map((bin) => [`${bin.from.toLocaleString()}–${bin.to.toLocaleString()}`, bin.count]) },
        xAxis: { type: 'category', name: x.label, nameLocation: 'middle', nameGap: 28, axisLabel: { hideOverlap: true } }, yAxis: { type: 'value', minInterval: 1 },
        series: [{ type: 'bar', encode: { x: 'bin', y: 'count' }, barCategoryGap: '2%' }],
      },
      points: bins.length,
    };
  }

  if (input.style === 'boxplot') {
    const samples = groups.map((group) => values(group.rows, x.index));
    const names = groups.map((group) => (named ? labelOf(group.key) : x.label));
    return {
      option: {
        tooltip: tooltip('item'), grid: plotGrid(8),
        dataset: [
          { source: samples },
          { fromDatasetIndex: 0, transform: { type: 'boxplot', config: { itemNameFormatter: (params: { value: number }) => names[params.value] ?? '' } } },
          { fromDatasetIndex: 1, fromTransformResult: 1 },
        ],
        xAxis: { type: 'category', axisLabel: { hideOverlap: true } }, yAxis: { type: 'value', name: x.label },
        series: [{ type: 'boxplot', datasetIndex: 1 }, { type: 'scatter', datasetIndex: 2, symbolSize: 6 }],
      },
      points: samples.reduce((sum, list) => sum + list.length, 0),
    };
  }

  if (input.style === 'parallel') {
    const axes = [x, needed(input, 'y'), ...boundAll(input, 'dims')];
    return {
      option: {
        tooltip: tooltip('item'), legend: legend(named),
        parallel: { left: 24, right: 32, top: 24, bottom: named ? 40 : 16 },
        parallelAxis: axes.map((axis, dim) => ({ dim, name: axis.label, nameTextStyle: { color: input.palette.muted } })),
        series: groups.map((group) => ({
          type: 'parallel' as const, name: labelOf(group.key), lineStyle: { width: 1, opacity: 0.5 },
          data: group.rows.map((at) => axes.map((axis) => numberOf(input.table.rows[at]?.[axis.index]) ?? 0)),
        })),
      },
      rowOf: (click) => (click.dataIndex === undefined ? undefined : groups[click.seriesIndex ?? 0]?.rows[click.dataIndex]),
      points: input.table.rows.length,
    };
  }

  const y = needed(input, 'y');
  const size = input.style === 'bubble' ? bound(input, 'size') : undefined;
  const low = typeof size?.facts?.min === 'number' ? size.facts.min : 0;
  const high = typeof size?.facts?.max === 'number' ? size.facts.max : 1;
  const symbolSize = (value: readonly (number | null)[]): number => {
    const v = value[2] ?? low;
    return high === low ? (BUBBLE.min + BUBBLE.max) / 2 : BUBBLE.min + ((v - low) / (high - low)) * (BUBBLE.max - BUBBLE.min);
  };
  const series = groups.map((group, g): ScatterSeriesOption | EffectScatterSeriesOption => {
    const common = {
      name: named ? labelOf(group.key) : y.label, datasetIndex: g, encode: { x: 'x', y: 'y', tooltip: size === undefined ? ['x', 'y'] : ['x', 'y', 'size'] },
      ...(size === undefined ? { symbolSize: 8 } : { symbolSize }), itemStyle: { opacity: size === undefined ? 0.85 : 0.6 },
    };
    return input.style === 'pulse' ? { ...common, type: 'effectScatter', rippleEffect: { scale: 2.5 } } : { ...common, type: 'scatter' };
  });
  return {
    option: {
      tooltip: tooltip('item'), legend: legend(named), grid: plotGrid(named ? 36 : 8),
      dataset: groups.map((group) => ({
        dimensions: size === undefined ? ['x', 'y'] : ['x', 'y', 'size'],
        source: group.rows.map((at) => { const row = input.table.rows[at] ?? []; return [numberOf(row[x.index]), numberOf(row[y.index]), ...(size === undefined ? [] : [numberOf(row[size.index])])]; }),
      })),
      xAxis: { type: 'value', name: x.label, nameLocation: 'middle', nameGap: 28, scale: true }, yAxis: { type: 'value', name: y.label, scale: true },
      series,
    },
    rowOf: (click) => (click.dataIndex === undefined ? undefined : groups[click.seriesIndex ?? 0]?.rows[click.dataIndex]),
    points: input.table.rows.length,
  };
};
