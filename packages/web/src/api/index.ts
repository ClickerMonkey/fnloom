/** Every caller the app uses, grouped by area, made once from the one client. */
import { adminApi, systemLogEvents, type AdminApi, type SystemLogEvents } from '../admin/api.ts';
import { chatApi, sessionEvents, type ChatApi, type SessionEvents } from '../chat/api.ts';
import { authApi, type AuthApi } from './auth.ts';
import { identityApi, type IdentityApi } from './identity.ts';
import type { Connection, Hub } from './client.ts';
import { notificationsApi, userEvents, type NotificationsApi, type UserEvents } from './notifications.ts';
import { resourceEvents, resourcesApi, type ResourceEvents, type ResourcesApi } from '../resources/api/resources.ts';
import { contextApi, contextEvents, type ContextApi, type ContextEvents } from '../context/api/context.ts';
import { fnsApi, type FnsApi } from '../fns/api.ts';
import { graphApi, type GraphApi } from '../graph/api/graph.ts';
import { dataApi, type DataApi } from '../data/api.ts';

/**
 * The app's callers. Spelled out by each area's own type, so the compiler refers to them by name rather than writing
 * every caller's type out in full (which is past what it will serialize).
 */
export interface Api {
  readonly auth: AuthApi;
  readonly identity: IdentityApi;
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
  readonly contextEvents: ContextEvents;
  readonly connection: Connection;
}

/** Make the app's callers. */
export function createApi(hub: Hub): Api {
  return {
    auth: authApi(hub),
    identity: identityApi(hub),
    notifications: notificationsApi(hub),
    userEvents: userEvents(hub),
    chat: chatApi(hub),
    sessionEvents: sessionEvents(hub),
    admin: adminApi(hub),
    systemLogs: systemLogEvents(hub),
    resources: resourcesApi(hub),
    resourceEvents: resourceEvents(userEvents(hub)),
    context: contextApi(hub),
    fns: fnsApi(hub),
    graph: graphApi(hub),
    data: dataApi(hub),
    contextEvents: contextEvents(userEvents(hub)),
    connection: hub.connection,
  };
}
