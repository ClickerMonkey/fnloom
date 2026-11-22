/**
 * The web API as `@ayepi/plugin` plugins, one per slice of `hubWebSpec`, in install order. `auth` binds the shared
 * middleware (`tel`, `hubAuth`), `systems` binds `adminOnly`, and `events` relays the bus to browsers while it is
 * installed.
 */
import { plugin, type AnyPlugin } from '@ayepi/plugin';
import { reject, type WsConn } from '@ayepi/core';
import { eventsSlice, ownEvents, type AccessClaims, type ActorId, sessionWatch, SessionEventParams, UserEventParams } from '@harness/core';
import type { WebSockets } from '../events.ts';
import { visibleSession } from './access.ts';
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
import { explorerPlugin } from './explorer.ts';
import { graphPlugin } from './graph.ts';
import { reviewPlugin } from './review.ts';
import { injectionsPlugin } from './injections.ts';
import { identityPlugin } from './identity.ts';
import { peoplePlugin } from './people.ts';
import { imageEmbeddingPlugin } from './images.ts';
import { outsideImagesPlugin } from './outside-images.ts';
import { versionsPlugin } from './versions.ts';
import { dataPlugin } from './data.ts';
import { tablesPlugin } from './tables.ts';

/** What the web API plugins need besides the services. */
export interface WebPluginOptions extends AuthPluginOptions {
  /** The web API server's sockets, so a sign-out ends that sign-in's live events. */
  readonly sockets: WebSockets;
}

/** The subscription a guard looks at, refused when it isn't a socket's. */
function subscription(io: { readonly ws?: { readonly data: unknown; readonly conn: WsConn } | undefined }): { readonly data: unknown; readonly conn: WsConn } {
  if (io.ws === undefined) { throw reject(400, 'SOCKET_ONLY', 'live events come over the socket'); }
  return io.ws;
}

/**
 * Tell the relay who a socket listens as, then check the sign-in is still on. A sign-out that lands while the guard
 * runs is then caught either way: before the check it is refused here, after it the relay ends the socket.
 */
async function listenAs(hub: HubServices, conn: WsConn, ctx: { readonly user: { readonly id: ActorId }; readonly jwt: AccessClaims }): Promise<void> {
  hub.api.relay.listen(conn, { user: ctx.user.id, session: ctx.jwt.session });
  if ((await hub.api.auth.user(ctx.jwt)) === undefined) { throw reject(401, 'SIGNED_OUT', 'sign in again'); }
}

/**
 * The realtime plugin: while installed, bus events reach browsers as `session` and `user` events. `ownEvents` lets a
 * person hear only their own `user` events and `sessionWatch` only sessions they may see (404 otherwise, as over
 * HTTP); both tell the relay who the socket listens as, so signing out ends it.
 */
export function eventsPlugin(hub: HubServices, auth: ReturnType<typeof authPlugin>, sockets: WebSockets) {
  return plugin({ name: 'web.events', spec: eventsSlice, requires: [auth] })
    .middleware(ownEvents, () => async (io) => {
      const { data, conn } = subscription(io);
      if (UserEventParams.parse(data).user !== io.ctx.user.id) { throw reject(403, 'NOT_YOUR_EVENTS', 'you can only hear your own events'); }
      await listenAs(hub, conn, io.ctx);
      return io.next();
    })
    .middleware(sessionWatch, () => async (io) => {
      const { data, conn } = subscription(io);
      await visibleSession(hub, SessionEventParams.parse(data).session, io.ctx.user);
      await listenAs(hub, conn, io.ctx);
      return io.next();
    })
    .lifecycle((ctx) => {
      let stop: (() => void) | undefined;
      return {
        up: () => { stop = hub.api.relay.start(ctx.emit, sockets); },
        stop: () => { stop?.(); },
      };
    });
}

/** Every web API plugin, in the order they must be installed. */
export function webPlugins(hub: HubServices, options: WebPluginOptions): readonly AnyPlugin[] {
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
    ...build3Plugins(hub, systems, reads, ops),
    ...build4Plugins(hub, systems),
    ...build5Plugins(hub, systems),
    explorerPlugin(hub, systems),
    reviewPlugin(hub, systems),
    injectionsPlugin(hub, systems, ops),
    graphPlugin(auth, reads),
    identityPlugin(hub, systems),
    peoplePlugin(hub, systems, reads),
    imageEmbeddingPlugin(hub, systems),
    outsideImagesPlugin(hub, systems),
    versionsPlugin(auth, reads),
    dataPlugin(hub, auth),
    ...tablesPlugin(hub, auth),
    eventsPlugin(hub, auth, options.sockets),
  ];
}

export type { AuthPluginOptions } from './auth.ts';
