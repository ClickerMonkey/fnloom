/**
 * Measures per category: bars, stacked, 100% stacked, horizontal (`bar`), line and area (`line`), radar (`radar`),
 * polar bars (`bar` on `polar`) and pictorial bars (`pictorialBar`). Many categories zoom (pinch on a phone).
 */
import type { BarSeriesOption, LineSeriesOption, PictorialBarSeriesOption } from 'echarts/charts';
import { legend, plotGrid, tooltip, zoom, type ChartBuilder, type ChartClick } from '../chart-data.ts';
import { asPercent, wide } from './wide.ts';

/** Past this many categories the axis zooms instead of squeezing every label in. */
export const CATEGORY_ZOOM_AFTER = 20;

export const category: ChartBuilder = (input) => {
  const data = wide(input, 'x');
  const percent = input.style === 'percent';
  const source = percent ? asPercent(data.source) : data.source;
  const dims = ['key', ...data.names.map((_, i) => `s${String(i)}`)];
  const many = data.names.length > 1;
  const rowOf = (click: ChartClick): number | undefined => (click.dataIndex === undefined ? undefined : data.rowAt(click.dataIndex, click.seriesIndex ?? 0));
  const points = source.length * data.names.length;

  if (input.style === 'radar') {
    const max = Math.max(0, ...source.flatMap((row) => row.slice(1).map((value) => (typeof value === 'number' ? value : 0))));
    return {
      option: {
        tooltip: tooltip('item'), legend: legend(many),
        radar: { indicator: source.map((row) => ({ name: String(row[0] ?? ''), max: max === 0 ? 1 : max })), radius: input.phone ? '58%' : '66%', center: ['50%', '48%'] },
        series: [{ type: 'radar', data: data.names.map((name, s) => ({ name, value: source.map((row) => (typeof row[s + 1] === 'number' ? Number(row[s + 1]) : 0)) })), areaStyle: { opacity: 0.12 } }],
      },
      points,
    };
  }

  const dataset = { dimensions: dims, source };
  if (input.style === 'polar') {
    return {
      option: {
        dataset, tooltip: tooltip('item'), legend: legend(many), polar: { radius: ['12%', '72%'] },
        angleAxis: { type: 'category' }, radiusAxis: { type: 'value' },
        series: data.names.map((name, s) => ({ type: 'bar' as const, name, coordinateSystem: 'polar' as const, stack: 'total', encode: { angle: 'key', radius: dims[s + 1] ?? 's0' } })),
      },
      rowOf, points,
    };
  }

  const horizontal = input.style === 'horizontal';
  const stacked = input.style === 'stacked' || percent;
  const series = data.names.map((name, s): BarSeriesOption | LineSeriesOption | PictorialBarSeriesOption => {
    const value = dims[s + 1] ?? 's0';
    const encode = horizontal ? { y: 'key', x: value } : { x: 'key', y: value };
    if (input.style === 'line' || input.style === 'area') {
      return { type: 'line', name, encode, showSymbol: source.length <= 30, ...(input.style === 'area' ? { areaStyle: { opacity: 0.16 } } : {}) };
    }
    if (input.style === 'pictorial') {
      // a pictorial bar overlaps the one before it by default (barGap -100%): each series takes its own slot instead
      return { type: 'pictorialBar', name, encode, symbol: 'roundRect', symbolRepeat: true, symbolSize: ['80%', 6], symbolMargin: 2, barGap: '12%', barCategoryGap: many ? '28%' : '40%' };
    }
    return { type: 'bar', name, encode, ...(stacked ? { stack: 'total' } : {}), barMaxWidth: 36, itemStyle: { borderRadius: stacked ? 0 : 3 } };
  });
  const zoomed = source.length > CATEGORY_ZOOM_AFTER;
  const legendRoom = many ? 28 : 0;
  const categoryAxis = { type: 'category' as const, axisLabel: { hideOverlap: true, ...(horizontal ? {} : { rotate: input.phone && source.length > 6 ? 30 : 0 }) } };
  const valueAxis = { type: 'value' as const, ...(percent ? { max: 100, axisLabel: { formatter: '{value}%' } } : {}) };
  return {
    option: {
      dataset, tooltip: tooltip('axis'), legend: legend(many), grid: plotGrid(legendRoom + (zoomed && !input.phone && !horizontal ? 36 : 8)),
      xAxis: horizontal ? valueAxis : categoryAxis, yAxis: horizontal ? { ...categoryAxis, inverse: true } : valueAxis,
      ...(zoomed ? { dataZoom: zoom(input.phone, horizontal ? { yAxisIndex: [0] } : { xAxisIndex: [0] }) } : {}),
      series,
    },
    rowOf, points,
  };
};
