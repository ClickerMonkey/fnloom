/**
 * Build 4's visibility and per-person connection slices: `accessSlice` (whether the hub has more than one person, and
 * each target's owner and visibility) and `connectionsSlice` (each person's own connections), over the access and
 * connections modules.
 */
import { reject } from '@ayepi/core';
import { plugin } from '@ayepi/plugin';
import { accessSlice, connectionsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { CONNECT_CALLBACK_PATH } from '../../connections/service.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The visibility plugin. Requires the systems plugin, which binds `hubAuth`. */
export function accessPlugin(hub: Pick<HubServices, 'access'>, systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.access', spec: accessSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof accessSlice> => ({
      accessInfo: () => hub.access.info(),
      access: ({ data, user }) => hub.access.views(user.id, data.targets),
      setAccess: ({ data, user }) => hub.access.set(user.id, data.target, data.sharing),
    }));
}

/** The per-person connections plugin: every person, their own connections only, to the systems they may see. */
export function connectionsPlugin(hub: Pick<HubServices, 'connections' | 'access'>, systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.connections', spec: connectionsSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof connectionsSlice> => ({
      connectPages: async ({ user }) => {
        const [pages, scope] = await Promise.all([hub.connections.pages(user.id), hub.access.scope(user.id)]);
        return pages.filter((page) => scope.seesSystem(page.system));
      },
      connect: async ({ data, user, cookie }) => {
        if (!(await hub.access.scope(user.id)).seesSystem(data.system)) { throw reject(404, 'NOT_FOUND', `${data.system} has no per-person connections`); }
        const started = await hub.connections.connect(user.id, data.system, data.form);
        if (!('binding' in started)) return started;
        // ties the provider's sign-in to this browser: the callback finishes only where this cookie is
        const { binding } = started;
        cookie(binding.cookie, binding.value, { path: CONNECT_CALLBACK_PATH, maxAge: binding.maxAge, httpOnly: true, sameSite: 'Lax', secure: binding.secure });
        return { url: started.url };
      },
      updateConnection: ({ data, user }) => hub.connections.update(user.id, data),
      disconnect: async ({ data, user }) => ({ ok: await hub.connections.disconnect(user.id, data.connection) }),
    }));
}
