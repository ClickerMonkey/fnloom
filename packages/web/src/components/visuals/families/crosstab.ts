/**
 * A measure for each pair of two keys: a heatmap (`heatmap` on a grid), value cells (`heatmap` on the `matrix`
 * coordinate, each cell labelled) and small charts (a bar chart per row key, each a grid in a `matrix` cell with its own category labels).
 */
import type { BarSeriesOption } from 'echarts/charts';
import type { XAXisComponentOption, YAXisComponentOption } from 'echarts';
import type { GridComponentOption } from 'echarts/components';
import type { ChartOption } from '../echarts-setup.ts';
import { chartValue, distinctValues, labelOf, needed, numberOf, tooltip, type ChartBuilder, type ChartInput } from '../chart-data.ts';

/** The most small charts drawn; past it the first ones are drawn. */
export const MULTIPLES_MAX = 24;

/** The shading scale: from the surface to the accent, at the bottom where it never covers a cell. */
function shading(input: ChartInput, values: readonly number[]): NonNullable<ChartOption['visualMap']> {
  const min = values.length === 0 ? 0 : Math.min(...values);
  const max = values.length === 0 ? 1 : Math.max(...values);
  return {
    type: 'continuous', min, max: max === min ? min + 1 : max, calculable: !input.phone, orient: 'horizontal', left: 'center', bottom: 0,
    itemHeight: input.phone ? 120 : 180, itemWidth: 10, inRange: { color: [input.palette.grid, input.palette.series[0] ?? input.palette.text] },
  };
}

export const crosstab: ChartBuilder = (input) => {
  const x = needed(input, 'x'); const y = needed(input, 'y'); const value = needed(input, 'value');
  const xs = distinctValues(input.table, x.index).map(labelOf);
  const ys = distinctValues(input.table, y.index).map(labelOf);
  const cells = input.table.rows.map((row) => [labelOf(chartValue(row[x.index])), labelOf(chartValue(row[y.index])), numberOf(row[value.index])] as const);
  const numbers = cells.flatMap((cell) => (cell[2] === null ? [] : [cell[2]]));
  const rowOf = (click: { readonly dataIndex?: number | undefined }): number | undefined => click.dataIndex;

  if (input.style === 'multiples') {
    const shown = ys.slice(0, MULTIPLES_MAX);
    const columns = Math.min(shown.length, input.phone ? 2 : Math.ceil(Math.sqrt(shown.length)));
    const lines = Math.ceil(shown.length / columns);
    const grids: GridComponentOption[] = []; const xAxes: XAXisComponentOption[] = []; const yAxes: YAXisComponentOption[] = []; const series: BarSeriesOption[] = [];
    shown.forEach((name, i) => {
      grids.push({ coordinateSystem: 'matrix', coord: [i % columns, Math.floor(i / columns)], top: 22, bottom: 26, left: 30, right: 8 });
      xAxes.push({ type: 'category', gridIndex: i, data: xs, axisLabel: { hideOverlap: true, fontSize: input.phone ? 10 : 11, color: input.palette.muted }, axisTick: { show: false } });
      yAxes.push({ type: 'value', gridIndex: i, name, nameLocation: 'end', nameTextStyle: { align: 'left', color: input.palette.text }, splitNumber: 2 });
      series.push({ type: 'bar', xAxisIndex: i, yAxisIndex: i, data: xs.map((key) => cells.find((cell) => cell[0] === key && cell[1] === name)?.[2] ?? null) });
    });
    return {
      option: {
        tooltip: tooltip('axis'),
        matrix: { x: { show: false, data: Array.from({ length: columns }, (_, i) => String(i)) }, y: { show: false, data: Array.from({ length: lines }, (_, i) => String(i)) }, left: 4, right: 4, top: 4, bottom: 4, backgroundStyle: { borderWidth: 0 }, body: { itemStyle: { borderWidth: 0 } } },
        grid: grids, xAxis: xAxes, yAxis: yAxes, series,
      },
      rowOf: (click) => {
        const name = shown[click.seriesIndex ?? -1]; const key = xs[click.dataIndex ?? -1];
        const at = cells.findIndex((cell) => cell[0] === key && cell[1] === name);
        return at < 0 ? undefined : at;
      },
      points: shown.length * xs.length,
    };
  }

  if (input.style === 'cells') {
    return {
      option: {
        tooltip: tooltip('item'), visualMap: shading(input, numbers),
        matrix: { x: { data: xs }, y: { data: ys }, left: 8, right: 8, top: 8, bottom: 44 },
        series: [{ type: 'heatmap', coordinateSystem: 'matrix', data: cells.map((cell) => [cell[0], cell[1], cell[2]]), label: { show: true, color: input.palette.text } }],
      },
      rowOf, points: cells.length,
    };
  }

  return {
    option: {
      tooltip: tooltip('item'), visualMap: shading(input, numbers),
      grid: { left: 8, right: 8, top: 16, bottom: 48, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
      xAxis: { type: 'category', data: xs, splitArea: { show: false }, axisLabel: { hideOverlap: true } }, yAxis: { type: 'category', data: ys, axisLabel: { hideOverlap: true } },
      series: [{ type: 'heatmap', data: cells.map((cell) => [cell[0], cell[1], cell[2]]), label: { show: !input.phone && xs.length * ys.length <= 120, color: input.palette.text }, itemStyle: { borderColor: input.palette.surface, borderWidth: 1 } }],
    },
    rowOf, points: cells.length,
  };
};
