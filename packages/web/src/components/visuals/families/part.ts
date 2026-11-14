/**
 * Part of a whole: pie, doughnut, rose, half doughnut (`pie`) and funnel (`funnel`), one slice per row, the smallest
 * folded into "Other" past `PART_TO_WHOLE_MAX_SLICES` (the result is whole, or ranking would not offer it).
 */
import { chartValue, dimension, legend, needed, numberOf, tooltip, type ChartBuilder } from '../chart-data.ts';
import { foldSlices, type Slice } from '../maths.ts';

export const part: ChartBuilder = (input) => {
  const name = needed(input, 'itemName');
  const size = needed(input, 'value');
  const slices = foldSlices(input.table.rows.flatMap((row, at): Slice[] => {
    const value = numberOf(row[size.index]);
    return value === null ? [] : [{ name: chartValue(row[name.index]), value, row: at }];
  }));
  const source = slices.map((slice) => [slice.name, slice.value]);
  const encode = { itemName: name.name, value: size.name, tooltip: size.name };
  const label = { show: !input.phone, color: input.palette.text, formatter: '{b}: {d}%' };
  const common = { name: size.label, datasetIndex: 0, encode, label, labelLine: { show: !input.phone } };
  const series = input.style === 'funnel'
    ? [{ ...common, type: 'funnel' as const, sort: 'descending' as const, left: '10%', right: '10%', top: 16, bottom: 40, label: { ...label, show: true, position: 'inside' as const, formatter: '{b}' } }]
    : [{
      ...common, type: 'pie' as const, center: ['50%', input.style === 'half' ? '70%' : '46%'],
      radius: input.style === 'pie' || input.style === 'rose' ? ['0%', '68%'] : input.style === 'half' ? ['48%', '92%'] : ['42%', '68%'],
      ...(input.style === 'rose' ? { roseType: 'radius' as const } : {}),
      ...(input.style === 'half' ? { startAngle: 180, endAngle: 360 } : {}),
      itemStyle: { borderColor: input.palette.surface, borderWidth: 1 },
    }];
  return {
    option: { dataset: { dimensions: [dimension(name), dimension(size)], source }, tooltip: tooltip('item'), legend: legend(true), series },
    rowOf: (click) => (click.dataIndex === undefined ? undefined : slices[click.dataIndex]?.row),
    points: slices.length,
  };
};
