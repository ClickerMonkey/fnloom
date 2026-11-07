/**
 * The fs system's client renderers, typed by the contract: the bash card, the diff attachment and the input for
 * `fs/Entry`. The chat loads this module from the hub and provides the runtime behind each renderer's `system`.
 */
// typescript-eslint can't see the types of .vue modules from .ts files (as for packages/web/src/main.ts); vue-tsc
// checks this file, so the renderers' props are still checked against the contract
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { client } from '@harness/sdk';
import { fs } from '../shared/index.ts';
import BashView from './BashView.vue';
import DiffView from './DiffView.vue';
import EntryInput from './EntryInput.vue';

export default client(fs, {
  fns: { bash: BashView },
  attachments: { diff: DiffView },
  inputs: { Entry: EntryInput },
});
