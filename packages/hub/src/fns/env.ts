/** The fns module's tunables (search, examples, facts and browser logs), as an `@ayepi/env` slice. Durations are milliseconds. */
import { env } from '@ayepi/env';
import { z } from 'zod';

export const fnsEnv = env({
  HARNESS_FN_SEARCH_LIMIT: z.number().int().min(1).max(100).default(20).describe('How many fns and context items a search returns when the asker doesn\'t say.'),
  HARNESS_FN_SEARCH_NICHE_WEIGHT: z.number().min(0).max(1).default(0.5).describe('What the rank of a developer, admin or reference hit is multiplied by when the search does not name its niche (`FnSearchQuery.niches`), so an ordinary request finds what it needs first; 1 ranks it like the rest.'),
  HARNESS_SEARCH_DECISION_TIMEOUT: z.number().int().min(500).default(15_000).describe('How long the search decision model (or LLM) an admin chose has to filter one page of hits of a kind before every hit is kept.'),
  HARNESS_SEARCH_LOAD_MAX: z.number().int().min(0).max(20).default(5).describe('With a search decision whose action is `load`, the most kept hits `hub/fns_search` (fns) and `hub/ctx_search` (context) each load into the chat, best first.'),
  HARNESS_FN_SEARCH_CANDIDATES: z.number().int().min(10).default(5_000).describe('The most items a filtered search ranks by words and meaning; filters that let more through rank the whole index instead.'),
  HARNESS_FN_PROMPT_EXAMPLES: z.number().int().min(0).max(20).default(2).describe('How many examples of a fn go into the prompt with it when the fn doesn\'t say (`FnDecl.promptExamples`), the most relevant to the turn first.'),
  HARNESS_FN_EXAMPLES_PAGE: z.number().int().min(1).max(50).default(10).describe('How many examples a `hub/fns_examples` page holds when the asker doesn\'t say.'),
  HARNESS_FN_ESTIMATE_TIMEOUT: z.number().int().min(100).default(5_000).describe('How long the system of a kind may take to estimate what a fn of the kind costs, before the history is used instead.'),
  HARNESS_FN_LONG_RUNNING: z.number().int().min(1_000).default(60_000).describe('A fn whose typical run takes longer than this is long-running: the chat says how long it usually takes.'),
  HARNESS_FN_FACTS_DEPTH: z.number().int().min(1).max(20).default(8).describe('How deep the fns a fn uses are followed when its facts are worked out.'),
  HARNESS_FN_HISTORY_DAYS: z.number().int().min(1).max(365).default(30).describe('How many days of run history cost and time estimates read.'),
  HARNESS_AUTO_CLASSIFIER_WAIT: z.number().int().min(1_000).default(20_000).describe('The longest the auto mode classifier is waited for; past it (or on an error) the call waits for the person.'),
  HARNESS_CLIENT_LOG_MAX_BYTES: z.number().int().min(1_024).default(1_048_576).describe('The largest a person\'s browser log file grows before the next lines start a new one.'),
  HARNESS_CLIENT_LOG_QUIET: z.number().int().min(1_000).default(300_000).describe('After this long without a line from a person\'s browser, the next line starts a new log file.'),
});

/** The parsed fns tunables. */
export type FnsTuning = ReturnType<typeof fnsEnv.parse>;
