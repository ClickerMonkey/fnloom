/** Every caller the app uses, grouped by area, made once from the one client. */
import type { ActorId } from '@harness/core';
import { adminApi, systemLogEvents, type AdminApi, type SystemLogEvents } from '../admin/api.ts';
import { chatApi, sessionEvents, type ChatApi, type SessionEvents } from '../chat/api.ts';
import { authApi, type AuthApi } from './auth.ts';
import { identityApi, type IdentityApi } from './identity.ts';
import { outsideImagesApi, type OutsideImagesApi } from './outside-images.ts';
import { httpsApi, type HttpsApi } from './https.ts';
import type { Connection, Hub } from './client.ts';
import { notificationsApi, userEvents, type NotificationsApi, type UserEvents } from './notifications.ts';
import { resourceEvents, resourcesApi, type ResourceEvents, type ResourcesApi } from '../resources/api/resources.ts';
import { contextApi, contextEvents, type ContextApi, type ContextEvents } from '../context/api/context.ts';
import { fnsApi, type FnsApi } from '../fns/api.ts';
import { graphApi, type GraphApi } from '../graph/api/graph.ts';
import { dataApi, type DataApi } from '../data/api.ts';
import { systemPagesApi, type SystemPagesApi } from '../system-pages/api.ts';

/**
 * The app's callers. Spelled out by each area's own type, so the compiler refers to them by name rather than writing
 * every caller's type out in full (which is past what it will serialize).
 */
export interface Api {
  readonly auth: AuthApi;
  readonly identity: IdentityApi;
  /** The admin's setting for markdown images from outside the hub. */
  readonly outsideImages: OutsideImagesApi;
  /** https on the hub's port: its switch, and what a phone needs to use it. */
  readonly https: HttpsApi;
  readonly notifications: NotificationsApi;
  readonly userEvents: UserEvents;
  readonly chat: ChatApi;
  readonly sessionEvents: SessionEvents;
  readonly admin: AdminApi;
  readonly systemLogs: SystemLogEvents;
  readonly resources: ResourcesApi;
  readonly resourceEvents: ResourceEvents;
  readonly context: ContextApi;
  readonly fns: FnsApi;
  readonly graph: GraphApi;
  /** The data system, widgets' row actions and items' version history (build 8). */
  readonly data: DataApi;
  /** The pages live systems add (item 9). */
  readonly pages: SystemPagesApi;
  readonly contextEvents: ContextEvents;
  readonly connection: Connection;
}

/** Make the app's callers; `me` is who is signed in (reactive), whose live events the app hears. */
export function createApi(hub: Hub, me: () => ActorId | undefined): Api {
  const events = userEvents(hub, me);
  return {
    auth: authApi(hub),
    identity: identityApi(hub),
    outsideImages: outsideImagesApi(hub),
    https: httpsApi(hub),
    notifications: notificationsApi(hub),
    userEvents: events,
    chat: chatApi(hub),
    sessionEvents: sessionEvents(hub),
    admin: adminApi(hub),
    systemLogs: systemLogEvents(hub),
    resources: resourcesApi(hub),
    resourceEvents: resourceEvents(events),
    context: contextApi(hub),
    fns: fnsApi(hub),
    graph: graphApi(hub),
    data: dataApi(hub),
    pages: systemPagesApi(hub),
    contextEvents: contextEvents(events),
    connection: hub.connection,
  };
}
