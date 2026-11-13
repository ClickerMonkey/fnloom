/** Every built-in chart family's option builder, by family (the table and value cards are DOM, not ECharts). */
import type { VisualFamily } from '@harness/core';
import type { ChartBuilder } from '../chart-data.ts';
import { calendar } from './calendar.ts';
import { category } from './category.ts';
import { crosstab } from './crosstab.ts';
import { distribution } from './distribution.ts';
import { finance } from './finance.ts';
import { gauge } from './gauge.ts';
import { hierarchy } from './hierarchy.ts';
import { network } from './network.ts';
import { part } from './part.ts';
import { time } from './time.ts';
import { timeline } from './timeline.ts';

/** A family ECharts draws. */
export type ChartFamily = Exclude<VisualFamily, 'table' | 'value'>;

export const CHART_BUILDERS: Readonly<Record<ChartFamily, ChartBuilder>> = {
  part, category, time, distribution, crosstab, calendar, timeline, network, hierarchy, gauge, finance,
};

/** Whether a family is one ECharts draws. */
export function isChartFamily(name: string): name is ChartFamily {
  return Object.hasOwn(CHART_BUILDERS, name);
}
