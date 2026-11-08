/** Runs on the wire: who a run is for, how it reports progress, and how it ends. */
import { z } from 'zod';
import {
  ActorId, Duration, InstanceName, Json, Priority, QualifiedName, RunId, SessionId, Timestamp, TurnId, Usd,
} from './primitives.ts';
import { RunText } from './status.ts';
import { Exposure } from './modes.ts';

// ─── Who and when ─────────────────────────────────────────────────────────────

/** The person a turn is for, as every system sees them. Time zone and locale come from their browser. */
export const UserInfo = z.object({
  id: ActorId,
  name: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'member']),
  groups: z.array(z.object({ id: ActorId, name: z.string() })),
  timeZone: z.string(),
  locale: z.string(),
});
export type UserInfo = z.infer<typeof UserInfo>;

/** The current time for the person, so a system never guesses at "today". */
export const TimeInfo = z.object({
  now: Timestamp,
  /** IANA time zone: `America/New_York`. */
  timeZone: z.string(),
  /** Now in the person's zone, with its offset: `2026-11-07T09:30:00-05:00`. */
  local: z.string(),
});
export type TimeInfo = z.infer<typeof TimeInfo>;

/** Which system something is running in, and which system asked for it. */
export const SystemInfo = z.object({
  name: z.string(),
  /** Which copy of the system runs it (`main` for a system that runs one copy). */
  instance: InstanceName,
  /** This process start (new on every start). */
  boot: z.string(),
  /** When another system's fn made the call: that system, fn and run. */
  from: z.object({ system: z.string(), fn: QualifiedName, run: RunId }).optional(),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

/** Facts about one run: what it is, who it is for, when, and where it came from. */
export const RunInfo = z.object({
  id: RunId,
  fn: QualifiedName,
  parent: RunId.optional(),
  turn: TurnId,
  session: SessionId.optional(),
  /** The person the turn is for: permissions and settings are theirs. */
  user: UserInfo,
  time: TimeInfo,
  system: SystemInfo,
  /** Who called: the agent, the user (with `!`), or the parent run's fn. */
  caller: ActorId,
  attempt: z.number().int().min(1),
  priority: Priority,
});
export type RunInfo = z.infer<typeof RunInfo>;

/** What the browser reports with every message and action, so systems get the person's time. */
export const ClientInfo = z.object({
  timeZone: z.string(),
  locale: z.string(),
  /** The browser's clock, to catch a wrong system clock. */
  now: Timestamp,
});
export type ClientInfo = z.infer<typeof ClientInfo>;

// ─── Declared behaviour ───────────────────────────────────────────────────────

/**
 * How a run looks in the chat once it is done. `card`: its renderer stays, live. `message`: its result is shown as
 * a message. `hidden`: it disappears; the run is still in the tree.
 */
export const Display = z.enum(['card', 'message', 'hidden']);
export type Display = z.infer<typeof Display>;

/** What a fn's runs support. Pause and undo follow from declaring `resume` and `undo` types. */
export const Operations = z.object({
  cancel: z.boolean(),
  pause: z.boolean(),
  undo: z.boolean(),
  /** Can be moved to the background so the agent stops waiting. */
  background: z.boolean(),
});
export type Operations = z.infer<typeof Operations>;

/** The operations a run can narrow while it runs. */
export const AllowedOperations = Operations.pick({ cancel: true, pause: true, background: true });
export type AllowedOperations = z.infer<typeof AllowedOperations>;

/** Limits and estimates for a fn's runs. */
export const FnLimits = z.object({
  /** Hard limit for one run. The hub's global tool timeout still applies. */
  timeout: Duration.optional(),
  /** Retries for failures classed `retry`. */
  retries: z.number().int().min(0).optional(),
  /** A rough cost per run, for budget checks before the first measurement. */
  cost: Usd.optional(),
});
export type FnLimits = z.infer<typeof FnLimits>;

/** How a fn reports progress: not at all, as a fraction, or as named steps (each mapped to its title). */
export const ProgressDecl = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('linear') }),
  z.object({ type: z.literal('steps'), steps: z.record(z.string(), z.string()) }),
]);
export type ProgressDecl = z.infer<typeof ProgressDecl>;

/** The status of one progress step. */
export const StepStatus = z.enum(['pending', 'active', 'done', 'failed', 'skipped']);
export type StepStatus = z.infer<typeof StepStatus>;

/** Progress as it travels: a fraction, or the state of each step. Its shape follows the fn's `ProgressDecl`. */
export const ProgressWire = z.union([
  z.object({ fraction: z.number().min(0).max(1), message: z.string().optional() }),
  z.object({ steps: z.record(z.string(), z.object({ status: StepStatus, detail: z.string().optional() })) }),
]);
export type ProgressWire = z.infer<typeof ProgressWire>;

/** One progress report from a run: a fraction, or one step's new status. */
export const ProgressReport = z.union([
  z.object({ fraction: z.number().min(0).max(1), message: z.string().optional() }),
  z.object({ step: z.string(), status: StepStatus, detail: z.string().optional() }),
]);
export type ProgressReport = z.infer<typeof ProgressReport>;

// ─── Outcomes ─────────────────────────────────────────────────────────────────

/** How the hub treats a failure: try again, give it back to the caller so the LLM can fix its call, or stop the turn. */
export const ERROR_CLASSES = ['retry', 'caller', 'fatal'] as const;
export const ErrorClass = z.enum(ERROR_CLASSES);
export type ErrorClass = z.infer<typeof ErrorClass>;

/** A failure. */
export const FnError = z.object({
  class: ErrorClass,
  message: z.string(),
  /** A stable code for programs: `not-found`, `denied`, `timeout`, `budget`. */
  code: z.string().optional(),
  data: Json.optional(),
});
export type FnError = z.infer<typeof FnError>;

/** Why a run's input was refused: its JSON didn't parse, it didn't fit the fn's args type, or the fn's own checks failed. */
export const INPUT_PROBLEM_SOURCES = ['json', 'schema', 'validation'] as const;
export const InputProblemSource = z.enum(INPUT_PROBLEM_SOURCES);
export type InputProblemSource = z.infer<typeof InputProblemSource>;

/** One thing wrong with a run's input: where (a dotted path into the args, empty for the whole) and what. */
export const InputProblem = z.object({ path: z.string(), message: z.string() });
export type InputProblem = z.infer<typeof InputProblem>;

/** One problem as a reader sees it: `path: message`, or the message alone for the whole input. */
export function problemLine(problem: InputProblem): string {
  return problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`;
}

/**
 * A run's input was refused before (or by) its fn. This is retryable and often expected from a model: the hub feeds the
 * problems back to the agent and the chat shows the run softly as "Retried". A real failure is `failed`.
 */
export const InvalidInput = z.object({
  source: InputProblemSource,
  problems: z.array(InputProblem).min(1),
  /** The text the model wrote, when it wasn't JSON. */
  raw: z.string().optional(),
});
export type InvalidInput = z.infer<typeof InvalidInput>;

/**
 * The `FnError.code` a code caller sees when its child call's input was refused. Child calls settle as `failed`
 * with this code, class `caller` and the `InvalidInput` as `data`, so code needs no extra case; agents read the run.
 */
export const INVALID_INPUT_CODE = 'invalid-input';

/** Where a run is. `invalid-input`: its input was refused (retryable, shown softly); `failed`: a real error. */
export const RUN_STATUSES = ['awaiting-approval', 'queued', 'running', 'waiting', 'paused', 'done', 'invalid-input', 'failed', 'cancelled', 'undone'] as const;
export const RunStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatus>;

/**
 * Whether each status is settled (a run never leaves it on its own) or active (the run may still change things).
 * Every status must be classed here, so a new one fails to compile until it is.
 */
const SETTLED_BY_STATUS = {
  'awaiting-approval': false, queued: false, running: false, waiting: false, paused: false,
  done: true, 'invalid-input': true, failed: true, cancelled: true, undone: true,
} as const satisfies Record<RunStatus, boolean>;

/**
 * Each status in a word or two, as people read it ("Needs approval", "Cancelled"). Every status must have one, so a
 * new status fails to compile until it is worded; the web chat and every system's renderers read these.
 */
export const RUN_STATUS_WORDS = {
  'awaiting-approval': 'Needs approval', queued: 'Queued', running: 'Running', waiting: 'Waiting', paused: 'Paused',
  done: 'Done', 'invalid-input': 'Retried', failed: 'Failed', cancelled: 'Cancelled', undone: 'Undone',
} as const satisfies Record<RunStatus, string>;

/** A status a run never leaves on its own. */
export type SettledRunStatus = { [S in RunStatus]: (typeof SETTLED_BY_STATUS)[S] extends true ? S : never }[RunStatus];
/** A status of a run that is not finished yet. */
export type ActiveRunStatus = Exclude<RunStatus, SettledRunStatus>;

/** Whether a status is one a run never leaves on its own. */
export function isSettled(status: RunStatus): status is SettledRunStatus {
  return SETTLED_BY_STATUS[status];
}

/** Whether a run with this status is not finished yet (it may still change things). */
export function isUnsettled(status: RunStatus): status is ActiveRunStatus {
  return !SETTLED_BY_STATUS[status];
}

/** The statuses a run never leaves on its own, in `RUN_STATUSES` order. */
export const SETTLED_RUN_STATUSES: readonly SettledRunStatus[] = RUN_STATUSES.filter(isSettled);
/** The statuses of runs that are not finished, in `RUN_STATUSES` order. Together with the settled ones they are every status. */
export const ACTIVE_RUN_STATUSES: readonly ActiveRunStatus[] = RUN_STATUSES.filter(isUnsettled);

/** A live change to a run. */
export const RunUpdate = z.discriminatedUnion('type', [
  /** `text` is the run's status words for its new phase; absent for statuses the chat words itself (see `phaseOf`). */
  z.object({ type: z.literal('status'), status: RunStatus, text: RunText.optional() }),
  z.object({ type: z.literal('progress'), progress: ProgressWire }),
  z.object({ type: z.literal('allowed'), operations: AllowedOperations }),
  z.object({ type: z.literal('cost'), cost: Usd, total: Usd }),
  /** The run went to the background: whoever called it stopped waiting, and its result is posted when it settles. */
  z.object({ type: z.literal('background') }),
]);
export type RunUpdate = z.infer<typeof RunUpdate>;

/** How a run ended, on the wire. The SDK's `Outcome<T>` is the typed form of this. */
export const OutcomeWire = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('done'),
    result: Json,
    undo: Json.optional(),
    cost: Usd.optional(),
    /** Fns the result shows the agent (`ctx.expose`): their cards follow the tool reply, and they stay near the top of the next selection. */
    expose: z.array(Exposure).optional(),
  }),
  z.object({ status: z.literal('invalid-input'), invalid: InvalidInput, cost: Usd.optional() }),
  z.object({ status: z.literal('paused'), resume: Json, cost: Usd.optional() }),
  z.object({ status: z.literal('failed'), error: FnError, undo: Json.optional(), cost: Usd.optional() }),
  z.object({ status: z.literal('cancelled'), partial: Json.optional(), undo: Json.optional(), cost: Usd.optional() }),
]);
export type OutcomeWire = z.infer<typeof OutcomeWire>;

/** How a child call ended, as its caller hears it. */
export const RunSettled = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), result: Json }),
  z.object({ status: z.literal('failed'), error: FnError }),
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('background'), run: RunId }),
]);
export type RunSettled = z.infer<typeof RunSettled>;

/** The result of undoing a run. `gone`: nothing was left to undo. */
export const UndoOutcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('undone'), summary: z.string() }),
  z.object({ status: z.literal('failed'), error: FnError }),
  z.object({ status: z.literal('gone') }),
]);
export type UndoOutcome = z.infer<typeof UndoOutcome>;

/** A handler's answer: its value, or why there is none. */
export const HandlerAnswer = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: Json }),
  z.object({ ok: z.literal(false), error: FnError }),
]);
export type HandlerAnswer = z.infer<typeof HandlerAnswer>;

/** What is left of a turn's budgets, for information. The hub enforces LLM spend itself. */
export const BudgetLeft = z.object({ cost: Usd, time: Duration, limitedBy: z.string() });
export type BudgetLeft = z.infer<typeof BudgetLeft>;
