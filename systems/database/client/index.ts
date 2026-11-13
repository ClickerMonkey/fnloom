/**
 * The database system's client: the `result` attachment's view (the best fitting visual and a switch between the
 * ones that fit), and its contributions to the hub's `hub/visuals` registry: the table, a bar chart and a single value.
 * Other systems add visuals to the same registry from their own bundles.
 */
// typescript-eslint can't see the types of .vue modules from .ts files (as for systems/fs/client/index.ts); vue-tsc
// checks this file, so the renderers' props are still checked against the contract
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { client } from '@harness/sdk';
import { VISUALS_REGISTRY, database } from '../shared/index.ts';
import { OWN_VISUALS } from './own-visuals.ts';
import ResultView from './ResultView.vue';

export default client(database, {
  attachments: { result: ResultView },
  visuals: { [VISUALS_REGISTRY]: OWN_VISUALS },
});
