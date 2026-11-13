/**
 * One value against its known range (`gauge`): a dial, or a progress ring. The range is the column's declared bound,
 * or 0 to the bound maximum column.
 */
import { bound, needed, numberOf, type ChartBuilder } from '../chart-data.ts';

export const gauge: ChartBuilder = (input) => {
  const value = needed(input, 'value'); const maximum = bound(input, 'max');
  const row = input.table.rows[0] ?? [];
  const shown = numberOf(row[value.index]) ?? 0;
  const min = value.facts?.bound?.min ?? 0;
  const max = (maximum === undefined ? undefined : numberOf(row[maximum.index])) ?? value.facts?.bound?.max ?? Math.max(1, shown);
  const progress = input.style === 'progress';
  const accent = input.palette.series[0] ?? input.palette.text;
  return {
    option: {
      series: [{
        type: 'gauge', min, max: max === min ? min + 1 : max, data: [{ value: shown, name: value.label }],
        radius: '88%', center: ['50%', progress ? '50%' : '58%'],
        ...(progress
          ? { startAngle: 90, endAngle: -270, pointer: { show: false }, progress: { show: true, roundCap: true, width: 14, itemStyle: { color: accent } }, axisLine: { lineStyle: { width: 14, color: [[1, input.palette.grid]] } }, splitLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false }, title: { offsetCenter: [0, '28%'], color: input.palette.muted }, detail: { offsetCenter: [0, '-4%'], fontSize: 26, color: input.palette.text, valueAnimation: true } }
          : { progress: { show: true, width: 10, itemStyle: { color: accent } }, axisLine: { lineStyle: { width: 10, color: [[1, input.palette.grid]] } }, pointer: { itemStyle: { color: input.palette.muted } }, splitLine: { length: 8, lineStyle: { color: input.palette.grid } }, axisTick: { show: false }, axisLabel: { show: !input.phone, color: input.palette.muted, distance: 16 }, title: { offsetCenter: [0, '72%'], color: input.palette.muted }, detail: { offsetCenter: [0, '42%'], fontSize: 22, color: input.palette.text, valueAnimation: true } }),
      }],
    },
    rowOf: () => 0, points: 1, height: 240,
  };
};
