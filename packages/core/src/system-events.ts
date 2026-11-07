/**
 * Hub events a system can subscribe to (`Manifest.events`), sent over the link with `event`. Each event's shape is
 * derived from the record it reports on, so changing that record changes, or breaks, what systems hear.
 */
import { z } from 'zod';
import type { SystemEventType } from './manifest.ts';
import { QualifiedName, RunId, SystemName } from './primitives.ts';
import { ChatMessage } from './records/chat.ts';
import { SystemStatus } from './records/systems.ts';
import { ResourceChange } from './resources.ts';
import { RunUpdate } from './run.ts';

/** A finished message as systems see it: the message without its parts, runs and answerers, and its text parts joined. */
export const MessageView = ChatMessage.pick({ id: true, session: true, author: true, role: true, replyTo: true, replyAll: true, createdAt: true }).extend({
  text: z.string(),
});
export type MessageView = z.infer<typeof MessageView>;

/** The system statuses other systems hear about: those that change whether its fns can be reached. */
export const HeardSystemStatus = SystemStatus.extract(['connected', 'disconnected', 'removed']);
export type HeardSystemStatus = z.infer<typeof HeardSystemStatus>;

/** Whether systems hear about a system entering this status. */
export function isHeardSystemStatus(status: SystemStatus): status is HeardSystemStatus {
  return HeardSystemStatus.safeParse(status).success;
}

/** Hub events a system can subscribe to. */
export const SystemEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: MessageView }),
  z.object({ type: z.literal('run'), run: RunId, fn: QualifiedName, update: RunUpdate }),
  z.object({ type: z.literal('resources'), changes: z.array(ResourceChange) }),
  z.object({ type: z.literal('system'), system: SystemName, status: HeardSystemStatus }),
  z.object({ type: z.literal('fns'), added: z.array(QualifiedName), removed: z.array(QualifiedName) }),
]);
export type SystemEvent = z.infer<typeof SystemEvent>;

/** Both ways round, so each type is the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Every event type a manifest can subscribe to has exactly one event shape, and no event lacks a type to subscribe by.
true satisfies Same<SystemEvent['type'], SystemEventType>;
