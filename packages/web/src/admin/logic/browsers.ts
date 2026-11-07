/**
 * The browsers' rules: a filter read from the URL through its schema (each field on its own, so one bad value drops
 * only itself), how an LLM call's status looks, and the numbers a row shows (time to first token, how long it took).
 */
import type { LlmStatus } from '@harness/core';
import type { z } from 'zod';
import type { StatusLook } from './systems.ts';
import type { LlmSummary } from '../contract.ts';

/** A filter from text values (the URL's query): every field that reads as valid, the rest left out. */
export function filterOf<S extends z.ZodObject>(schema: S, values: Readonly<Record<string, string>>): z.output<S> {
  const shape: Readonly<Record<string, z.ZodType>> = schema.shape;
  const picked: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    const value = values[key]?.trim() ?? '';
    if (value !== '' && field.safeParse(value).success) { picked[key] = value; }
  }
  return schema.parse(picked);
}

/** Every LLM call status's look. */
export const LLM_STATUS_LOOK = {
  queued: { tone: 'neutral', word: 'Queued', live: true },
  streaming: { tone: 'accent', word: 'Streaming', live: true },
  done: { tone: 'ok', word: 'Done', live: false },
  failed: { tone: 'danger', word: 'Failed', live: false },
  aborted: { tone: 'neutral', word: 'Stopped', live: false },
} as const satisfies Record<LlmStatus, StatusLook>;

/** How long an LLM call waited before its first token, and how long it took in all (ms); absent until known. */
export function llmTimes(call: Pick<LlmSummary, 'queuedAt' | 'startedAt' | 'firstTokenAt' | 'endedAt'>, now: number): { readonly firstToken?: number; readonly total?: number } {
  const start = call.startedAt ?? call.queuedAt;
  return {
    ...(call.firstTokenAt === undefined ? {} : { firstToken: call.firstTokenAt - start }),
    ...(call.startedAt === undefined ? {} : { total: (call.endedAt ?? now) - call.startedAt }),
  };
}

/** How often a live browser asks for its first page again (ms). */
export const BROWSER_REFRESH = 4_000;
