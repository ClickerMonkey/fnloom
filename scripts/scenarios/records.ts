/**
 * What a scenario run saves, zod first: each case's transcript and numbers (`CaseRecord`, `<rep>/<case>.json`), the
 * judge's verdict on it (`Judged`), and the people a repetition made (`RepPeople`, so `--view` can list their
 * sign-ins). The report reads these back from disk, so a report can be rebuilt without running anything.
 */
import { z } from 'zod';

/** Why a case went wrong, as the judge files it. */
export const CAUSES = ['didnt-ask', 'asked-too-much', 'wrong-tool', 'missed-capability', 'gave-up', 'overpromised', 'hallucinated', 'tool-error', 'harness-bug', 'prompt-unclear', 'slow', 'other'] as const;
export const Cause = z.enum(CAUSES);
export type Cause = z.infer<typeof Cause>;

/** Which part of the harness to change to fix it. */
export const LAYERS = ['fn', 'context', 'kind', 'instructions', 'chat-prompt', 'ui', 'hub'] as const;
export const Layer = z.enum(LAYERS);
export type Layer = z.infer<typeof Layer>;

export const Verdict = z.enum(['pass', 'weak', 'fail']);
export type Verdict = z.infer<typeof Verdict>;

/** One fn run of a turn, shortened for reading. */
export const ToolRun = z.object({
  run: z.string(),
  fn: z.string(),
  /** How deep in the turn's tree (1: called by the chat agent itself). */
  depth: z.number().int().min(0),
  status: z.string(),
  args: z.string(),
  /** The result or error, shortened. */
  outcome: z.string(),
  cost: z.number(),
  /** Parts of its args the hub read other than as sent (a field sent as JSON text, read as that JSON): the model's slip, repaired (absent: none, or a record from before 2026-11-23). */
  repairs: z.number().int().min(0).optional(),
  /** The approval it waited on, and what the person said. */
  approval: z.object({ title: z.string(), decision: z.enum(['approved', 'denied', 'left']), reason: z.string() }).optional(),
});
export type ToolRun = z.infer<typeof ToolRun>;

/** One line of a case's transcript, in order. */
export const Entry = z.discriminatedUnion('type', [
  /** A new chat (session) started: the first one, or a step that opens another (case 28's "later, in a new chat"). */
  z.object({ type: z.literal('chat'), session: z.string(), url: z.string(), /** Whose chat, when not the case's own person's (a step sent `as` a member). */ as: z.string().optional() }),
  z.object({ type: z.literal('person'), text: z.string(), files: z.array(z.string()), scripted: z.boolean() }),
  z.object({ type: z.literal('form-answer'), title: z.string(), text: z.string() }),
  z.object({ type: z.literal('agent'), text: z.string(), status: z.string() }),
  z.object({ type: z.literal('note'), text: z.string() }),
  z.object({ type: z.literal('tools'), turn: z.string(), runs: z.array(ToolRun) }),
  /** A form the agent showed (an input fn's result). */
  z.object({ type: z.literal('form'), run: z.string(), title: z.string(), fields: z.array(z.string()) }),
  /** A question a run asked the person directly (a handler), and the answer given. */
  z.object({ type: z.literal('question'), run: z.string(), question: z.string(), answer: z.string() }),
  /**
   * A widget preview the agent offered (`widgets/make_widget`'s proposal card), and what the person did with its Save:
   * pressed it (`saved`, or `save-failed` when `widgets/save_widget` didn't finish), left it (`declined`), or passed it
   * over for a newer preview shown with it. `detail` is the saved widget's name, the reason or the failure.
   */
  z.object({ type: z.literal('widget'), run: z.string(), title: z.string(), decision: z.enum(['saved', 'save-failed', 'declined', 'passed-over']), detail: z.string() }),
]);
export type Entry = z.infer<typeof Entry>;

/** How the case ended. */
export const Ending = z.object({
  /** harness-crash: the hub stopped answering while the case ran (or before it could start). */
  by: z.enum(['satisfied', 'gave-up', 'turn-limit', 'error', 'timeout', 'harness-crash']),
  reason: z.string(),
});
export type Ending = z.infer<typeof Ending>;

/** One code check of a case. */
export const HardCheck = z.object({ name: z.string(), ok: z.boolean(), detail: z.string() });
export type HardCheck = z.infer<typeof HardCheck>;

/**
 * A system the hub had after a case that it didn't have before (the third set, `authoring.ts`): as the runner watched
 * it while the case played and read it at the end.
 */
export const SeenSystem = z.object({
  name: z.string(),
  /** Its status and stage at the end (`connected`, `live`). */
  status: z.string(),
  stage: z.string(),
  /** Every version it ran during the case, in the order seen. */
  versions: z.array(z.string()),
  /** Its instances that weren't removed, and how many keys they had over the case (one: the same instance throughout). */
  instances: z.number().int().min(0),
  keys: z.number().int().min(0),
  /** Whether a host (fs) runs it (fs/install_system), or the hub's own supervisor does (hub/install_system). */
  hosted: z.boolean(),
  hubInstalled: z.boolean().default(false),
  fns: z.array(z.string()),
  /** The pages the hub lists for it (segments), and whether its client build answered. */
  pages: z.array(z.string()),
  pageServed: z.boolean(),
  /** The most records of its stored types, and files in its hosted data folders, seen while each version ran. */
  recordsByVersion: z.record(z.string(), z.number().int().min(0)),
  filesByVersion: z.record(z.string(), z.number().int().min(0)),
  /** What the runner did for it as the admin (went live, approved a review), in order. */
  events: z.array(z.string()),
});
export type SeenSystem = z.infer<typeof SeenSystem>;

/** The systems a case installed, as the hub had them (`Case.authoring`). */
export const SystemsSeen = z.object({
  expect: z.enum(['new', 'page', 'update', 'none']),
  systems: z.array(SeenSystem),
  /** What went wrong watching them (a call the hub refused). */
  errors: z.array(z.string()),
});
export type SystemsSeen = z.infer<typeof SystemsSeen>;

/** A played case, before judging. */
export const CaseRecord = z.object({
  iteration: z.string(),
  rep: z.number().int().min(1),
  /** The household variant it ran in (`variants.ts`); absent: a run of one variant, in `<iteration>/rep-<n>/`. */
  variant: z.string().optional(),
  case: z.number().int().min(1),
  title: z.string(),
  good: z.string(),
  person: z.object({ email: z.string(), password: z.string() }),
  /** The other people of the household the case's steps were sent as (`Step.as`), with their sign-ins. */
  others: z.array(z.object({ name: z.string(), email: z.string(), password: z.string() })).optional(),
  sessions: z.array(z.object({ id: z.string(), url: z.string(), /** Whose chat, when not the case's own person's. */ as: z.string().optional() })),
  /** The folder of the stack it ran on, from the rep's folder (absent: the rep's own; `restart-1` after a crash). */
  stack: z.string().optional(),
  entries: z.array(Entry),
  ending: Ending,
  stats: z.object({
    personTurns: z.number().int(),
    turns: z.number().int(),
    toolRuns: z.number().int(),
    modelCalls: z.number().int(),
    hubCost: z.number(),
    personCost: z.number(),
    wallMs: z.number(),
    /** Calls of the case's own client the hub shed (HTTP 503) before taking them (`busy.ts`). */
    shed: z.number().int().optional(),
  }),
  /** What went wrong running the case itself (a timeout, a refused call). */
  errors: z.array(z.string()),
  /** Warning and error lines the stack logged while the case ran (the stack is shared, so some may be another case's). */
  stackErrors: z.array(z.string()),
  checks: z.array(HardCheck),
  /** The systems it installed (absent: a case that doesn't write one). */
  systems: SystemsSeen.optional(),
  startedAt: z.string(),
  endedAt: z.string(),
});
export type CaseRecord = z.infer<typeof CaseRecord>;

/** A model's "nothing" ('', 'none', absent) as null. */
const orNull = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === undefined || value === '' || value === 'none' ? null : value), schema.nullable());

/** The judge's verdict on one played case. */
export const Judgement = z.object({
  verdict: Verdict,
  score: z.coerce.number().min(0).max(10),
  summary: z.string(),
  wentWell: z.array(z.string()),
  wentWrong: z.array(z.string()),
  cause: orNull(Cause),
  layer: orNull(Layer),
  fix: z.string().default(''),
});
export type Judgement = z.infer<typeof Judgement>;

/** A played and judged case, as saved. */
export const JudgedCase = CaseRecord.extend({ judgement: Judgement.nullable(), judgeCost: z.number(), judgeError: z.string().optional() });
export type JudgedCase = z.infer<typeof JudgedCase>;

/** The people a repetition made, for `--view`. */
export const RepPeople = z.object({
  admin: z.object({ email: z.string(), password: z.string() }),
  cases: z.array(z.object({
    case: z.number().int(), email: z.string(), password: z.string(), sessions: z.array(z.string()), stack: z.string().optional(),
    /** The household members its steps were sent as, with their sign-ins and their chats (left out of `sessions`). */
    others: z.array(z.object({ name: z.string(), email: z.string(), password: z.string(), sessions: z.array(z.string()) })).optional(),
  })),
});
export type RepPeople = z.infer<typeof RepPeople>;
