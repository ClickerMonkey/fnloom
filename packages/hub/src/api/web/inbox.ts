/**
 * The inbox slice: a person's notifications, marking them read, and subscribing a browser to web push. A browser that
 * subscribes again (same endpoint) updates its subscription instead of adding another.
 */
import { plugin } from '@ayepi/plugin';
import { inboxSlice, compact, mintId } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { type FullHandlers } from './access.ts';
import type { authPlugin } from './auth.ts';
import type { HubReads } from '../reads.ts';

/** The inbox plugin. */
export function inboxPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, reads: HubReads) {
  const { chat, api, store } = hub;
  return plugin({ name: 'web.inbox', spec: inboxSlice, requires: [auth] })
    .handlers((): FullHandlers<typeof inboxSlice> => ({
      notifications: (io) => (io.data.query === undefined ? chat.notifications.list(io.user.id, compact(io.data)) : reads.lists.page('notifications', io.data.query, io.user)),
      readNotifications: async ({ data, user }) => {
        await chat.notifications.read(user.id, data.ids);
      },
      pushKey: () => ({ publicKey: api.push.publicKey() }),
      subscribePush: async ({ data, user }) => {
        const table = store.table('pushSubscriptions');
        const existing = (await table.find({ where: { user: user.id, endpoint: data.endpoint }, limit: 1 })).items[0];
        if (existing !== undefined) {
          await table.update(existing.id, { keys: data.keys, device: data.device });
          return { id: existing.id };
        }
        const id = mintId('push');
        await table.insert({ id, user: user.id, endpoint: data.endpoint, keys: data.keys, device: data.device, createdAt: hub.clock() });
        hub.log.info('push.subscribed', { user: user.id, push: id });
        return { id };
      },
    }));
}
