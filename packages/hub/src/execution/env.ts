/**
 * The execution module's own tunables, as an `@ayepi/env` slice with defaults in the schema. The queue sizes, tool
 * timeout, default priority, turn budget and budget margin it shares with the rest of the hub are in `queueEnv`
 * (`boot/env.ts`). Durations are milliseconds.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

/** Rate limits, budget tolerance and retry pacing for runs and LLM calls. */
export const executionEnv = env({
  HARNESS_LLM_RATE_LIMIT: z.number().int().min(1).default(600).describe('Most LLM calls that may start in one window, across every model.'),
  HARNESS_MODEL_RATE_LIMIT: z.number().int().min(1).default(120).describe('Most LLM calls that may start in one window on any one model.'),
  HARNESS_LLM_RATE_WINDOW: z.number().int().min(1_000).default(60_000).describe('The window both LLM rate limits count over.'),
  HARNESS_BUDGET_OVERRUN: z.number().min(0).max(1).default(0.05).describe('How far past a budget a call may go (a fraction of the budget), so an estimate a little low never blocks.'),
  HARNESS_TRANSIENT_TRIES: z.number().int().min(1).max(20).default(3).describe('How many times an LLM call waits out a rate limit or a full budget (the wait it names) before it gives up.'),
  HARNESS_BUDGET_RECHECK: z.number().int().min(1_000).default(60_000).describe('How long a call waits before checking again when a budget whose rule says `wait` is full.'),
  HARNESS_RUN_RETRY_BASE: z.number().int().min(10).default(1_000).describe('The first delay before a failed run classed `retry` runs again (doubled on each retry).'),
  HARNESS_QUEUE_POLL: z.number().int().min(1).default(250).describe('How often the queues look for due work when idle.'),
  HARNESS_VALIDATE_RETRIES: z.number().int().min(0).default(2).describe('How many times in a turn a fn whose output hook refused its result may be tried again before the run stops.'),
  HARNESS_TOOL_RESULT_ROWS: z.number().int().min(0).max(100).default(5).describe('How many rows of a table result (a widget run, a fn returning a table) the model reads after its summary; the person sees the whole table.'),
  HARNESS_HEADLESS_RESULT_ROWS: z.number().int().min(0).max(500).default(50).describe('How many rows of a table result the model reads in a run nobody watches (a nested agent, a background or scheduled run), where no one sees the table and the model answers from these rows.'),
  HARNESS_STREAM_BLANK_RUN: z.number().int().min(64).default(2_000).describe('Blank characters in a row (spaces, newlines, or their JSON escapes) in a tool call\'s arguments or an answer\'s text that make a model stream degenerate: the hub stops it there and the call fails with a note the model can act on (`stream-guard.ts`).'),
  HARNESS_ARGS_CHECK_TIMEOUT: z.number().int().min(100).default(5_000).describe('How long the hub waits for a fn\'s args check (`FnDecl.check`) before the policies; a check that takes longer is logged and the call goes on as if it had none.'),
  HARNESS_AGENT_TOOL_FAILURES: z.number().int().min(1).default(4).describe('Consecutive iterations whose tool calls all fail before an agent run stops.'),
});

/** The parsed execution settings. */
export type ExecutionEnv = ReturnType<typeof executionEnv.parse>;
