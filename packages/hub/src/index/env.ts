/**
 * The index's tunables, as an `@ayepi/env` slice (the embedder names, batch size and suggestion count are
 * in boot's `modelEnv`; vector dimensions come from the embedder's declaration). Durations are milliseconds.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';
import { MAX_PICTURE_BYTES } from './indexer.ts';

export const indexEnv = env({
  HARNESS_EMBED_WAIT: z.number().int().min(0).default(15).describe('How long an embed batch waits for more texts after its first before it is sent.'),
  HARNESS_EMBED_POLL: z.number().int().min(1).default(10).describe('How often the embed queues look for new texts.'),
  HARNESS_EMBED_INTERACTIVE: z.number().int().min(1).default(2).describe('How many embed batches for people and agents waiting now (search, suggestions) run at once.'),
  HARNESS_EMBED_BACKGROUND: z.number().int().min(1).default(1).describe('How many embed batches for indexing and systems run at once; the rest wait, so the embedder stays free for people.'),
  HARNESS_INDEX_MAX_TEXT: z.number().int().min(100).default(4_000).describe('The most characters of a section, fn or context that are embedded.'),
  HARNESS_SEARCH_OVERFETCH: z.number().int().min(1).default(3).describe('How many extra candidates search asks for when it filters by system.'),
  HARNESS_SEARCH_EMBED_WAIT: z.number().int().min(0).default(4_000).describe('The longest search waits for its query\'s embedding (a busy embedder may be indexing) before it searches by words alone.'),
  HARNESS_INDEX_EMBED_BATCH: z.number().int().min(1).default(16).describe('How many index rows are embedded and saved together in a catch-up (at most HARNESS_EMBED_BATCH, so a chunk is one embed call); each chunk is saved as it lands, so a failure loses at most one, and a failure halves the next chunks until a catch-up gets through. Small enough that a busy embedder answers one within its timeout.'),
  HARNESS_INDEX_RETRY: z.number().int().min(1).default(5_000).describe('How long after a failed embedding the index first tries again; the wait doubles after each failure.'),
  HARNESS_INDEX_RETRY_MOST: z.number().int().min(1).default(300_000).describe('The longest the index waits before trying a failed embedding again.'),
  HARNESS_INDEX_IMAGE_MAX: z.number().int().min(1).default(MAX_PICTURE_BYTES).describe('The most bytes of a picture the image space embeds; a larger one is indexed by its caption alone.'),
  HARNESS_INDEX_CRAWL_MAX: z.number().int().min(1).default(20_000).describe('The most resources one crawl of a root (on connect, for roots that index everything) looks at.'),
});

/** The parsed index tunables. */
export type IndexTuning = ReturnType<typeof indexEnv.parse>;
