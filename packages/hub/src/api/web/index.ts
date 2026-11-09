/**
 * The web API as `@ayepi/plugin` plugins, one per slice of `hubWebSpec`, in install order. `auth` binds the shared
 * middleware (`tel`, `hubAuth`), `systems` binds `adminOnly`, and `events` relays the bus to browsers while it is
 * installed.
 */
import { plugin, type AnyPlugin } from '@ayepi/plugin';
import { eventsSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import { adminOperations } from '../admin-ops.ts';
import { hubReads } from '../reads.ts';
import { adminPlugin } from './admin.ts';
import { authPlugin, type AuthPluginOptions } from './auth.ts';
import { chatPlugin } from './chat.ts';
import { contentPlugin } from './content.ts';
import { findPlugin } from './find.ts';
import { inboxPlugin } from './inbox.ts';
import { runsPlugin } from './runs.ts';
import { settingsPlugin } from './settings.ts';
import { systemsPlugin } from './systems.ts';
import { contextPlugin } from './context.ts';
import { contextorPlugin } from './contextor.ts';
import { mcpsPlugin } from './mcps.ts';
import { metricsPlugin } from './metrics.ts';
import { modelsPlugin } from './models.ts';
import { packagingPlugin } from './packaging.ts';
import { resourcesPlugin } from './resources.ts';
import { build3Plugins } from './build3.ts';
import { build4Plugins } from './build4.ts';
import { build5Plugins } from './build5.ts';

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
  const ops = adminOperations(hub);
  const reads = hubReads(hub);
  const systems = systemsPlugin(hub, auth, ops, reads);
  return [
    auth,
    chatPlugin(hub, auth, reads),
    runsPlugin(hub, auth, reads),
    findPlugin(hub, auth),
    inboxPlugin(hub, auth, reads),
    contentPlugin(hub, auth),
    systems,
    settingsPlugin(hub, systems, ops),
    adminPlugin(hub, systems, ops, reads),
    resourcesPlugin(hub, auth, reads),
    contextPlugin(hub, auth, reads),
    contextorPlugin(hub, systems, ops),
    modelsPlugin(hub, systems, ops),
    metricsPlugin(hub, systems, reads),
    mcpsPlugin(hub, systems, ops),
    packagingPlugin(hub, systems, ops),
    ...build3Plugins(hub, systems, reads),
    ...build4Plugins(hub, systems),
    ...build5Plugins(systems),
    eventsPlugin(hub, auth),
  ];
}

export type { AuthPluginOptions } from './auth.ts';
