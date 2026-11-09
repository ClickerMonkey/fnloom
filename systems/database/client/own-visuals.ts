/**
 * This system's own query visuals, each its match logic and its component: the table (always fits, scoring lowest),
 * a bar chart and a single value. The client module registers them and the result view falls back on them.
 */
// typescript-eslint can't see the types of .vue modules from .ts files (as for systems/fs/client/index.ts); vue-tsc
// checks this file, so each component's props are still checked against the visual view
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import type { VisualEntry } from '@harness/sdk';
import type { DatabaseContract } from '../shared/index.ts';
import { barFit, tableFit, valueFit } from '../shared/visuals.ts';
import BarVisual from './BarVisual.vue';
import TableVisual from './TableVisual.vue';
import ValueVisual from './ValueVisual.vue';

/** This system's query visuals, by name (as the contract's `contributes` lists them). */
export const OWN_VISUALS = {
  table: { match: () => tableFit(), component: TableVisual },
  bar: { match: barFit, component: BarVisual },
  value: { match: valueFit, component: ValueVisual },
} satisfies Readonly<Record<string, VisualEntry<DatabaseContract['defs']>>>;
