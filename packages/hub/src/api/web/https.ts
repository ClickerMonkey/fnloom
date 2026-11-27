/**
 * HTTPS on the hub's port over the web API: everyone signed in reads it (Settings › App shows how to use the hub on a
 * phone: the authority to install and the https links); admins switch it, and the next connection follows.
 */
import { plugin } from '@ayepi/plugin';
import { httpsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The https plugin. Requires the systems plugin, which binds `adminOnly`. */
export function httpsPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.https', spec: httpsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof httpsSlice> => ({
      https: () => Promise.resolve(hub.api.https.view()),
      setHttps: ({ data, user }) => hub.api.https.set(data.on, user.id),
    }));
}
