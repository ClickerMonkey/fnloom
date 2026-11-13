/**
 * Open, high, low and close per period (`candlestick`), with volume bars in a second grid under it (`bar`); rises
 * and falls in the theme's ok and danger colours. The period axis zooms both grids; a zoom sets the widget's
 * from/to args.
 */
import { chartValue, needed, tooltip, type ChartBuilder } from '../chart-data.ts';

export const finance: ChartBuilder = (input) => {
  const x = needed(input, 'x');
  const columns = ['open', 'close', 'low', 'high'].map((channel) => needed(input, channel));
  const volume = input.style === 'volume' ? needed(input, 'volume') : undefined;
  const all = [x, ...columns, ...(volume === undefined ? [] : [volume])];
  const source = input.table.rows.map((row) => all.map((column) => chartValue(row[column.index])));
  const dims = all.map((column) => column.name);
  const periods = source.map((row) => row[0] ?? null);
  const axes = volume === undefined ? [0] : [0, 1];
  const zoomBottom = input.phone ? 0 : 28;
  return {
    option: {
      dataset: { dimensions: dims, source },
      tooltip: { ...tooltip('axis'), axisPointer: { type: 'cross' } },
      grid: volume === undefined
        ? [{ left: 8, right: 16, top: 16, bottom: zoomBottom + 12, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' }]
        : [{ left: 8, right: 16, top: 16, height: '56%', outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' }, { left: 8, right: 16, top: '72%', bottom: zoomBottom + 12, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' }],
      xAxis: axes.map((gridIndex) => ({ type: 'category' as const, gridIndex, boundaryGap: true, axisLabel: { show: gridIndex === axes.length - 1, hideOverlap: true } })),
      yAxis: axes.map((gridIndex) => ({ type: 'value' as const, gridIndex, scale: true, splitNumber: gridIndex === 0 ? 4 : 2 })),
      dataZoom: input.phone ? [{ type: 'inside', xAxisIndex: axes }] : [{ type: 'inside', xAxisIndex: axes }, { type: 'slider', xAxisIndex: axes, height: 18, bottom: 4 }],
      series: [
        { type: 'candlestick', name: x.label, encode: { x: x.name, y: columns.map((column) => column.name) }, itemStyle: { color: input.palette.up, color0: input.palette.down, borderColor: input.palette.up, borderColor0: input.palette.down } },
        ...(volume === undefined ? [] : [{ type: 'bar' as const, name: volume.label, xAxisIndex: 1, yAxisIndex: 1, encode: { x: x.name, y: volume.name }, itemStyle: { color: input.palette.muted, opacity: 0.5 } }]),
      ],
    },
    rowOf: (click) => click.dataIndex,
    range: { kind: 'category', values: periods, day: x.facts?.day === true },
    points: source.length,
    height: volume === undefined ? 300 : 360,
  };
};
