/**
 * Resource search for an `@` mention (build 8). When the hub asks a system for mention options (`mentions` on the
 * system link), it mints a `MentionRequestId` tied to the asking person and session, valid for
 * `HARNESS_MENTION_REQUEST_TTL`. The system may then search the hub's resources for that request
 * (`mentionResources` on the hub link), and the hub runs the search as that person: a system can only search for the
 * person it was asked about, and only while the request is fresh. This replaces the web system's in-memory recent pages.
 */
import { z } from 'zod';
import { IDS } from './primitives.ts';
import { ResourceHit, ResourceUri } from './resources.ts';

/** One `@` search the hub sent a system. */
export const MentionRequestId = IDS.mentionRequest;
export type MentionRequestId = z.infer<typeof MentionRequestId>;

/** A system's resource search for a mention request: the text, optional roots to stay inside, and how many hits. */
export const MentionResourceSearch = z.object({
  request: MentionRequestId,
  query: z.string(),
  roots: z.array(ResourceUri).max(20).optional(),
  limit: z.number().int().min(1).max(50),
});
export type MentionResourceSearch = z.infer<typeof MentionResourceSearch>;

/** The hits, best first, as the person sees them. */
export const MentionResourceHits = z.object({ hits: z.array(ResourceHit) });
export type MentionResourceHits = z.infer<typeof MentionResourceHits>;
