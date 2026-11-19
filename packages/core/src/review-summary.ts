/**
 * What a set of contract changes amounts to, in one strip: counts per section ("+3 fns, 1 changed"), what happened to
 * the grants and the config type, and the risk flags an admin should read first (new write or delete fns, new
 * effects, new hub calls, hosts, secrets, models, fns or paths it may reach). The hub works it out (`reviewSummary`)
 * for a pending review and for an install card, so the review page and the chat's install card say the same thing.
 * Kept free of the manifest's schemas so approval previews can carry it.
 */
import { z } from 'zod';

/** The risk flags, most serious first. */
export const REVIEW_FLAGS = ['delete-fns', 'write-fns', 'effects', 'capabilities', 'secrets', 'hosts', 'files', 'calls', 'models'] as const;
export const ReviewFlagKind = z.enum(REVIEW_FLAGS);
export type ReviewFlagKind = z.infer<typeof ReviewFlagKind>;

/** One risk flag: what it is, in one line, and the items (fn names, hosts, secret names) it is about. */
export const ReviewFlag = z.object({
  flag: ReviewFlagKind,
  /** "New delete fns: notes/purge". */
  line: z.string().min(1),
  items: z.array(z.string().min(1)),
});
export type ReviewFlag = z.infer<typeof ReviewFlag>;

/** How many items of one section were added, changed and removed. */
export const ReviewCount = z.object({
  /** An item section (`fns`, `context`, ...), or `grants` / `config` as a whole. */
  section: z.string().min(1),
  added: z.number().int().min(0),
  changed: z.number().int().min(0),
  removed: z.number().int().min(0),
});
export type ReviewCount = z.infer<typeof ReviewCount>;

/** What happened to the grants: more allowed, less allowed, both, or new (nothing was granted before). */
export const GrantsMove = z.enum(['widened', 'narrowed', 'changed', 'added']);
export type GrantsMove = z.infer<typeof GrantsMove>;

/** A set of contract changes in one strip. */
export const ReviewSummary = z.object({
  /** One line: "+3 fns, 1 changed, grants widened, config type changed". */
  line: z.string(),
  counts: z.array(ReviewCount),
  flags: z.array(ReviewFlag),
  grants: GrantsMove.optional(),
  /** Whether the config type itself was added, changed or removed. */
  config: z.enum(['added', 'changed', 'removed']).optional(),
});
export type ReviewSummary = z.infer<typeof ReviewSummary>;
