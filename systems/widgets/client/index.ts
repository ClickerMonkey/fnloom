/**
 * The widgets system's client, typed by the contract: a `make_widget` proposal is drawn as its card with Save, and a
 * saved widget's result (any fn of the `widget` kind) with the app's result view, keeping a look picked in its Settings
 * (both through the result-renderer slot, so the chat draws them under its own run line); and the saved widgets' page
 * (`/s/widgets/saved`). The chat loads this module from the hub.
 */
// typescript-eslint can't see the types of .vue modules from .ts files (as for packages/web/src/main.ts); vue-tsc
// checks this file, so the renderers' props are still checked against the contract
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { client } from '@harness/sdk';
import { widgets } from '../shared/index.ts';
import ProposalCard from './ProposalCard.vue';
import SavedWidget from './SavedWidget.vue';
import WidgetsPage from './WidgetsPage.vue';

export default client(widgets, {
  results: { fns: { make_widget: ProposalCard }, kinds: { widget: SavedWidget } },
  pages: { WidgetsPage },
});
