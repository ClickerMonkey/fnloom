/**
 * The browsers' rules: how an LLM call's status looks, and the numbers a row shows (time to first token, how long it
 * took).
 */
import type { LlmStatus, LlmSummary } from '@harness/core';
import type { StatusLook } from './systems.ts';

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
