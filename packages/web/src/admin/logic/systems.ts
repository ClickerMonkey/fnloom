/**
 * How systems read on the admin pages: each status's tone and words, which lifecycle actions apply to a system now,
 * why a fn can't be used in plain words, and the order systems are listed in (what needs the admin first).
 */
import type { AutoPairView, Availability, FnUnavailable, InstalledStatus, PairingRequest, SystemStatus, SystemView } from '@harness/core';
import type { Tone } from '../../ui/index.ts';

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

/** Which actions apply to a system now. Only installed systems start, stop and upgrade; only connected ones reimport. */
export function systemActions(system: Pick<SystemView, 'status' | 'installed'>): ReadonlySet<SystemAction> {
  const actions = new Set<SystemAction>();
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
