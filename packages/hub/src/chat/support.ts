/** Small helpers the chat services share: a monotonic clock, agent actors, session scoping, paging and system calls. */
import {
  IDS, QualifiedName, splitName, type SystemName, type ActorId, type Json, type ManifestSection, type Participant, type Session, type SessionId,
  type TurnId,
} from '@harness/core';
import { canonicalJson } from '@harness/sdk';
import { HUB_SYSTEM, systemOf } from '../catalog/availability.ts';
import type { Catalog, CatalogEntry } from '../catalog/index.ts';
import type { SystemConnection, LinkService } from '../link/index.ts';
import { ChatError } from './errors.ts';

// ─── Time ─────────────────────────────────────────────────────────────────────

/**
 * A clock that never repeats or goes back: each reading is at least 1 ms after the last. Messages created in the
 * same millisecond then still sort in the order they were made.
 */
export function monotonic(clock: () => number): () => number {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    last = Math.max(clock(), last + 1);
    return last;
  };
}

// ─── Actors and sessions ──────────────────────────────────────────────────────

/** The actor id of an agent fn. Stable, so every module finds the same actor for the same fn without a lookup. */
export function agentActorId(fn: QualifiedName): ActorId {
  return IDS.actor.parse(`act_agent.${fn}`);
}

/** A person-readable name for an agent fn: `hub/chat` → "Chat", `crm/deal_coach` → "Deal coach". */
export function agentName(fn: QualifiedName): string {
  const words = splitName(fn).local.replace(/[_.-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The scope key for state of a run outside any session: its turn, under a session id no real session has, so
 * sessionless runs keep durable, undoable state like every other run.
 */
export function turnScope(turn: TurnId): SessionId {
  return IDS.session.parse(`ses_turn.${turn}`);
}

/** A name as a qualified name, when it is one (`system/name`). */
export function asQualified(name: string): QualifiedName | undefined {
  const parsed = QualifiedName.safeParse(name);
  return parsed.success ? parsed.data : undefined;
}

/** A session's participant entry for an actor. */
export function participantOf(session: Session, actor: ActorId): Participant | undefined {
  return session.participants.find((p) => p.actor === actor);
}

/** The people (not agents) in a session. */
export function peopleOf(session: Session): Participant[] {
  return session.participants.filter((p) => p.role !== 'agent');
}

/** Whether a session lets a system's fns, context, mentions and hooks apply. The hub's own always do. */
export function allowsSystem(session: Pick<Session, 'systems'>, system: string): boolean {
  return system === HUB_SYSTEM || session.systems === 'all' || session.systems.some((s) => s === system);
}

/** The systems an index search for a session covers: the ones it enables, and always the hub's own. */
export function searchSystems(session: Pick<Session, 'systems'>): readonly SystemName[] | 'all' {
  return session.systems === 'all' ? 'all' : [...new Set<SystemName>([HUB_SYSTEM, ...session.systems])];
}

// ─── Values ───────────────────────────────────────────────────────────────────

/** Whether two JSON values are equal, ignoring key order. Absent equals absent only. */
export function sameJson(a: Json | undefined, b: Json | undefined): boolean {
  if (a === undefined || b === undefined) { return a === b; }
  return canonicalJson(a) === canonicalJson(b);
}

/** Escape text for an attribute of an LLM tag. */
export function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ');
}

/** Escape text inside an LLM tag, so it can't close the tag it is in. */
export function escapeBody(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Markdown as the plain text it reads as, for places that can't render it (notifications, push): code fences and
 * inline code keep their text, links their label, and heading, quote and list markers and emphasis go.
 */
export function unmark(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/gm, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

/** Shorten text to at most `max` characters on a word boundary, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) { return flat; }
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ─── Systems ──────────────────────────────────────────────────────────────────

/** Call a connected system with a deadline; refused as `unavailable` when it isn't connected. */
export async function callSystem<T>(
  link: Pick<LinkService, 'connection'>, system: SystemName, timeout: number, call: (connection: SystemConnection, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const connection = link.connection(system);
  if (connection === undefined) { throw new ChatError('unavailable', `The ${system} system is not connected.`); }
  return call(connection, AbortSignal.any([connection.signal, AbortSignal.timeout(timeout)]));
}

/** One manifest entry by its qualified name, from the catalog. */
export async function entryOf<S extends ManifestSection>(catalog: Pick<Catalog, 'entries'>, section: S, name: QualifiedName): Promise<CatalogEntry<S> | undefined> {
  const system = systemOf(name);
  if (system === undefined) { return undefined; }
  return (await catalog.entries(section, { system })).find((entry) => entry.name === name);
}
