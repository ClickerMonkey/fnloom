/**
 * The web API as `@ayepi/plugin` plugins, one per slice of `hubWebSpec`, in install order. `auth` binds the shared
 * middleware (`tel`, `hubAuth`), `systems` binds `adminOnly`, and `events` relays the bus to browsers while it is
 * installed.
 */
import { plugin, type AnyPlugin } from '@ayepi/plugin';
import type { HubServices } from '../../boot/index.ts';
import { authPlugin, type AuthPluginOptions } from './auth.ts';
import { chatPlugin } from './chat.ts';
import { contentPlugin } from './content.ts';
import { findPlugin } from './find.ts';
import { inboxPlugin } from './inbox.ts';
import { runsPlugin } from './runs.ts';
import { settingsPlugin } from './settings.ts';
import { eventsSlice } from './slices.ts';
import { systemsPlugin } from './systems.ts';

/** The realtime plugin: while installed, bus events reach browsers as `session` and `user` events. */
export function eventsPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>) {
  return plugin({ name: 'web.events', spec: eventsSlice, requires: [auth] })
    .lifecycle((ctx) => {
      let stop: (() => void) | undefined;
      return {
        up: () => { stop = hub.api.relay.start(ctx.emit); },
        stop: () => { stop?.(); },
      };
    });
}

/** Every web API plugin, in the order they must be installed. */
export function webPlugins(hub: HubServices, options: AuthPluginOptions): readonly AnyPlugin[] {
  const auth = authPlugin(hub, options);
  const systems = systemsPlugin(hub, auth);
  return [
    auth,
    chatPlugin(hub, auth),
    runsPlugin(hub, auth),
    findPlugin(hub, auth),
    inboxPlugin(hub, auth),
    contentPlugin(hub, auth),
    systems,
    settingsPlugin(hub, systems),
    eventsPlugin(hub, auth),
  ];
}

export type { AuthPluginOptions } from './auth.ts';
