/**
 * The Ollama system's client: its admin page (`/s/ollama/servers`), typed by its contract. The app loads this build
 * from the hub and draws the page with its own components while the system is installed and live.
 */
// typescript-eslint can't see the types of .vue modules from .ts files; vue-tsc checks this file
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { client } from '@harness/sdk';
import { ollama } from '../shared/index.ts';
import ServersPage from './ServersPage.vue';

export default client(ollama, {
  pages: { ServersPage },
});
