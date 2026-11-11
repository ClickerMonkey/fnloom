/**
 * How systems read on the admin pages: each status's tone and words, which lifecycle actions apply to a system now,
 * why a fn can't be used in plain words, the order systems are listed in (what needs the admin first), and a system's
 * other parts under their headings.
 */
import { SYSTEM_PART_SECTIONS, type AutoPairView, type Availability, type FnUnavailable, type InstalledStatus, type PairingRequest, type QueryFnArgs, type SystemName, type SystemPart, type SystemPartSection, type SystemParts, type SystemStatus, type SystemView } from '@harness/core';
import type { Tone } from '../../ui/index.ts';
import type { PartTab } from '../sections.ts';

/** How a status looks: its tone, its word, and whether it is in motion. */
export interface StatusLook {
  readonly tone: Tone;
  readonly word: string;
  readonly live: boolean;
}

/** Every system status's look. */
export const SYSTEM_STATUS_LOOK = {
  pairing: { tone: 'accent', word: 'Pairing', live: true },
  'needs-config': { tone: 'warn', word: 'Needs config', live: false },
  connected: { tone: 'ok', word: 'Connected', live: true },
  disconnected: { tone: 'neutral', word: 'Offline', live: false },
  removed: { tone: 'danger', word: 'Removed', live: false },
} as const satisfies Record<SystemStatus, StatusLook>;

/** Every installed system process status's look. */
export const INSTALLED_STATUS_LOOK = {
  installing: { tone: 'accent', word: 'Installing', live: true },
  stopped: { tone: 'neutral', word: 'Stopped', live: false },
  starting: { tone: 'accent', word: 'Starting', live: true },
  running: { tone: 'ok', word: 'Running', live: true },
  crashed: { tone: 'danger', word: 'Crashed', live: false },
  disabled: { tone: 'neutral', word: 'Disabled', live: false },
} as const satisfies Record<InstalledStatus, StatusLook>;

/** The lifecycle actions on a system. */
export const SYSTEM_ACTIONS = ['start', 'stop', 'restart', 'upgrade', 'reimport', 'remove'] as const;
export type SystemAction = (typeof SYSTEM_ACTIONS)[number];

/**
 * Which actions apply to a system now. Installed systems start, stop and upgrade; hosted ones (run by another system,
 * such as fs) start, stop and restart through their host; only connected ones reimport.
 */
export function systemActions(system: Pick<SystemView, 'status' | 'installed' | 'host'>): ReadonlySet<SystemAction> {
  const actions = new Set<SystemAction>();
  if (system.host !== undefined) {
    if (system.status === 'connected' || system.status === 'needs-config') { actions.add('stop'); actions.add('restart'); } else if (system.status === 'disconnected') { actions.add('start'); }
  }
  const process = system.installed?.status;
  if (process !== undefined) {
    if (process === 'stopped' || process === 'crashed' || process === 'disabled') { actions.add('start'); }
    if (process === 'running' || process === 'starting') { actions.add('stop'); actions.add('restart'); }
    if (process !== 'installing') { actions.add('upgrade'); }
  }
  if (system.status === 'connected' || system.status === 'needs-config') { actions.add('reimport'); }
  if (system.status !== 'removed') { actions.add('remove'); }
  return actions;
}

/** Why a fn can't be used, in plain words. */
export const UNAVAILABLE_TEXT = {
  'system-needs-config': 'Its system needs config',
  'system-disconnected': 'Its system is offline',
  'system-removed': 'Its system was removed',
  'kind-missing': 'Its kind is gone',
  'kind-system-disconnected': "Its kind's system is offline",
  'dep-unavailable': "A fn it needs can't be used",
  disabled: 'Turned off',
  paused: 'Paused',
} as const satisfies Record<FnUnavailable, string>;

/** '' when it can be used, else why not. */
export function availabilityText(available: Availability): string {
  return available === true ? '' : UNAVAILABLE_TEXT[available.unavailable];
}

const ATTENTION: Readonly<Record<SystemStatus, number>> = { pairing: 0, 'needs-config': 1, disconnected: 2, connected: 3, removed: 4 };

/** Systems in the order the list shows them: needing the admin first, then by name. */
export function sortSystems(systems: readonly SystemView[]): SystemView[] {
  return [...systems].sort((a, b) => {
    const needs = (s: SystemView): number => (s.installed?.status === 'crashed' ? -1 : ATTENTION[s.status]);
    return needs(a) - needs(b) || a.name.localeCompare(b.name);
  });
}

/** Pairing requests still waiting, the soonest to expire first. */
export function pendingPairings(requests: readonly PairingRequest[], now: number): PairingRequest[] {
  return requests.filter((r) => r.status === 'pending' && r.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt);
}

/** How long until `at`, briefly ("4m", "1h 5m", "expired"). */
export function timeLeft(at: number, now: number): string {
  const left = at - now;
  if (left <= 0) { return 'expired'; }
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** A pairing code grouped for reading aloud: "483 912". */
export function groupedCode(code: string): string {
  return code.replace(/\s+/g, '').replace(/(.{3})(?=.)/g, '$1 ');
}

/** Where an auto pair secret stands: usable, past its end, or revoked by an admin. */
export type AutoPairState = 'active' | 'expired' | 'revoked';

/** Where a secret stands now. */
export function autoPairState(secret: Pick<AutoPairView, 'expiresAt' | 'revokedAt'>, now: number): AutoPairState {
  if (secret.revokedAt !== undefined) { return 'revoked'; }
  return secret.expiresAt !== undefined && secret.expiresAt <= now ? 'expired' : 'active';
}

/** How each state shows. */
export const AUTO_PAIR_STATE_LOOK = {
  active: { tone: 'ok', word: 'Active', live: false }, expired: { tone: 'neutral', word: 'Expired', live: false }, revoked: { tone: 'danger', word: 'Revoked', live: false },
} as const satisfies Record<AutoPairState, StatusLook>;

/** When a secret ends, in words: "never ends", "ends in 78 days", "ended 30 days ago". */
export function endsText(expiresAt: number | undefined, now: number): string {
  if (expiresAt === undefined) { return 'never ends'; }
  const days = Math.round(Math.abs(expiresAt - now) / 86_400_000);
  const span = days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'}`;
  if (expiresAt > now) { return days === 0 ? 'ends today' : `ends in ${span}`; }
  return days === 0 ? 'ended today' : `ended ${span} ago`;
}

/** Where a hosted system runs, in words: "fs/main at systems/random". */
export function hostText(host: NonNullable<SystemView['host']>): string {
  return `${host.host.system}/${host.host.instance} at ${host.path}`;
}

/** The hub `contexts` list query for every context item a system declared or added while running, by key, one page. */
export function systemContextQuery(system: SystemName, cursor: string | undefined, limit: number): QueryFnArgs {
  return {
    list: 'contexts',
    query: { filters: [{ field: 'system', op: 'is', value: system }], sort: [{ field: 'name', dir: 'asc' }], limit, ...(cursor === undefined ? {} : { cursor }) },
  };
}

/** The first characters of a version hash, enough to tell two versions apart on a row. */
export function shortVersion(version: string): string {
  return version.length > 8 ? version.slice(0, 8) : version;
}

/** Each group of a system's other parts, as its page heads it. */
export const PART_SECTION_WORDS = {
  kinds: 'Kinds', commands: 'Commands', mentions: 'Mentions', hooks: 'Hooks', actions: 'Actions', settings: 'Settings', attachments: 'Attachments',
  embedders: 'Embedders', sectioners: 'Sectioners', providers: 'Model providers', registries: 'Registries', components: 'Components', examples: 'Examples',
} as const satisfies Record<SystemPartSection, string>;

/** One heading of a system's other parts: its parts, and how many it holds in all when the list is cut short. */
export interface PartGroup {
  readonly section: SystemPartSection;
  readonly parts: readonly SystemPart[];
  readonly total: number;
}

/** A system's other parts under their headings, in the page's order, leaving out empty ones. */
export function partGroups(parts: SystemParts): readonly PartGroup[] {
  return SYSTEM_PART_SECTIONS.flatMap((section) => {
    const listed = parts.parts.filter((part) => part.section === section);
    return listed.length === 0 ? [] : [{ section, parts: listed, total: parts.more[section] ?? listed.length }];
  });
}

/** One choice of the Parts tab: a section with what it holds. */
export interface PartChoice {
  readonly value: PartTab;
  readonly label: string;
  readonly count: number;
}

/** The Parts tab's choices: its resource roots, then every section that holds something, in the page's order. */
export function partChoices(groups: readonly PartGroup[], roots: number): readonly PartChoice[] {
  return [
    ...(roots > 0 ? [{ value: 'roots' as const, label: 'Resource roots', count: roots }] : []),
    ...groups.map((group) => ({ value: group.section, label: PART_SECTION_WORDS[group.section], count: group.total })),
  ];
}

/** The choice shown: the one asked for when it holds something, else the first. */
export function shownPart(choices: readonly PartChoice[], asked: PartTab): PartTab | undefined {
  return choices.some((choice) => choice.value === asked) ? asked : choices[0]?.value;
}
