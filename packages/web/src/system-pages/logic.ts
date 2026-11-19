/**
 * System pages (item 9) in the app: what the nav shows of the live systems' pages, where a `/s/<system>/<page>` URL
 * points, and the host a page is handed (`PageHost`): the person, the hub client, the URL's query bound two ways, links
 * to the system's other pages, and the app's shared components. Pure apart from Vue reactivity, so tests drive it.
 */
import { SystemName, type SystemPageView, type UserView } from '@harness/core';
import type { ChatStart, HubClient, PageHost, PageLocation, QueryBinding, SharedComponents } from '@harness/sdk';
import type { LocationQuery, RouteLocationRaw, RouteParamsGeneric } from 'vue-router';
import { links } from '../app/routes.ts';
import { ICONS, type IconName } from '../ui/index.ts';

const isIconName = (name: string): name is IconName => name in ICONS;

/** A page's icon: the one it names, when the app has it, else a generic one. */
export function pageIcon(icon: string | undefined): IconName {
  return icon !== undefined && isIconName(icon) ? icon : 'layers';
}

/** What the nav needs of a system page. */
export interface PageNav {
  readonly system: SystemName;
  readonly segment: string;
  readonly title: string;
  readonly icon: IconName;
}

/** The nav entries the live systems' pages add: the `main` ones, in the order the hub lists them. */
export function pageNav(pages: readonly SystemPageView[]): PageNav[] {
  return pages.filter((page) => page.nav === 'main').map((page) => ({ system: page.system, segment: page.segment, title: page.title, icon: pageIcon(page.icon) }));
}

/** Where a system page's URL points: its system, page segment and the parts under it. */
export interface PageAddress {
  readonly system: SystemName;
  readonly page: string;
  readonly path: readonly string[];
}

/** The address in a system page route's params; undefined when the system part isn't a system name. */
export function pageAddress(params: RouteParamsGeneric): PageAddress | undefined {
  const system = SystemName.safeParse(params['system']);
  const page = params['page'];
  if (!system.success || typeof page !== 'string') { return undefined; }
  const raw = params['path'];
  const path = Array.isArray(raw) ? raw : typeof raw === 'string' && raw !== '' ? [raw] : [];
  return { system: system.data, page, path };
}

/** A URL query as plain strings: a repeated key keeps its first value, a key with no value is left out. */
export function queryValues(query: LocationQuery): Record<string, string> {
  return Object.fromEntries(Object.entries(query).flatMap(([key, value]) => {
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' ? [[key, first]] : [];
  }));
}

/** Where the page is now. Read reactively (the route), so the host's query follows the URL. */
export interface PageHere extends PageAddress {
  readonly query: Readonly<Record<string, string>>;
}

/** What the app gives `pageHost`: the route, the router and the app's shared parts. */
export interface PageHostDeps {
  readonly here: () => PageHere;
  readonly navigate: (to: RouteLocationRaw, replace: boolean) => void;
  readonly resolve: (to: RouteLocationRaw) => string;
  readonly user: () => UserView;
  readonly hub: HubClient;
  readonly components: SharedComponents;
  /** Start a chat as the person (running a fn first) and go to it (`openChat` in `chat/state/open-chat.ts`). */
  readonly openChat: (start: ChatStart) => Promise<void>;
  /** A page's runs in a chat of the person's (`ChatRuns`), its inbox approvals and its toasts. */
  readonly runs: PageHost['runs'];
  readonly inbox: PageHost['inbox'];
  readonly notify: PageHost['notify'];
  readonly format: PageHost['format'];
  readonly live: PageHost['live'];
  readonly chatHref: PageHost['chatHref'];
  readonly goChat: PageHost['goChat'];
}

/** The host a system page is handed. Its query and user read the route and session live. */
export function pageHost(deps: PageHostDeps): PageHost {
  const target = (to: PageLocation): RouteLocationRaw => {
    const here = deps.here();
    const page = to.page ?? here.page;
    // the same page keeps its path unless a new one is given; another page starts at its root
    const path = to.path ?? (page === here.page ? here.path : []);
    return links.systemPage(here.system, page, path, to.query ?? {});
  };
  const set = (patch: Readonly<Record<string, string | undefined>>, push: boolean): void => {
    const here = deps.here();
    deps.navigate(links.systemPage(here.system, here.page, here.path, { ...here.query, ...patch }), !push);
  };
  const bind = (key: string, fallback = ''): QueryBinding => ({
    get value() { return deps.here().query[key] ?? fallback; },
    set value(value: string) { set({ [key]: value === fallback ? undefined : value }, false); },
  });
  return {
    get user() { return deps.user(); },
    hub: deps.hub,
    query: {
      get values() { return deps.here().query; },
      get: (key) => deps.here().query[key],
      set: (patch, options) => { set(patch, options?.push === true); },
      bind,
    },
    href: (to) => deps.resolve(target(to)),
    chatHref: (session) => deps.chatHref(session),
    goChat: (session) => { deps.goChat(session); },
    go: (to, options) => { deps.navigate(target(to), options?.replace === true); },
    openChat: (start) => deps.openChat(start),
    components: deps.components,
    runs: (options) => deps.runs(options),
    inbox: deps.inbox,
    notify: deps.notify,
    format: deps.format,
    live: (refresh, every) => { deps.live(refresh, every); },
  };
}

/** Why a system page can't be drawn, in words the "not installed" state shows. */
export function missingPage(address: PageAddress, pages: readonly SystemPageView[]): { readonly title: string; readonly body: string } {
  const ofSystem = pages.some((page) => page.system === address.system);
  return ofSystem
    ? { title: 'No such page', body: `${address.system} has no page called “${address.page}”. It may have been renamed in a newer version.` }
    : { title: `${address.system} isn’t installed`, body: `This page belongs to the ${address.system} system, which isn’t installed and live here, or you can’t use it. The link will work again once it is.` };
}
