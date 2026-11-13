/**
 * The notes system's process: reads its settings, builds the implementation (its notes are hub records), builds its
 * renderers, and serves both to the hub (pairing the first time).
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClient } from '@harness/sdk/build';
import { loggedHost, serve } from '@harness/sdk/server';
import { notes } from '../shared/index.ts';
import { notesEnv } from './env.ts';
import { createNotesImpl } from './impl.ts';

// #region main
const settings = notesEnv.parse();
const { host, log } = loggedHost(notes.name);

const impl = createNotesImpl({ settings });

// the renderers, built into the state folder and uploaded to the hub on connect
const clientFolder = join(settings.HARNESS_SYSTEM_STATE, 'client');
await buildClient({ entry: fileURLToPath(new URL('../client/index.ts', import.meta.url)), outDir: clientFolder });

const running = await serve(notes, impl, {
  hub: settings.HARNESS_HUB,
  state: settings.HARNESS_SYSTEM_STATE,
  client: clientFolder,
  ...(settings.HARNESS_PAIRING_TOKEN === undefined ? {} : { pairingToken: settings.HARNESS_PAIRING_TOKEN }),
}, host);
running.onStatus((status) => { log.info('notes.status', { status }); });

const stop = () => {
  running.stop().finally(() => { process.exit(0); }).catch(() => undefined);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// #endregion main
