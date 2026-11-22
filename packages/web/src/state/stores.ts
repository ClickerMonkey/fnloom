/**
 * The app's stores, provided once at the root (`app/wire.ts` builds them from the real client) and reached from pages
 * with `useStores()`. Tests provide their own, built on fake callers.
 */
import { inject, type InjectionKey } from 'vue';
import type { AdminStore } from '../admin/state/admin.ts';
import type { ChatStore } from '../chat/state/chat.ts';
import type { SessionKeeper, SignInForm } from './auth.ts';
import type { ConnectionStore } from './connection.ts';
import type { IdentityStore } from './identity.ts';
import type { InboxStore } from './inbox.ts';
import type { OutsideImagesStore } from './outside-images.ts';
import type { LayoutStore } from './layout.ts';
import type { PushStore } from './push.ts';
import type { ResourcesStore } from '../resources/state/resources.ts';
import type { ContextStore } from '../context/state/context.ts';
import type { FnInfoStore } from '../fns/state/fn-info.ts';
import type { FnNotices } from '../fns/state/fn-notices.ts';
import type { ModelNamesStore } from '../fns/state/model-names.ts';
import type { GraphStore } from '../graph/state/graph.ts';
import type { DataStore } from '../data/state/data.ts';
import type { SystemPagesStore } from '../system-pages/store.ts';
import type { ItemVersionsSource } from '../components/versions/versions.ts';
import type { ClientLogs } from './client-logs.ts';
import type { SessionStore } from './session.ts';
import type { AccountStore } from './account.ts';
import type { ThemeStore } from './theme.ts';
import type { Toasts } from './toasts.ts';

/** Every store the shell and pages use. */
export interface Stores {
  readonly session: SessionStore;
  /** The hub's display name and version, live. */
  readonly identity: IdentityStore;
  /** Whether markdown images from outside the hub load at once (the admin's setting). */
  readonly outsideImages: OutsideImagesStore;
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
  /** Your own account, for Settings › Account. */
  readonly account: AccountStore;
  /** Web push on this device. */
  readonly push: PushStore;
  /** The resource browser and the resource viewers. */
  readonly resources: ResourcesStore;
  /** Every context item, one item with its links, memory and links drawn by people. */
  readonly context: ContextStore;
  /** One fn's view (the fn modal and the fn page): what it is, its facts and its examples. */
  readonly fns: FnInfoStore;
  /** Each fn's notice ("This usually takes about 3 minutes."), for the approval and running cards. */
  readonly fnNotices: FnNotices;
  /** Tool names in stored model calls read back to fns (cut names asked of the hub), for the LLM call view. */
  readonly modelNames: ModelNamesStore;
  /** A new graph view (the graph page, a system's Graph tab), each with its own query and page. */
  readonly graph: () => GraphStore;
  /** The Data pages (build 8): stored types, their records, saved widgets and the actions rows offer. */
  readonly data: DataStore;
  /** The pages live systems add (item 9), for the nav and `/s/<system>/<page>`. */
  readonly pages: SystemPagesStore;
  /** Any item's version history (build 8), a page at a time. */
  readonly itemVersions: ItemVersionsSource;
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
