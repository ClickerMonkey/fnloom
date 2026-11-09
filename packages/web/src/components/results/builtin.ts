/**
 * The app's own query visuals, and the host the result views reach the registry through. A page that knows more (the
 * chat, with systems' contributed visuals and a choice kept per message) provides its own host; without one, a result
 * view uses these visuals and keeps its choice to itself. The visuals' components load when first drawn, so stores can
 * use the registry without pulling components in.
 */
import type { QualifiedName, ResultTable } from '@harness/core';
import { defineAsyncComponent, markRaw, type Component, type InjectionKey } from 'vue';
import { barFit, fittingVisuals, tableFit, TABLE_VISUAL, valueFit, type FittingVisual, type Visual } from './visuals.ts';

/** A visual's component, loaded the first time it is drawn. */
function later(loader: () => Promise<{ default: Component }>): Component {
  return markRaw(defineAsyncComponent(loader));
}

/** The table, a bar chart and a single value. */
export const OWN_VISUALS: readonly Visual[] = [
  { name: TABLE_VISUAL, label: 'Table', icon: 'table', match: tableFit, component: later(() => import('./ResultGrid.vue')) },
  { name: 'bar', label: 'Bar chart', icon: 'chart', match: barFit, component: later(() => import('./BarVisual.vue')) },
  { name: 'value', label: 'Value', icon: 'hash', match: valueFit, component: later(() => import('./ValueVisual.vue')) },
];

/** What a result view needs from the page it is on. */
export interface ResultsHost {
  /** The visuals of a registry that fit a table, best first and the table last. */
  visuals(registry: QualifiedName, table: ResultTable): readonly FittingVisual[];
  /** Load what a registry's contributions need (their systems' client bundles), before it is drawn. */
  prepare(registry: QualifiedName): Promise<void>;
  /** The visual the person chose for a view (by its key), if they chose one. */
  choice(key: string): string | undefined;
  choose(key: string, visual: string): void;
}

/** The host of a page that provides none: the app's own visuals, no remembered choices. */
export const OWN_HOST: ResultsHost = {
  visuals: (_registry, table) => fittingVisuals(OWN_VISUALS, [], table),
  prepare: () => Promise.resolve(),
  choice: () => undefined,
  choose: () => undefined,
};

/** Where a page provides its results host. */
export const RESULTS_HOST: InjectionKey<ResultsHost> = Symbol('results-host');
