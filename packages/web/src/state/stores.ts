/**
 * The app's stores, provided once at the root (`app/wire.ts` builds them from the real client) and reached from pages
 * with `useStores()`. Tests provide their own, built on fake callers.
 */
import { inject, type InjectionKey } from 'vue';
import type { AdminStore } from '../admin/state/admin.ts';
import type { ChatStore } from '../chat/state/chat.ts';
import type { SessionKeeper, SignInForm } from './auth.ts';
import type { ConnectionStore } from './connection.ts';
import type { InboxStore } from './inbox.ts';
import type { LayoutStore } from './layout.ts';
import type { PushStore } from './push.ts';
import type { ResourcesStore } from '../resources/state/resources.ts';
import type { ContextStore } from '../context/state/context.ts';
import type { FnInfoStore } from '../fns/state/fn-info.ts';
import type { GraphStore } from '../graph/state/graph.ts';
import type { ClientLogs } from './client-logs.ts';
import type { SessionStore } from './session.ts';
import type { ThemeStore } from './theme.ts';
import type { Toasts } from './toasts.ts';

/** Every store the shell and pages use. */
export interface Stores {
  readonly session: SessionStore;
  readonly keeper: SessionKeeper;
  readonly theme: ThemeStore;
  readonly layout: LayoutStore;
  readonly toasts: Toasts;
  readonly inbox: InboxStore;
  readonly connection: ConnectionStore;
  /** The chat: sessions, threads, composers, capabilities, inspectors and renderers. */
  readonly chat: ChatStore;
  /** The admin pages: systems and pairing, models, limits, policies, actor settings and the browsers. */
  readonly admin: AdminStore;
  /** A fresh sign-in form for the sign-in page. */
  readonly signInForm: () => SignInForm;
  /** Web push on this device. */
  readonly push: PushStore;
  /** The resource browser and the resource viewers. */
  readonly resources: ResourcesStore;
  /** Every context item, one item with its links, memory and links drawn by people. */
  readonly context: ContextStore;
  /** One fn's view (the fn modal and the fn page): what it is, its facts and its examples. */
  readonly fns: FnInfoStore;
  /** A new graph view (the graph page, a system's Graph tab), each with its own query and page. */
  readonly graph: () => GraphStore;
  /** The browser's logs and API traffic, sent to the hub. */
  readonly logs: ClientLogs;
}

export const STORES: InjectionKey<Stores> = Symbol('stores');

/** The app's stores, or undefined outside the app (a component mounted alone, in a test). */
export function useStoresIfAny(): Stores | undefined {
  return inject(STORES, undefined);
}

/** The app's stores. Throws outside the app, where nothing provided them. */
export function useStores(): Stores {
  const stores = inject(STORES);
  if (stores === undefined) { throw new Error('useStores() needs the app to provide STORES (see app/wire.ts)'); }
  return stores;
}
