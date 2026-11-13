/**
 * The hub's visual registry (`hub/visuals`, build 8) on the web side: every visual that can draw a result table, each with match logic that
 * says whether it fits the table and how much of it it shows well (`VisualFit`). The app has its own (the table,
 * which always fits with the lowest score; a bar chart; a single value), and systems contribute more from their
 * client bundles (`Manifest.contributes`), which replace a built-in one of the same name. The result view shows the
 * best fit first and lets the person switch between all that fit.
 */
import { tableFit, type Json, type ResultTable, type VisualFit } from '@harness/core';
import type { Component } from 'vue';
import { ICONS, type IconName } from '../../ui/icons.ts';
import type { ResultPager } from './table.ts';

/** The props every visual is drawn with. */
export interface VisualProps {
  readonly table: ResultTable;
  readonly title: string;
  /** Ask the table's fn for other rows; absent when the table can't be asked again. */
  readonly pager?: ResultPager | undefined;
  /** Open what a row offers (a widget's row actions, a record); visuals that draw rows show a button per row. */
  readonly opener?: RowOpener | undefined;
}

/** A button on each row that opens what it offers. */
export interface RowOpener {
  /** The button's label ("Actions", "Open"). */
  readonly label: string;
  /** Whether a row offers anything; rows that don't get no button. */
  has(row: readonly Json[]): boolean;
  open(row: readonly Json[]): void;
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

export { barFit, tableFit, valueFit } from '@harness/core';

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
