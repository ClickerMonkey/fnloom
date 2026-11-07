/**
 * The live tests' tunables (`*.live.test.ts` and the e2e suite): which free OpenRouter models they call, the key, and
 * the local embedder. One slice, so no test holds a model id of its own.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

export const liveEnv = env({
  /** The OpenRouter key; live tests skip without it. */
  OPENROUTER_API_KEY: z.string().optional(),
  /** The free model tried first. */
  HARNESS_LIVE_MODEL: z.string().default('nvidia/nemotron-3.5-super-vl:free'),
  /** Free models tried, in order, when the first is busy or rate limited. */
  HARNESS_LIVE_FALLBACKS: z.string().default('nvidia/nemotron-3-ultra-550b-a55b:free,dots-studio/dots-3-note-preview:free'),
  /** The EmbeddingGemma service the embedder tests call. */
  HARNESS_LIVE_EMBEDDER_URL: z.string().default('http://127.0.0.1:8760'),
});

/** The free models to try, first choice first. */
export function liveModels(): string[] {
  return [liveEnv.get('HARNESS_LIVE_MODEL'), ...liveEnv.get('HARNESS_LIVE_FALLBACKS').split(',').map((m) => m.trim()).filter((m) => m !== '')];
}
