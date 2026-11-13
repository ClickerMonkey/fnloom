/**
 * The app's own visuals (core's `BUILT_IN_VISUALS`: the table, value cards and twelve ECharts families), and the host
 * the result views reach the registry through. A page that knows more (the chat, with systems' contributed visuals
 * and a choice kept per message) provides its own host; without one, a result view uses these visuals and keeps its
 * choice to itself. Components load when first drawn, so ECharts stays out of every bundle until a chart draws.
 */
import { BUILT_IN_VISUALS, VISUAL_FAMILIES, type QualifiedName, type ResultFacts, type ResultTable, type VisualFamily } from '@harness/core';
import { defineAsyncComponent, markRaw, type Component, type InjectionKey } from 'vue';
import type { IconName } from '../../ui/icons.ts';
import { rankedVisuals, type RankedVisual, type Visual, type VisualChoice } from './visuals.ts';

/**
 * A visual's component, loaded the first time it is drawn. The loading wrapper declares no props, so it would pass
 * them on as fallthrough attributes, and Vue merging those parses `style` (a visual's prop) as CSS; it hands its
 * props to the visual as they came instead.
 */
function later(loader: () => Promise<{ default: Component }>): Component {
  return markRaw(Object.assign(defineAsyncComponent(loader), { inheritAttrs: false }));
}

const TABLE = later(() => import('./ResultGrid.vue'));
const VALUE = later(() => import('../visuals/ValueVisual.vue'));
const CHART = later(() => import('../visuals/ChartVisual.vue'));

/** Each family's switcher icon (core's icons say what kind of thing it is; these tell the families apart). */
const FAMILY_ICONS: Readonly<Record<VisualFamily, IconName>> = {
  table: 'table', value: 'hash', part: 'pie', category: 'chart', time: 'line', distribution: 'scatter', crosstab: 'grid', calendar: 'calendar',
  timeline: 'timeline', network: 'graph', hierarchy: 'tree', gauge: 'gauge', finance: 'candles',
};

/** The table, value cards and the chart families, in registry order. */
export const OWN_VISUALS: readonly Visual[] = VISUAL_FAMILIES.map((family): Visual => {
  const entry = BUILT_IN_VISUALS[family];
  const component = family === 'table' ? TABLE : family === 'value' ? VALUE : CHART;
  const props = component === CHART ? { family } : component === TABLE && entry.shape.pageSize !== undefined ? { pageSize: entry.shape.pageSize } : undefined;
  return { name: family, label: entry.label, icon: FAMILY_ICONS[family], shape: entry.shape, component, ...(props === undefined ? {} : { props }) };
});

/** What a result view needs from the page it is on. */
export interface ResultsHost {
  /** The visuals of a registry that can draw a result, best first. */
  visuals(registry: QualifiedName, table: ResultTable, facts: ResultFacts): readonly RankedVisual[];
  /** Load what a registry's contributions need (their systems' client bundles), before it is drawn. */
  prepare(registry: QualifiedName): Promise<void>;
  /** The visual and style the person chose for a view (by its key), if they chose one. */
  choice(key: string): VisualChoice | undefined;
  choose(key: string, choice: VisualChoice): void;
}

/** The host of a page that provides none: the app's own visuals, no remembered choices. */
export const OWN_HOST: ResultsHost = {
  visuals: (_registry, table, facts) => rankedVisuals(OWN_VISUALS, [], table, facts),
  prepare: () => Promise.resolve(),
  choice: () => undefined,
  choose: () => undefined,
};

/** Where a page provides its results host. */
export const RESULTS_HOST: InjectionKey<ResultsHost> = Symbol('results-host');
