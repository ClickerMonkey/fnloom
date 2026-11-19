/** What a chat's model has been told about the systems (`Session.announcedSystems`, `TurnStart.announcedSystems`). */
import { z } from 'zod';
import { SystemName } from '../primitives.ts';

/**
 * Why a system the model was told about can't be used in a chat now: switched off in this chat, switched off by an
 * admin, not connected, waiting for a config, waiting for an admin's review, or removed (or no longer shared).
 */
export const SystemOffReason = z.enum(['chat', 'admin', 'disconnected', 'needs-config', 'held', 'removed']);
export type SystemOffReason = z.infer<typeof SystemOffReason>;

/** A system as the model is told about it: its name, its label for people, and what it does. */
export const AnnouncedSystem = z.object({ name: SystemName, label: z.string(), description: z.string() });
export type AnnouncedSystem = z.infer<typeof AnnouncedSystem>;

/**
 * What a chat's model has been told about the systems. `prompt` is the set available at the chat's first turn, which
 * the system prompt lists as it was, so the prompt stays the same (and caches). `on` and `off` are the state as of the
 * last message: each later message that finds them changed says so in `<systems_changed>` and they are updated.
 */
export const AnnouncedSystems = z.object({
  prompt: z.array(AnnouncedSystem),
  on: z.array(SystemName),
  off: z.array(z.object({ name: SystemName, why: SystemOffReason })),
});
export type AnnouncedSystems = z.infer<typeof AnnouncedSystems>;

/** One system that went on or off since the model was last told, with why in plain words. */
export const SystemChange = z.object({
  name: SystemName,
  reason: z.string(),
  /** For a system turned on that the system prompt doesn't list: what the model needs to know about it. */
  label: z.string().optional(),
  description: z.string().optional(),
});
export type SystemChange = z.infer<typeof SystemChange>;
