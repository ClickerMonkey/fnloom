/**
 * The connect pages' rules, kept apart from the views: which connection a page shows, each fn's switches (the
 * person's own, else the system's default), the nav entries the pages add, and plain words for a connection's state.
 */
import type {
  ActorId, ConnectionAccount, ConnectionFnOption, ConnectionStatus, ConnectionView, ConnectKey, ConnectPage, GinTypeDef, InstanceConnect, InstanceName, Json, PickOption, SystemName,
} from '@harness/core';
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

/** One settings field shown as a picker: its name, what it is for, whether it holds a list, and the values offered. */
export interface SettingsPick {
  readonly key: string;
  /** The field's name in words ("Default calendar"). */
  readonly label: string;
  readonly hint: string;
  /** A list field picks many; any other picks one. */
  readonly many: boolean;
  readonly options: readonly PickOption[];
}

/** A type with an `optional` wrapper taken off. */
const unwrapped = (type: GinTypeDef): GinTypeDef => (type.name === 'optional' ? type.generic?.['T'] ?? type : type);
/** A field name in words: `defaultCalendar` → "Default calendar". */
const fieldWords = (key: string): string => { const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); return words.charAt(0).toUpperCase() + words.slice(1); };

/**
 * The settings as pickers, when the account offers values for every field of the settings object (an account's
 * calendars); otherwise undefined and the page edits the settings as typed.
 */
export function settingsPicks(settings: GinTypeDef, choices: ConnectionAccount['choices']): SettingsPick[] | undefined {
  const props = settings.name === 'obj' ? settings.props : undefined;
  if (props === undefined || choices === undefined) { return undefined; }
  const picks = Object.entries(props).map(([key, prop]): SettingsPick | undefined => {
    const options = choices[key];
    if (options === undefined) { return undefined; }
    return { key, label: fieldWords(key), hint: prop.docs ?? '', many: unwrapped(prop.type).name === 'list', options };
  });
  return picks.every((pick) => pick !== undefined) && picks.length > 0 ? picks : undefined;
}

/** A settings value's field as picker values: a list's strings, or the one string. */
export function pickedValues(settings: Json, key: string): string[] {
  const value = typeof settings === 'object' && settings !== null && !Array.isArray(settings) ? settings[key] : undefined;
  if (Array.isArray(value)) { return value.filter((item): item is string => typeof item === 'string'); }
  return typeof value === 'string' ? [value] : [];
}

/** The settings value the pickers hold: a list field as its list, a single field as its value; empty fields left out. */
export function pickedSettings(picks: readonly SettingsPick[], values: Readonly<Record<string, readonly string[]>>): Record<string, Json> {
  return Object.fromEntries(picks.flatMap((pick): [string, Json][] => {
    const picked = values[pick.key] ?? [];
    if (picked.length === 0) { return []; }
    return [[pick.key, pick.many ? [...picked] : picked[0] ?? '']];
  }));
}

/** Build 9: one instance of an instance-scoped system (an MCP server, an API service) as its card shows it. */
export interface InstanceCard {
  /** What it is to: an instance of an instance-scoped system, or a key of a key-scoped one (an API service). */
  readonly target: ConnectTarget;
  /** Its instance or key, as one text (the card's key in a list). */
  readonly id: string;
  readonly label: string;
  readonly connect: InstanceConnect;
  /** The person's own connection to it: the newest, if any. */
  readonly own: ConnectionView | undefined;
  /** Connections to it others shared with the person (a shared sign-in an admin made). */
  readonly shared: readonly ConnectionView[];
  /** What connecting asks for: a sign-in in the browser, a form, or nothing (its calls need no connection). */
  readonly flow: 'oauth' | 'form' | 'none';
  /** Whether the person may connect it: anyone for their own; only an admin for a sign-in shared with everyone. */
  readonly mayConnect: boolean;
}

/** What a card connects to: an instance (`ConnectDecl.scope: 'instance'`) or a key (`scope: 'key'`, an API service). */
export type ConnectTarget = { readonly instance: InstanceName } | { readonly key: ConnectKey };

/** Whether a connection is to a target. */
function isTo(connection: ConnectionView, target: ConnectTarget): boolean {
  return 'key' in target ? connection.key === target.key : connection.instance === target.instance;
}

/** Whether a page is connected to a target at a time (its instances or keys) rather than as a whole. */
export function scopedPage(page: Pick<ConnectPage, 'decl'>): boolean {
  return page.decl.scope === 'instance' || page.decl.scope === 'key';
}

/** The cards of an instance- or key-scoped page, in label order; empty for a page connected to as a whole. */
export function instanceCards(page: ConnectPage, me: ActorId | undefined, isAdmin: boolean): InstanceCard[] {
  const newest = [...page.connections].sort((a, b) => b.updatedAt - a.updatedAt);
  const targets: Array<Pick<InstanceCard, 'target' | 'id' | 'label' | 'connect'>> = [
    ...(page.instances ?? []).map((entry) => ({ target: { instance: entry.instance }, id: entry.instance, label: entry.label, connect: entry.connect })),
    ...(page.keys ?? []).map((entry) => ({ target: { key: entry.key }, id: entry.key, label: entry.label, connect: entry.connect })),
  ];
  return targets.map((entry) => {
    const mine = newest.filter((c) => isTo(c, entry.target));
    const flow: InstanceCard['flow'] = entry.connect.flow?.flow ?? 'none';
    return {
      ...entry,
      own: mine.find((c) => c.owner === me),
      shared: mine.filter((c) => c.owner !== me),
      flow,
      mayConnect: flow !== 'none' && (!entry.connect.share || isAdmin),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}
