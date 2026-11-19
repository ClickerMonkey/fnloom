/**
 * What a chat's model is told about the systems. At the chat's first turn the systems available to the person in that
 * chat are snapshotted (`Session.announcedSystems`), and the system prompt lists that set as it was, in name order, so
 * the prompt stays the same turn after turn and caches. Each later message compares what is available now (the
 * person's toggles in the chat, an admin switching a system off or on, a disconnect or reconnect, an install or a
 * removal) with what the model was last told; what changed goes before the person's words in `<systems_changed>`, once,
 * and the snapshot follows. Every element is made by the one XML module (`contextor/xml.ts`).
 */
import { labelFor, SystemStatus, type AnnouncedSystem, type AnnouncedSystems, type MessagePart, type Session, type SystemChange, type SystemName, type SystemOffReason, type SystemRecord } from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import { HUB_SYSTEM, systemAvailability } from '../catalog/availability.ts';
import { cardList, element } from '../contextor/xml.ts';
import type { HubStore } from '../store/index.ts';
import { allRows } from '../store/rows.ts';
import { allowsSystem } from './support.ts';

/** The part that tells the model what changed. */
export type SystemsChangedPart = Extract<MessagePart, { type: 'systems-changed' }>;

/** The systems as they are now for a person in a chat: the ones on (name order), and why each other one is off. */
export interface SystemsNow {
  readonly on: readonly AnnouncedSystem[];
  readonly off: ReadonlyArray<{ readonly name: SystemName; readonly why: SystemOffReason }>;
}

/** The tag the system prompt lists the systems in, and the one a message's changes are in. */
export const SYSTEMS_TAG = 'systems';
export const SYSTEMS_CHANGED_TAG = 'systems_changed';

/** The line at the top of the system prompt's `<systems>`. */
export const SYSTEMS_INTRO = `The systems you can use in this chat and what each does. When one is turned on or off later, the person's message starts with <${SYSTEMS_CHANGED_TAG}> saying which and why.`;

/** Why a system is off, as the model reads it. */
export const OFF_REASONS: Readonly<Record<SystemOffReason, string>> = {
  chat: 'turned off in this chat',
  admin: 'switched off by an admin',
  disconnected: 'disconnected',
  'needs-config': 'needs a valid config',
  held: 'waits for an admin to review it',
  removed: 'removed',
};

/** Why a system is on again, by why it was off before (`new`: the model never heard of it). */
export const ON_REASONS: Readonly<Record<SystemOffReason | 'new', string>> = {
  chat: 'turned on in this chat',
  admin: 'switched on by an admin',
  disconnected: 'reconnected',
  'needs-config': 'configured',
  held: 'approved by an admin',
  removed: 'installed',
  new: 'installed',
};

/** Every status but `removed`: a removed system is gone, as if it had never been. */
const PRESENT = SystemStatus.exclude(['removed']).options;

/** Why a present system is off for a chat, or undefined when it is on. */
export function offReason(record: SystemRecord, session: Pick<Session, 'systems'>): SystemOffReason | undefined {
  if (!allowsSystem(session, record.name)) return 'chat';
  if (!record.enabled.functions) return 'admin';
  const available = systemAvailability(record.name, record);
  if (available === true) return undefined;
  switch (available.unavailable) {
    case 'system-needs-config': return 'needs-config';
    case 'held': return 'held';
    case 'system-removed': return 'removed';
    case 'disabled': case 'paused': case 'role-unset': return 'admin';
    // a system's own availability is never these fn-level codes; any of them reads as not reachable
    case 'system-disconnected': case 'kind-missing': case 'kind-system-disconnected': case 'dep-unavailable': return 'disconnected';
  }
}

/**
 * The systems as they are now for a person in a chat, read from the hub database in name order: every system they may
 * see except the hub itself (always there), on or off with why. A removed system, or one no longer shared with them,
 * is left out.
 */
export async function systemsNow(store: Pick<HubStore, 'table'>, access: Pick<AccessScope, 'seesSystem'>, session: Pick<Session, 'systems'>): Promise<SystemsNow> {
  const rows = await allRows(store.table('systems'), { where: { status: { in: PRESENT } }, order: [['name', 'asc']] });
  const on: AnnouncedSystem[] = [];
  const off: Array<{ name: SystemName; why: SystemOffReason }> = [];
  for (const row of rows) {
    if (row.name === HUB_SYSTEM || !access.seesSystem(row.name)) continue;
    const why = offReason(row, session);
    if (why === undefined) on.push({ name: row.name, label: labelFor(row), description: row.description });
    else off.push({ name: row.name, why });
  }
  return { on, off };
}

/**
 * What a message tells the model about the systems, and the snapshot after it. With no snapshot yet (the first turn)
 * the snapshot is taken and nothing is said: the system prompt lists the set. Afterwards each system on now that wasn't
 * is announced on (with its label and description when the system prompt doesn't list it), each one on before and not
 * now announced off, each with why; a system the prompt lists that stays off for a new reason (disconnected, then
 * switched off by an admin) is announced off again with the new why (Phil: announce all changes). An off reason
 * changing for a system the prompt doesn't list is kept without a word: the model never heard of it. `announced` is absent when the snapshot stays as it was.
 */
export function announce(previous: AnnouncedSystems | undefined, now: SystemsNow): { announced?: AnnouncedSystems; changed?: SystemsChangedPart } {
  const state = { on: now.on.map((s) => s.name), off: now.off.map((o) => ({ name: o.name, why: o.why })) };
  if (previous === undefined) return { announced: { prompt: [...now.on], ...state } };
  const wasOn = new Set<string>(previous.on);
  const wasOff = new Map<string, SystemOffReason>(previous.off.map((o) => [o.name, o.why]));
  const prompted = new Set<string>(previous.prompt.map((s) => s.name));
  const isOn = new Set<string>(state.on);
  const offNow = new Map<string, SystemOffReason>(state.off.map((o) => [o.name, o.why]));
  const on = now.on.filter((s) => !wasOn.has(s.name)).map((s): SystemChange => ({
    name: s.name, reason: ON_REASONS[wasOff.get(s.name) ?? 'new'], ...(prompted.has(s.name) ? {} : { label: s.label, description: s.description }),
  }));
  // off now and on before; or off before and still off for a new reason, when the system prompt lists it (the model
  // was told it is off for one reason, and it is now off for another: an admin switched it off while it was away)
  const reasonChanged = (name: string): boolean => prompted.has(name) && wasOff.has(name) && offNow.has(name) && wasOff.get(name) !== offNow.get(name);
  const off = [...previous.on.filter((name) => !isOn.has(name)), ...state.off.map((o) => o.name).filter(reasonChanged)].toSorted()
    .map((name): SystemChange => ({ name, reason: OFF_REASONS[offNow.get(name) ?? 'removed'] }));
  const same = JSON.stringify(state) === JSON.stringify({ on: previous.on, off: previous.off.map((o) => ({ name: o.name, why: o.why })) });
  return {
    ...(same ? {} : { announced: { prompt: previous.prompt, ...state } }),
    ...(on.length === 0 && off.length === 0 ? {} : { changed: { type: 'systems-changed', on, off } }),
  };
}

/** The system prompt's `<systems>` list; empty with no systems. */
export function systemsPrompt(systems: readonly AnnouncedSystem[]): string {
  return cardList(SYSTEMS_TAG, SYSTEMS_INTRO, systems.map((s) => element('system', { name: s.name, label: s.label }, [s.description])));
}

/** A message's `<systems_changed>`: the systems turned on, then those turned off, each with why. */
export function systemsChanged(part: Pick<SystemsChangedPart, 'on' | 'off'>): string {
  return element(SYSTEMS_CHANGED_TAG, {}, [
    ...part.on.map((c) => element('on', { name: c.name, label: c.label, reason: c.reason }, [c.description])),
    ...part.off.map((c) => element('off', { name: c.name, reason: c.reason })),
  ]).toString();
}
