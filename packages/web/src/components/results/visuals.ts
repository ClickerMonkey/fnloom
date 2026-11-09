/**
 * The query visual registry on the web side: every visual that can draw a result table, each with match logic that
 * says whether it fits the table and how much of it it shows well (`VisualFit`). The app has its own (the table,
 * which always fits with the lowest score; a bar chart; a single value), and systems contribute more from their
 * client bundles (`Manifest.contributes`), which replace a built-in one of the same name. The result view shows the
 * best fit first and lets the person switch between all that fit.
 */
import { TABLE_VISUAL_SCORE, type ColumnKind, type ResultTable, type VisualFit } from '@harness/core';
import type { Component } from 'vue';
import { ICONS, type IconName } from '../../ui/icons.ts';
import type { ResultPager } from './table.ts';

/** The local name of the query visual registry a system hosts (`database/query-visuals`). */
export const QUERY_VISUALS = 'query-visuals';

/** The props every visual is drawn with. */
export interface VisualProps {
  readonly table: ResultTable;
  readonly title: string;
  /** Ask the table's fn for other rows; absent when the table can't be asked again. */
  readonly pager?: ResultPager | undefined;
}

/** A visual: its name and how the switcher shows it, its match logic and its component. */
export interface Visual {
  readonly name: string;
  readonly label: string;
  readonly icon: IconName;
  /** The system that contributed it; absent for the app's own. */
  readonly system?: string | undefined;
  match(table: ResultTable): VisualFit;
  readonly component: Component;
  /** Props a contributed component is drawn with besides `VisualProps` (its system's client). */
  readonly props?: object | undefined;
}

/** A visual that fits a table, with how well. */
export interface FittingVisual {
  readonly visual: Visual;
  readonly fit: VisualFit;
}

/** The table's name: the default visual, always there. */
export const TABLE_VISUAL = 'table';

/** The table fits every result, with the lowest score. */
export function tableFit(): VisualFit {
  return { fits: true, score: TABLE_VISUAL_SCORE };
}

const LABEL_KINDS: ReadonlySet<ColumnKind> = new Set(['text', 'date', 'datetime', 'time', 'uuid', 'boolean']);
const NUMBER_KINDS: ReadonlySet<ColumnKind> = new Set(['integer', 'number']);
/** The most bars a chart draws before a table reads better. */
export const MAX_BARS = 50;

/**
 * A bar chart fits one label column plus one number column, 2 to `MAX_BARS` rows, every value a number at or above 0.
 * It shows such data best (0.8), less so when the rows are only part of the result (0.5).
 */
export function barFit(table: ResultTable): VisualFit {
  const [first, second] = table.columns;
  const no: VisualFit = { fits: false, score: 0 };
  if (table.columns.length !== 2 || first === undefined || second === undefined) { return no; }
  if (!LABEL_KINDS.has(first.kind) || !NUMBER_KINDS.has(second.kind)) { return no; }
  if (table.rows.length < 2 || table.rows.length > MAX_BARS) { return no; }
  if (!table.rows.every((row) => typeof row[1] === 'number' && Number.isFinite(row[1]) && row[1] >= 0)) { return no; }
  return { fits: true, score: table.truncated || table.offset > 0 ? 0.5 : 0.8 };
}

/** A single value fits one row of one column, and shows it best of all (0.9). */
export function valueFit(table: ResultTable): VisualFit {
  return table.columns.length === 1 && table.rows.length === 1 && table.offset === 0 && !table.truncated ? { fits: true, score: 0.9 } : { fits: false, score: 0 };
}

/**
 * The visuals that fit a table, best first and the table last. A contributed visual replaces the app's own of the same
 * name; one whose match logic throws or answers out of range is left out (and logged), never the table.
 */
export function fittingVisuals(own: readonly Visual[], contributed: readonly Visual[], table: ResultTable): FittingVisual[] {
  const byName = new Map<string, Visual>();
  for (const visual of [...own, ...contributed]) { byName.set(visual.name, visual); }
  const fitting: FittingVisual[] = [];
  for (const visual of byName.values()) {
    const fit = safeFit(visual, table);
    if (fit?.fits === true) { fitting.push({ visual, fit }); }
  }
  if (!fitting.some((f) => f.visual.name === TABLE_VISUAL)) {
    const table = own.find((v) => v.name === TABLE_VISUAL);
    if (table !== undefined) { fitting.push({ visual: table, fit: tableFit() }); }
  }
  const rank = (f: FittingVisual): number => (f.visual.name === TABLE_VISUAL ? -1 : f.fit.score);
  return fitting.sort((a, b) => rank(b) - rank(a));
}

function safeFit(visual: Visual, table: ResultTable): VisualFit | undefined {
  try {
    const fit = visual.match(table);
    return fit.score >= 0 && fit.score <= 1 ? fit : undefined;
  } catch (error) {
    console.error('results.visual.match-failed', { visual: visual.name, system: visual.system, error });
    return undefined;
  }
}

/** Whether a contribution's icon is one the app can draw. */
export function isIconName(name: string | undefined): name is IconName {
  return name !== undefined && Object.hasOwn(ICONS, name);
}
