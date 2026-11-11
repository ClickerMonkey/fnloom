/**
 * Fns as the hub knows them (build 5, from the owner's feedback):
 *
 * - **Search** (`FnSearchQuery`): fns and context found in the hub's database by words, by meaning or both, best
 *   first or by name, filtered by kind, system, instance, visibility, the types they read or write and their mode, and
 *   paged. The web (`searchFns`), the system link (`searchFns`, so `get_input` and `get_query` find saved fns) and the
 *   LLM (`hub/fns_search`) all ask the same search.
 * - **Examples** (`FnExampleRecord`): every example of every fn in its own table, embedded and searchable, so a fn
 *   can carry many. The prompt takes the few most relevant to the turn (`FnDecl.promptExamples`); `hub/fn_examples`
 *   pages through the rest.
 * - **Facts** (`FnFacts`): the types a fn reads and writes and its mode, worked out deeply through what it uses,
 *   whether it is free, its cost estimate (min, typical, max) and its run times, with a notice when it usually runs
 *   long.
 * - **The auto classifier** (`AutoClassifier`): the model a chat in `auto` mode asks whether a call may go ahead.
 * - **Browser logs** (`ClientLogBatch`): the web app's logs and API traffic, kept by the hub as one resource file per
 *   person, rolled over by size and after a quiet spell.
 */
import { z } from 'zod';
import { FnDecl, FnExample, FnMode } from './manifest.ts';
import { RoleModel } from './model-calls.ts';
import { ActorId, Duration, IDS, InstanceName, Json, QualifiedName, SystemName, Timestamp, Usd } from './primitives.ts';
import { ResourceUri } from './resources.ts';

/** A fn example's id. */
export const FnExampleId = IDS.fnExample;
export type FnExampleId = z.infer<typeof FnExampleId>;

/**
 * One stored example of a fn (the `fnExamples` table): from its declaration (`source: 'decl'`, replaced whenever the
 * fn's declaration changes) or added since (a saved query's first call). `text` is what is embedded and searched.
 */
export const FnExampleRecord = FnExample.extend({
  id: FnExampleId,
  fn: QualifiedName,
  system: SystemName,
  source: z.enum(['decl', 'added']),
  /** Its place among the fn's declared examples (0 for added ones). */
  order: z.number().int().min(0),
  text: z.string(),
  addedBy: ActorId.optional(),
  createdAt: Timestamp,
});
export type FnExampleRecord = z.infer<typeof FnExampleRecord>;

/** What `fnExamples` asks for: one fn's examples, the most relevant to `query` first (declared order without one). */
export const FnExamplesQuery = z.object({
  fn: QualifiedName,
  query: z.string().optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type FnExamplesQuery = z.infer<typeof FnExamplesQuery>;

/** One example as a reader sees it, with how well it matched the query. */
export const FnExampleView = FnExample.extend({ id: FnExampleId, score: z.number().optional() });
export type FnExampleView = z.infer<typeof FnExampleView>;

/** A page of a fn's examples: `total` of them, `next` the offset of the next page (absent on the last). */
export const FnExamplesPage = z.object({
  fn: QualifiedName,
  items: z.array(FnExampleView),
  total: z.number().int().min(0),
  next: z.number().int().min(0).optional(),
});
export type FnExamplesPage = z.infer<typeof FnExamplesPage>;

// ─── Search ───────────────────────────────────────────────────────────────────

/** How a search matches: by words, by meaning, or both merged (the default). */
export const SEARCH_MATCHES = ['text', 'semantic', 'hybrid'] as const;
export const SearchMatch = z.enum(SEARCH_MATCHES);
export type SearchMatch = z.infer<typeof SearchMatch>;

/** What a fn and context search returns: fns, context items, or both. */
export const SearchItemKind = z.enum(['fn', 'context']);
export type SearchItemKind = z.infer<typeof SearchItemKind>;

/**
 * A search over fns and context, done in the hub's database. Without `text` it lists what the filters let through,
 * by name. Every filter narrows: `kinds` (the fn kinds, such as `input/form` or `database/query`), `systems`,
 * `instance` (a fleet instance's own fns), `visibility` (what the asker shares: `mine` they own, `shared` others gave
 * them), `types` (fns that read or write any of these named types), `modes` (fns of these modes), and `names` (exactly
 * these fns and context items, to look up their hits by name).
 */
export const FnSearchQuery = z.object({
  text: z.string().optional(),
  match: SearchMatch.optional(),
  items: z.array(SearchItemKind).min(1).optional(),
  kinds: z.array(z.union([z.literal('native'), QualifiedName])).min(1).optional(),
  systems: z.array(SystemName).min(1).optional(),
  instance: InstanceName.optional(),
  visibility: z.enum(['mine', 'shared', 'public']).optional(),
  types: z.object({ reads: z.array(QualifiedName).optional(), writes: z.array(QualifiedName).optional() }).optional(),
  modes: z.array(FnMode).min(1).optional(),
  /** Only these items, by qualified name. */
  names: z.array(QualifiedName).min(1).max(100).optional(),
  /** Only fns that can be used now (default true). */
  available: z.boolean().optional(),
  /**
   * `score` (the default with `text`) or `alphabetical` (by name; the default without). Not `name`: gin's reference walk
   * reads an enum whose values map has a `name` key as a type reference (reported as a library gap).
   */
  order: z.enum(['score', 'alphabetical']).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type FnSearchQuery = z.infer<typeof FnSearchQuery>;

/** One hit: a fn (with its kind, mode and signature line) or a context item, with its score when searched by text. */
export const FnSearchHit = z.object({
  item: SearchItemKind,
  name: QualifiedName,
  system: SystemName,
  description: z.string(),
  /** A fn's kind (`native`, `input/form`, …). */
  kind: z.string().optional(),
  mode: FnMode.optional(),
  /** A fn's one-line signature, `name(args) → returns`, for calling it. */
  signature: z.string().optional(),
  instance: InstanceName.optional(),
  score: z.number().optional(),
  /** Whether the asker can use it now; why not when false. */
  available: z.boolean(),
  unavailable: z.string().optional(),
});
export type FnSearchHit = z.infer<typeof FnSearchHit>;

/** A page of hits; `next` is the offset of the next page, absent on the last. */
export const FnSearchPage = z.object({ items: z.array(FnSearchHit), next: z.number().int().min(0).optional() });
export type FnSearchPage = z.infer<typeof FnSearchPage>;

// ─── Facts ────────────────────────────────────────────────────────────────────

/**
 * What a call is expected to cost, in dollars. `basis` says where the numbers come from: `free` (nothing it does
 * spends), `history` (its settled runs), `payload` (worked out from the call's args and the model's price), or
 * `unknown` (it spends and has never run).
 */
export const CostEstimate = z.object({
  min: Usd,
  typical: Usd,
  max: Usd,
  basis: z.enum(['free', 'history', 'payload', 'unknown']),
  /** The runs the history holds. */
  runs: z.number().int().min(0),
});
export type CostEstimate = z.infer<typeof CostEstimate>;

/** How long its runs take, from its run history: `typical` the median, `slow` the 95th percentile. */
export const RunTimes = z.object({ runs: z.number().int().min(0), typical: Duration, slow: Duration, longest: Duration });
export type RunTimes = z.infer<typeof RunTimes>;

/**
 * What the hub knows about a fn, worked out deeply: its mode and the types it reads and writes include those of every
 * fn it uses (its deps, an agent's tools, a kind's own). `free` is true only when nothing it does or uses spends.
 * `notice` is set when it usually runs past the long-running threshold ("This usually takes about 3 minutes.").
 */
export const FnFacts = z.object({
  fn: QualifiedName,
  kind: z.string(),
  mode: FnMode,
  reads: z.array(QualifiedName),
  writes: z.array(QualifiedName),
  /** The fns it uses, directly or through others. */
  uses: z.array(QualifiedName),
  free: z.boolean(),
  cost: CostEstimate,
  times: RunTimes.optional(),
  longRunning: z.boolean(),
  notice: z.string().optional(),
});
export type FnFacts = z.infer<typeof FnFacts>;

// ─── The auto classifier ──────────────────────────────────────────────────────

/**
 * The model a chat in `auto` mode asks about each call above `read` (admins). It answers whether the call goes ahead
 * on its own or waits for the person. Without a model every such call waits for the person.
 */
export const AutoClassifier = z.object({
  model: RoleModel.optional(),
  /** How many of the chat's last messages it reads with the call. */
  messages: z.number().int().min(0).max(20).default(4),
});
export type AutoClassifier = z.infer<typeof AutoClassifier>;

/** The stored setting, who set it and when (the `hubOptions` row keyed `autoClassifier`). */
export const AutoClassifierView = z.object({ value: AutoClassifier, setBy: ActorId.optional(), updatedAt: Timestamp.optional() });
export type AutoClassifierView = z.infer<typeof AutoClassifierView>;

// ─── Browser logs and traffic ─────────────────────────────────────────────────

/** One line the browser sends: a log line, or an API call it made (method, endpoint, status, time; never bodies). */
export const ClientLogEntry = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('log'), at: Timestamp, level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string().max(4000),
    fields: z.record(z.string(), Json).optional(),
  }),
  z.object({
    type: z.literal('traffic'), at: Timestamp, method: z.string().max(16), endpoint: z.string().max(300), status: z.number().int(), duration: Duration,
  }),
]);
export type ClientLogEntry = z.infer<typeof ClientLogEntry>;

/** A batch of the browser's lines, oldest first, and which page it was on. */
export const ClientLogBatch = z.object({ entries: z.array(ClientLogEntry).min(1).max(500), page: z.string().max(300).optional() });
export type ClientLogBatch = z.infer<typeof ClientLogBatch>;

/** Where the hub put a batch: the person's current log file. */
export const ClientLogReceipt = z.object({ uri: ResourceUri, written: z.number().int().min(0) });
export type ClientLogReceipt = z.infer<typeof ClientLogReceipt>;

/**
 * The stored part of a fn's facts (the `fnFacts` table), worked out when its declaration changes: everything but the
 * cost and run times, which come from its run history when asked. Its scalar columns are what search filters on.
 */
export const FnFactsRecord = FnFacts.pick({ fn: true, kind: true, mode: true, reads: true, writes: true, uses: true, free: true }).extend({
  system: SystemName,
  instance: InstanceName.optional(),
  updatedAt: Timestamp,
});
export type FnFactsRecord = z.infer<typeof FnFactsRecord>;

/** One type a fn reads or writes (the `fnTypes` table), so search finds the fns of a type in the database. */
export const FnTypeUse = z.object({ fn: QualifiedName, type: QualifiedName, use: z.enum(['read', 'write']) });
export type FnTypeUse = z.infer<typeof FnTypeUse>;

/** One fn another uses, deeply (the `fnUses` table), so a change to `uses` refreshes the facts of `fn` in the database. */
export const FnUse = z.object({ fn: QualifiedName, uses: QualifiedName });
export type FnUse = z.infer<typeof FnUse>;

/**
 * An earlier version of a saved fn (the `fnVersions` table, `hub/save_fn` with `replace`): its declaration as it was,
 * numbered from 1, so a saved form or query that is changed can be looked back on.
 */
export const FnVersionRecord = z.object({
  /** `<fn>#<number>`. */
  id: z.string(),
  fn: QualifiedName,
  number: z.number().int().min(1),
  decl: FnDecl,
  savedBy: ActorId.optional(),
  savedAt: Timestamp,
});
export type FnVersionRecord = z.infer<typeof FnVersionRecord>;
