/** Resources, sections and the search index, as the hub keeps them; and notifications. */
import { z } from 'zod';
import { ActorId, ApprovalId, NotificationId, PairingId, PushId, QualifiedName, RunId, SectionRuleId, SessionId, SystemName, Timestamp } from '../primitives.ts';
import { ResourceLink, ResourceStat, ResourceUri, SectionKey, SectionMatch } from '../resources.ts';

/** The hub's row for a resource. */
export const ResourceRecord = z.object({
  uri: ResourceUri,
  system: SystemName,
  stat: ResourceStat,
  links: z.array(ResourceLink),
  indexedVersion: z.string().optional(),
  sectioner: QualifiedName.optional(),
  seenAt: Timestamp,
});
export type ResourceRecord = z.infer<typeof ResourceRecord>;

/** A user's choice of sectioner for some resources. More specific matches win; a user's rule beats a system's default. */
export const SectionRule = z.object({ id: SectionRuleId, match: SectionMatch, sectioner: QualifiedName, setBy: ActorId });
export type SectionRule = z.infer<typeof SectionRule>;

/** What changed between two versions of a resource, by section key. Context made from changed sections goes stale. */
export const SectionDiff = z.object({
  uri: ResourceUri,
  from: z.string(),
  to: z.string(),
  added: z.array(SectionKey),
  changed: z.array(SectionKey),
  removed: z.array(SectionKey),
});
export type SectionDiff = z.infer<typeof SectionDiff>;

/** What the hub indexes. */
export const INDEXED_KINDS = ['fn', 'context', 'section', 'message', 'type'] as const;
export const IndexedKind = z.enum(INDEXED_KINDS);
export type IndexedKind = z.infer<typeof IndexedKind>;

/** An indexed item. Vectors live in a table per embedder. */
export const IndexEntry = z.object({
  kind: IndexedKind,
  key: z.string(),
  system: SystemName.optional(),
  text: z.string(),
  /** Hash of `text`, so unchanged items are not embedded again. */
  hash: z.string(),
  /** The `hash` of the text whose vector is stored; absent (or older) while the item waits for an embedder. */
  vectorHash: z.string().optional(),
  embedder: QualifiedName,
  updatedAt: Timestamp,
});
export type IndexEntry = z.infer<typeof IndexEntry>;

/** One search hit, from vectors, words, or both. */
export const SearchHit = z.object({ kind: IndexedKind, key: z.string(), score: z.number(), text: z.string() });
export type SearchHit = z.infer<typeof SearchHit>;

// ─── Notifications ────────────────────────────────────────────────────────────

/** Why someone is notified. */
export const NotificationReason = z.enum([
  'approval-needed', 'input-needed', 'config-needed', 'replied', 'turn-finished', 'turn-failed', 'pairing-requested', 'system-disconnected', 'spend-limit',
]);
export type NotificationReason = z.infer<typeof NotificationReason>;

/** Where a notification leads. */
export const NotificationLink = z.union([
  z.object({ session: SessionId }),
  z.object({ approval: ApprovalId }),
  z.object({ pairing: PairingId }),
  z.object({ run: RunId }),
  z.object({ system: SystemName }),
]);
export type NotificationLink = z.infer<typeof NotificationLink>;

/** An inbox item; pushed (web push) when the user isn't looking. */
export const Notification = z.object({
  id: NotificationId,
  user: ActorId,
  reason: NotificationReason,
  title: z.string(),
  body: z.string(),
  link: NotificationLink,
  read: z.boolean(),
  pushed: z.boolean(),
  /**
   * What became of the thing it asked for, once nobody needs to act on it any more (`Approved`, `Timed out`,
   * `Connected`); such a notification is read, and stays as a record of what happened.
   */
  resolved: z.string().optional(),
  createdAt: Timestamp,
});
export type Notification = z.infer<typeof Notification>;

/** A browser's web push subscription (VAPID; the hub sends pushes itself). */
export const PushSubscription = z.object({
  id: PushId,
  user: ActorId,
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  device: z.string(),
  createdAt: Timestamp,
});
export type PushSubscription = z.infer<typeof PushSubscription>;
