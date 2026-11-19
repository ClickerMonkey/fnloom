/** Resources, sections and the search index, as the hub keeps them; and notifications. */
import { z } from 'zod';
import { ActorId, ApprovalId, NotificationId, PairingId, PushId, QualifiedName, RunId, SectionRuleId, SessionId, SystemName, Timestamp } from '../primitives.ts';
import { ContentRef, FormKind, ResourceLink, ResourceStat, ResourceUri, SectionKey, SectionMatch } from '../resources.ts';
import { ResourceSource } from '../resource-forms.ts';

/** The hub's row for a resource. */
export const ResourceRecord = z.object({
  uri: ResourceUri,
  system: SystemName,
  stat: ResourceStat,
  links: z.array(ResourceLink),
  indexedVersion: z.string().optional(),
  sectioner: QualifiedName.optional(),
  /** Where it came from; absent means served by `system`. */
  source: ResourceSource.optional(),
  /** Its raw content in the hub's content store: the only copy for hub resources, a snapshot for system ones. */
  raw: ContentRef.optional(),
  /** The forms made from the current raw content, for the browser's badges. */
  forms: z.array(FormKind).optional(),
  /** The form sectioning, the index and the LLM read by default. */
  primary: FormKind.optional(),
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

/**
 * What the hub indexes. A `contextSection` is one heading section of a context item's text, keyed
 * `<context name>#<section key>` (`IndexEntry.parent` names the item), so search covers content past the item's own
 * indexed text and says which section matched. An `image` is a picture: an image resource (keyed by its URI) or one a
 * context item shows (`<context name>#image:<hash>`, its `parent` the item). Its vector is in the image vector space,
 * and it is indexed only while one is set up (`IndexEntry.image` says where its picture is).
 */
export const INDEXED_KINDS = ['fn', 'context', 'section', 'message', 'type', 'example', 'record', 'contextSection', 'image'] as const;
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
  /** The item a part belongs to (a `contextSection`'s context item), so its parts are found and dropped with it. */
  parent: z.string().optional(),
  /**
   * An `image` item's picture: the resource URI whose bytes are read when it is embedded, or the http(s) URL a context
   * item shows. Its `text` (a caption: names, alt text) is what words find.
   */
  image: z.string().optional(),
});
export type IndexEntry = z.infer<typeof IndexEntry>;

/** Which index found a hit: its words (full text), its meaning (vectors), or both. */
export const SEARCH_MATCHED_BY = ['words', 'meaning', 'both'] as const;
export const SearchMatchedBy = z.enum(SEARCH_MATCHED_BY);
export type SearchMatchedBy = z.infer<typeof SearchMatchedBy>;

/**
 * One search hit, from vectors, words, or both, with one field per meaning of its score (the fused rank and the
 * similarity are on different scales, so neither stands in for the other):
 * - `rank`: its place in this search's order as a share of the best (1 = first, falling with each place); always set,
 *   for ordering only, since the first hit of any search ranks 1 however poorly it fits.
 * - `similarity`: how close its meaning is to the query (cosine, 0 to 1), when the query's vector was searched and the
 *   item has a vector; the only measure of fit, so every threshold (suggestions, the graph contextor) reads it.
 */
export const SearchHit = z.object({
  kind: IndexedKind,
  key: z.string(),
  rank: z.number().min(0).max(1),
  similarity: z.number().min(-1).max(1).optional(),
  /** Which index found it: the words, the meaning, or both. */
  matched: SearchMatchedBy.optional(),
  /** The item it is a part of (`IndexEntry.parent`), for a `contextSection`. */
  parent: z.string().optional(),
  text: z.string(),
});
export type SearchHit = z.infer<typeof SearchHit>;

// ─── Notifications ────────────────────────────────────────────────────────────

/** Why someone is notified. */
export const NotificationReason = z.enum([
  'approval-needed', 'input-needed', 'config-needed', 'message', 'replied', 'turn-finished', 'turn-failed', 'pairing-requested', 'system-disconnected', 'spend-limit',
  /** A system kept going past what it declared and was paused. */
  'system-paused',
  /** A system told the admins something (`notifyAdmins`). */
  'system-notice',
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
