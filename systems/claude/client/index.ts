/**
 * The claude system's client (item 8/9): its pages, typed by its contract. The app loads this build from the hub and
 * draws the fleet at `/s/claude/sessions` and one session at `/s/claude/session/<instance>/<session>` while the system
 * is installed and live; both draw with the app's own components and the chat's own parts (`host.components`).
 */
// typescript-eslint can't see the types of .vue modules from .ts files; vue-tsc checks this file
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { client } from '@harness/sdk';
import { claude } from '../shared/index.ts';
import FleetPage from './FleetPage.vue';
import SessionPage from './SessionPage.vue';

export default client(claude, {
  pages: { FleetPage, SessionPage },
});
