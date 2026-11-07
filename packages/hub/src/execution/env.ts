/**
 * The execution module's own tunables, as an `@ayepi/env` slice with defaults in the schema. The queue sizes, tool
 * timeout, default priority, turn budget and budget margin it shares with the rest of the hub are in `queueEnv`
 * (`boot/env.ts`). Durations are milliseconds.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Rate limits, budget tolerance and retry pacing for runs and LLM calls. */
export const executionEnv = env({
  /** Most LLM calls that may start in one window, across every model. */
  HARNESS_LLM_RATE_LIMIT: z.number().int().min(1).default(600),
  /** Most LLM calls that may start in one window on any one model. */
  HARNESS_MODEL_RATE_LIMIT: z.number().int().min(1).default(120),
  /** The window both LLM rate limits count over. */
  HARNESS_LLM_RATE_WINDOW: z.number().int().min(1_000).default(60_000),
  /** How far past a budget a call may go (a fraction of the budget), so an estimate a little low never blocks. */
  HARNESS_BUDGET_OVERRUN: z.number().min(0).max(1).default(0.05),
  /** How long a call waits before checking again when a budget whose rule says `wait` is full. */
  HARNESS_BUDGET_RECHECK: z.number().int().min(1_000).default(60_000),
  /** The first delay before a failed run classed `retry` runs again (doubled on each retry). */
  HARNESS_RUN_RETRY_BASE: z.number().int().min(10).default(1_000),
  /** How often the queues look for due work when idle. */
  HARNESS_QUEUE_POLL: z.number().int().min(1).default(250),
  /** Consecutive iterations whose tool calls all fail before an agent run stops. */
  HARNESS_AGENT_TOOL_FAILURES: z.number().int().min(1).default(4),
});

/** The parsed execution settings. */
export type ExecutionEnv = ReturnType<typeof executionEnv.parse>;
