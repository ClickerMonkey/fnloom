/**
 * The web system's client renderers, typed by the contract: the search results card and the page card. The chat
 * loads this module from the hub and provides the runtime behind each renderer's `system`.
 */
// typescript-eslint can't see the types of .vue modules from .ts files (as for packages/web/src/main.ts); vue-tsc
// checks this file, so the renderers' props are still checked against the contract
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { client } from '@harness/sdk';
import { web } from '../shared/index.ts';
import ReadView from './ReadView.vue';
import SearchView from './SearchView.vue';

export default client(web, {
  fns: { search: SearchView, read: ReadView },
});
