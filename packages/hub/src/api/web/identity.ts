/**
 * Build 8, the identity slice: the hub's display name. Anyone may read it (the sign-in page shows it before anyone
 * signs in); admins set or clear it, and every open tab hears the change as the user event `identity`.
 */
import { plugin } from '@ayepi/plugin';
import { identitySlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The identity plugin. Requires the systems plugin, which binds `adminOnly`. */
export function identityPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.identity', spec: identitySlice, requires: [systems] })
    .handlers((): FullHandlers<typeof identitySlice> => ({
      identity: () => hub.api.identity.identity(),
      setHubName: ({ data, user }) => hub.api.identity.setName(data.name, user.id),
    }));
}
