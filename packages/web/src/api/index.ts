/** Every caller the app uses, grouped by area, made once from the one client. */
import { adminApi, systemLogEvents } from '../admin/api.ts';
import { chatApi, sessionEvents } from '../chat/api.ts';
import { authApi } from './auth.ts';
import type { Hub } from './client.ts';
import { notificationsApi, userEvents } from './notifications.ts';
import { resourceEvents, resourcesApi } from '../resources/api/resources.ts';
import { contextApi, contextEvents } from '../context/api/context.ts';

/** Make the app's callers. */
export function createApi(hub: Hub) {
  return {
    auth: authApi(hub),
    notifications: notificationsApi(hub),
    userEvents: userEvents(hub),
    chat: chatApi(hub),
    sessionEvents: sessionEvents(hub),
    admin: adminApi(hub),
    systemLogs: systemLogEvents(hub),
    resources: resourcesApi(hub),
    resourceEvents: resourceEvents(userEvents(hub)),
    context: contextApi(hub),
    contextEvents: contextEvents(userEvents(hub)),
    connection: hub.connection,
  };
}

/** The app's callers. */
export type Api = ReturnType<typeof createApi>;
