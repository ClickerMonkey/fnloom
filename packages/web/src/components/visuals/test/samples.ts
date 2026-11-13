/**
 * Sample results for the chart families, one per family, each drawable in every style it has: shared by the component
 * tests and the mock hub's chart gallery chat (the browser check renders them). Plain values only.
 */
import type { ResultColumn, ResultTable } from '@harness/core';
import type { ChartFamily } from '../families/index.ts';

const col = (name: string, kind: ResultColumn['kind']): ResultColumn => ({ name, kind, nullable: true });
const tableOf = (columns: ResultColumn[], rows: ResultTable['rows']): ResultTable => ({ columns, rows, offset: 0, truncated: false, sort: [] });

/** A whole result each chart family can draw, so every style of it is offered. */
export const CHART_SAMPLES: Readonly<Record<ChartFamily, ResultTable>> = {
  part: tableOf([col('city', 'text'), col('orders', 'integer')], [['Oslo', 12], ['Lima', 3], ['Rome', 7]]),
  category: tableOf([col('city', 'text'), col('orders', 'integer'), col('returns', 'integer')], [['Oslo', 12, 1], ['Lima', 3, 0], ['Rome', 7, 2]]),
  time: tableOf([col('day', 'date'), col('sales', 'integer'), col('shop', 'text')], [['2026-01-01', 4, 'a'], ['2026-01-02', 6, 'a'], ['2026-01-01', 2, 'b'], ['2026-01-03', 5, 'b']]),
  distribution: tableOf([col('w', 'number'), col('h', 'number'), col('age', 'number'), col('score', 'number'), col('team', 'text')], [[1, 2, 30, 5, 'a'], [2, 3, 40, 6, 'a'], [3, 1, 20, 7, 'b'], [4, 5, 50, 8, 'b']]),
  crosstab: tableOf([col('month', 'text'), col('shop', 'text'), col('sales', 'integer')], [['Jan', 'a', 4], ['Feb', 'a', 6], ['Jan', 'b', 2], ['Feb', 'b', 5]]),
  calendar: tableOf([col('day', 'date'), col('steps', 'integer')], [['2026-01-03', 4000], ['2026-02-10', 8000]]),
  timeline: tableOf([col('start', 'date'), col('end', 'date'), col('task', 'text')], [['2026-01-01', '2026-01-05', 'Plan'], ['2026-01-04', '2026-01-09', 'Build']]),
  network: tableOf([col('from', 'text'), col('to', 'text'), col('calls', 'integer')], [['web', 'hub', 9], ['hub', 'db', 4], ['cli', 'hub', 2]]),
  hierarchy: tableOf([col('name', 'text'), col('parent', 'text'), col('size', 'integer')], [['All', null, 0], ['Docs', 'All', 3], ['Code', 'All', 5], ['Tests', 'Code', 2]]),
  gauge: tableOf([col('done', 'number'), col('goal', 'number')], [[42, 80]]),
  finance: tableOf([col('day', 'date'), col('open', 'number'), col('close', 'number'), col('low', 'number'), col('high', 'number'), col('volume', 'integer')], [['2026-01-01', 10, 12, 9, 13, 300], ['2026-01-02', 12, 11, 10, 14, 250]]),
};

