/**
 * The connect pages' rules, kept apart from the views: which connection a page shows, each fn's switches (the
 * person's own, else the system's default), the nav entries the pages add, and plain words for a connection's state.
 */
import type { ActorId, ConnectionFnOption, ConnectionStatus, ConnectionView, ConnectPage, SystemName } from '@harness/core';
import { ICONS, type IconName } from '../ui/icons.ts';
import type { Tone } from '../ui/types.ts';

/** A page's connections as the person sees them: their own (newest first), and the ones others shared with them. */
export interface PageConnections {
  /** The person's own connection the page edits: the newest, if any. */
  readonly own: ConnectionView | undefined;
  /** Connections other people shared with this person (read only here). */
  readonly shared: readonly ConnectionView[];
}

/** Split a page's connections into the person's own and the shared ones. */
export function pageConnections(page: ConnectPage, me: ActorId | undefined): PageConnections {
  const newest = [...page.connections].sort((a, b) => b.updatedAt - a.updatedAt);
  return { own: newest.find((c) => c.owner === me), shared: newest.filter((c) => c.owner !== me) };
}

/** One fn's row on the page: its local name, its full name, and the switches in force. */
export interface FnSwitchRow {
  /** The fn's local name (`list_events`). */
  readonly local: string;
  readonly name: string;
  readonly option: ConnectionFnOption;
  /** Whether the person changed it from the system's default. */
  readonly changed: boolean;
}

/** Every fn the system acts as the person with, in its declared order, with the person's switches over the defaults. */
export function fnRows(page: ConnectPage, connection: ConnectionView | undefined): FnSwitchRow[] {
  return Object.entries(page.decl.fns).map(([local, fallback]) => {
    const own = connection?.fns[local];
    const option = own ?? fallback;
    return { local, name: `${page.system}/${local}`, option, changed: own !== undefined && (own.on !== fallback.on || own.ask !== fallback.ask) };
  });
}

/** A connection's fn switches with one fn changed, every fn written out so the stored value is whole. */
export function withFnOption(rows: readonly FnSwitchRow[], local: string, change: Partial<ConnectionFnOption>): Record<string, ConnectionFnOption> {
  return Object.fromEntries(rows.map((row) => [row.local, row.local === local ? { ...row.option, ...change } : row.option]));
}

/** A connection's state in words, with its tone. */
export const STATUS_WORDS = {
  pending: { label: 'Waiting for sign-in', tone: 'warn' },
  connected: { label: 'Connected', tone: 'ok' },
  expired: { label: 'Expired', tone: 'warn' },
  failed: { label: 'Failed', tone: 'danger' },
} as const satisfies Record<ConnectionStatus, { readonly label: string; readonly tone: Tone }>;

const isIconName = (name: string): name is IconName => name in ICONS;

/** A page's icon: the one the system names, when the app has it. */
export function pageIcon(page: Pick<ConnectPage, 'decl'>): IconName {
  const named = page.decl.icon;
  return named !== undefined && isIconName(named) ? named : 'link';
}

/** What the nav needs of a connect page. */
export interface ConnectNav {
  readonly system: SystemName;
  readonly title: string;
  readonly icon: IconName;
}

/** The nav entries the connect pages add, in title order. */
export function connectNav(pages: readonly ConnectPage[]): ConnectNav[] {
  return pages.map((page) => ({ system: page.system, title: page.decl.title, icon: pageIcon(page) })).sort((a, b) => a.title.localeCompare(b.title));
}
