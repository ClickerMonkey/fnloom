/**
 * The live tests' tunables (`*.live.test.ts` and the e2e suite): which OpenRouter models they call, the key, and
 * the local embedder. One slice, so no test holds a model id of its own.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

export const liveEnv = env({
  /** The OpenRouter key; live tests skip without it. */
  OPENROUTER_API_KEY: z.string().optional(),
  /** The model tried first: GPT-6 Luna, cheap and paid (the owner's choice, 2026-11-13, once the free models' daily limit ran out). */
  HARNESS_LIVE_MODEL: z.string().default('openai/gpt-6-luna'),
  /** Models tried, in order, when the first is busy or rate limited (none by default). */
  HARNESS_LIVE_FALLBACKS: z.string().default(''),
  /** The EmbeddingGemma service the embedder tests call. */
  HARNESS_LIVE_EMBEDDER_URL: z.string().default('http://127.0.0.1:8760'),
});

/** The models to try, first choice first. */
export function liveModels(): string[] {
  return [liveEnv.get('HARNESS_LIVE_MODEL'), ...liveEnv.get('HARNESS_LIVE_FALLBACKS').split(',').map((m) => m.trim()).filter((m) => m !== '')];
}
