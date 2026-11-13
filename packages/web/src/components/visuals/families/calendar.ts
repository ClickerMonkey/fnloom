/**
 * Days on a calendar: a month or a year (`calendar` coordinate), shaded by a measure (`heatmap`) or marked
 * (`scatter`) when there is none. It shows one period at a time, the latest first; moving to another sets the
 * widget's from/to args to that period.
 */
import { bound, chartValue, labelOf, needed, numberOf, tooltip, type ChartBuilder, type ChartPeriod } from '../chart-data.ts';

/** A value's calendar day, `YYYY-MM-DD`, or `undefined` when it is not a date. */
export function dayOf(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') { return undefined; }
  const ms = typeof value === 'number' ? value : Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString().slice(0, 10);
}

/** The period `shift` steps back from the latest day: a month (`YYYY-MM`) or a year. */
export function periodOf(latest: string, year: boolean, shift: number): { readonly range: string; readonly from: string; readonly to: string; readonly label: string } {
  const y = Number(latest.slice(0, 4)); const m = Number(latest.slice(5, 7)) - 1;
  if (year) {
    const shown = y - shift;
    return { range: String(shown), from: `${String(shown)}-01-01`, to: `${String(shown)}-12-31`, label: String(shown) };
  }
  const first = new Date(Date.UTC(y, m - shift, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const from = first.toISOString().slice(0, 10);
  return { range: from.slice(0, 7), from, to: last.toISOString().slice(0, 10), label: first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
}

export const calendar: ChartBuilder = (input) => {
  const time = needed(input, 'time');
  const value = bound(input, 'value');
  const label = bound(input, 'label');
  const days = input.table.rows.map((row) => dayOf(row[time.index]));
  const known = days.filter((day): day is string => day !== undefined).sort();
  const latest = known.at(-1) ?? new Date().toISOString().slice(0, 10);
  const year = input.style === 'year';
  const shown = periodOf(latest, year, input.shift);
  const rows = days.flatMap((day, at) => (day !== undefined && day >= shown.from && day <= shown.to ? [at] : []));
  const period: ChartPeriod = { label: shown.label, from: shown.from, to: shown.to, before: (known[0] ?? latest) < shown.from, after: latest > shown.to };
  const data = rows.map((at) => {
    const row = input.table.rows[at] ?? [];
    return [days[at] ?? '', value === undefined ? 1 : numberOf(row[value.index]), label === undefined ? '' : labelOf(chartValue(row[label.index]))];
  });
  const numbers = data.flatMap((d) => (typeof d[1] === 'number' ? [d[1]] : []));
  const cellHeight: number | 'auto' = year ? (input.phone ? 9 : 14) : 'auto';
  const cellSize: (number | 'auto')[] = ['auto', cellHeight];
  const calendarBox = {
    range: shown.range, top: year ? 28 : 36, left: input.phone ? 8 : 32, right: 8, bottom: value === undefined ? 8 : 44, cellSize,
    orient: 'horizontal' as const, splitLine: { show: false }, yearLabel: { show: false }, dayLabel: { firstDay: 1, nameMap: input.phone ? 'EN' : 'en' },
  };
  return {
    option: {
      useUTC: true,
      tooltip: tooltip('item'),
      calendar: calendarBox,
      ...(value === undefined ? {} : {
        visualMap: {
          type: 'continuous', min: numbers.length === 0 ? 0 : Math.min(...numbers), max: numbers.length === 0 ? 1 : Math.max(1, ...numbers), orient: 'horizontal', left: 'center', bottom: 0,
          itemHeight: 140, itemWidth: 10, inRange: { color: [input.palette.grid, input.palette.series[0] ?? input.palette.text] },
        },
      }),
      series: value === undefined
        ? [{ type: 'scatter', coordinateSystem: 'calendar', data, symbolSize: year ? 6 : 12 }]
        : [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
    },
    rowOf: (click) => (click.dataIndex === undefined ? undefined : rows[click.dataIndex]),
    period, points: data.length, height: year ? (input.phone ? 150 : 200) : 300,
  };
};
