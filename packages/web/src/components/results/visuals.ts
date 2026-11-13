/**
 * The hub's visual registry (`hub/visuals`) on the web side: every visual that can draw a result table, each declaring
 * the data it draws (`VisualShape`). The app has its own (the table, value cards and the twelve ECharts families), and
 * systems contribute more from their client bundles, which replace a built-in one of the same name. Which fit and in
 * what order is product's ranking (`rankVisuals`: coverage, then priority, then registry order); visuals that can't
 * draw the data are hidden, and a visual's own `veto` may only remove itself, never reorder.
 */
import { rankVisuals, type Json, type ResultFacts, type ResultTable, type VisualBinding, type VisualRank, type VisualShape } from '@harness/core';
import type { Component } from 'vue';
import { ICONS, type IconName } from '../../ui/icons.ts';
import type { ChartPalette } from '../visuals/palette.ts';
import type { ResultPager } from './table.ts';

/** The props every visual is drawn with (the app's own; a contributed one gets the sdk's `VisualView` part of them). */
export interface VisualProps {
  readonly table: ResultTable;
  readonly title: string;
  /** What each column is, over the rows held. */
  readonly facts: ResultFacts;
  /** Channel → columns. */
  readonly bind: VisualBinding;
  /** The style picked, one of the visual's that fit. */
  readonly style: string;
  readonly palette: ChartPalette;
  /** Ask the table's fn for other rows; absent when the table can't be asked again. */
  readonly pager?: ResultPager | undefined;
  /** Open what a row offers (a widget's row actions, a record); visuals that draw rows show a button per row. */
  readonly opener?: RowOpener | undefined;
}

/** A from/to a visual sets, and what every visual emits (`drill` a row, `range` shown): the sdk's, so a system's chart and the app's own emit alike. */
export type { VisualEmits, VisualRange } from '@harness/sdk';

/** A button on each row that opens what it offers. */
export interface RowOpener {
  /** The button's label ("Actions", "Open"). */
  readonly label: string;
  /** Whether a row offers anything; rows that don't get no button. */
  has(row: readonly Json[]): boolean;
  open(row: readonly Json[]): void;
}

/** A visual: its name and how the switcher shows it, the data it draws, and its component. */
export interface Visual {
  readonly name: string;
  readonly label: string;
  readonly icon: IconName;
  /** The system that contributed it; absent for the app's own. */
  readonly system?: string | undefined;
  readonly shape: VisualShape;
  readonly component: Component;
  /** Props a component is drawn with besides `VisualProps` (a chart's family, a system's client). */
  readonly props?: object | undefined;
  /** Why this result is not one it draws after all, beyond its shape; it may only remove itself. */
  veto?(table: ResultTable, facts: ResultFacts): string | undefined;
}

/** A visual that can draw a result, with its rank (default binding, styles that fit, why). */
export interface RankedVisual {
  readonly visual: Visual;
  readonly rank: VisualRank;
}

/** The visual and style a person picked for a view. */
export interface VisualChoice {
  readonly visual: string;
  readonly style?: string | undefined;
}

/** The table's name: the floor visual, there for every result. */
export const TABLE_VISUAL = 'table';

/**
 * The visuals that can draw a result, best first (product's order). A contributed visual replaces the app's own of the
 * same name and keeps its place in registry order; a veto that throws counts as a veto (and is logged).
 */
export function rankedVisuals(own: readonly Visual[], contributed: readonly Visual[], table: ResultTable, facts: ResultFacts): RankedVisual[] {
  const byName = new Map<string, Visual>();
  for (const visual of [...own, ...contributed]) { byName.set(visual.name, visual); }
  const entries = [...byName.values()].map((visual) => ({ name: visual.name, shape: visual.shape }));
  return rankVisuals(entries, facts, table).flatMap((rank) => {
    const visual = byName.get(rank.visual);
    if (visual === undefined || vetoed(visual, table, facts)) { return []; }
    return [{ visual, rank }];
  });
}

function vetoed(visual: Visual, table: ResultTable, facts: ResultFacts): boolean {
  if (visual.veto === undefined) { return false; }
  try {
    return visual.veto(table, facts) !== undefined;
  } catch (error) {
    console.error('results.visual.veto-failed', { visual: visual.name, system: visual.system, error });
    return true;
  }
}

/** The ranked visual a choice names (else the best), and the style to draw (the choice's when it fits, else the default). */
export function chosenVisual(visuals: readonly RankedVisual[], choice: VisualChoice | undefined): { readonly ranked: RankedVisual; readonly style: string } | undefined {
  const ranked = visuals.find((v) => v.visual.name === choice?.visual) ?? visuals[0];
  if (ranked === undefined) { return undefined; }
  const style = ranked.visual.name === choice?.visual && choice.style !== undefined && ranked.rank.styles.includes(choice.style) ? choice.style : ranked.rank.styles[0];
  return { ranked, style: style ?? '' };
}

/** A style's label in a visual's shape. */
export function styleLabel(shape: VisualShape, style: string): string {
  return shape.styles.find((s) => s.name === style)?.label ?? style;
}

/** Whether a contribution's icon is one the app can draw. */
export function isIconName(name: string | undefined): name is IconName {
  return name !== undefined && Object.hasOwn(ICONS, name);
}
