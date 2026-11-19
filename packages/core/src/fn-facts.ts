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
import { FnDecl, FnExample, FnMode, REGISTRY_ACTIONS, RegistryAction, RegistryEffect, RegistryThing, TypeDecl } from './manifest.ts';
import { RoleModel } from './model-calls.ts';
import { FnBlock } from './fn-block.ts';
import { ActorId, Duration, FnKindName, IDS, InstanceName, Json, LocalName, QualifiedName, SystemName, Timestamp, Usd } from './primitives.ts';
import { ResourceUri, SectionKey } from './resources.ts';
import { Filter } from './query.ts';
import { ContextRecord } from './records/systems.ts';
import { SearchMatchedBy } from './records/content.ts';

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
  /** `runtime`: its system added it while running (`examples` on the link), under its own `key`. */
  source: z.enum(['decl', 'added', 'runtime']),
  /** The system's key for a `runtime` example, so it can replace or remove it. */
  key: z.string().min(1).max(200).optional(),
  /** Its place among the fn's declared examples (0 for added ones). */
  order: z.number().int().min(0),
  text: z.string(),
  addedBy: ActorId.optional(),
  createdAt: Timestamp,
});
export type FnExampleRecord = z.infer<typeof FnExampleRecord>;

/**
 * A system adds, replaces (by `key`) or removes examples of one of its own fns while running (`examples` on
 * the hub link). Examples in the fn's declaration are left alone.
 */
export const FnExamplesPatch = z.object({
  fn: LocalName,
  upsert: z.array(FnExample.extend({ key: z.string().min(1).max(200) })),
  remove: z.array(z.string().min(1).max(200)),
});
export type FnExamplesPatch = z.infer<typeof FnExamplesPatch>;

/** What `fnExamples` asks for: one fn's examples, the most relevant to `query` first (declared order without one). */
export const FnExamplesQuery = z.object({
  fn: QualifiedName,
  query: z.string().optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type FnExamplesQuery = z.infer<typeof FnExamplesQuery>;

/**
 * One example as a reader sees it, with its `rank` when found by a query: its place in that search's order as a share
 * of the best (1 = first, `SearchHit.rank`), for ordering only, never a measure of fit.
 */
export const FnExampleView = FnExample.extend({ id: FnExampleId, rank: z.number().optional() });
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
 * these fns and context items, to look up their hits by name). `filters` are the context list's own filters
 * (`LIST_FIELDS.contexts`: origin, tags, off, stale, tokens, updated…), run as SQL over the context table, so only
 * context matches a query with them. Text matches a context item's own text and each of its heading sections; a hit
 * found by a section says which (`FnSearchHit.section`).
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
  /**
   * Only fns that create, update or remove one of these things in the hub (`FnFacts.registry`); `action`
   * and `kind` narrow each when given.
   */
  effects: z.array(z.object({ thing: RegistryThing, action: RegistryAction.optional(), kind: z.string().min(1).optional() })).min(1).optional(),
  /** Only these items, by qualified name. */
  names: z.array(QualifiedName).min(1).max(100).optional(),
  /** Only context items these context list filters let through (`LIST_FIELDS.contexts`), run in the database. */
  filters: z.array(Filter).max(20).optional(),
  /** Context items switched off are hits too (the context page lists them, marked); left out by default. */
  off: z.boolean().optional(),
  /** Only fns that can be used now (default true; `hub/fns_search` for the model defaults to false); false keeps the rest too, each marked with what blocks it (`FnSearchHit.blocked`). */
  available: z.boolean().optional(),
  /** `rank` (best first, the default with `text`) or `name` (the default without). */
  order: z.enum(['rank', 'name']).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type FnSearchQuery = z.infer<typeof FnSearchQuery>;

/**
 * What the model may ask `hub/fns_search` (static mode's `find`): the query without the context page's own `filters`
 * and `off`, which are the page's, so the tool's spec in every prompt stays small.
 */
export const FnSearchArgs = FnSearchQuery.omit({ filters: true, off: true });
export type FnSearchArgs = z.infer<typeof FnSearchArgs>;

/** The heading section of a context item a search hit was found by. */
export const SearchSection = z.object({ key: SectionKey, path: z.array(z.string()), title: z.string() });
export type SearchSection = z.infer<typeof SearchSection>;

/** One hit: a fn (with its kind, mode and signature line) or a context item, with its rank and fit when searched by text. */
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
  /** What a fn changes in the hub, in one line (`effectsLine`): "Creates fns (database/query)." */
  effects: z.string().optional(),
  instance: InstanceName.optional(),
  /** Searched by text: its place in the order as a share of the best (1 = first); for ordering, not a measure of fit. */
  rank: z.number().optional(),
  /** Searched by meaning: how close it is to the text (cosine, 0 to 1), the one measure of fit; absent with words alone. */
  similarity: z.number().optional(),
  /** Searched by text: which index found it, its words, its meaning, or both. */
  matched: SearchMatchedBy.optional(),
  /** A context item found by one of its heading sections: which (its key, heading path and title). */
  section: SearchSection.optional(),
  /** Whether the asker can use it now; what blocks it when false. */
  available: z.boolean(),
  blocked: FnBlock.optional(),
});
export type FnSearchHit = z.infer<typeof FnSearchHit>;

/** How a search found a listed item: its rank (for ordering), fit, which index found it, and the section. */
export const SearchFound = FnSearchHit.pick({ rank: true, similarity: true, matched: true, section: true });
export type SearchFound = z.infer<typeof SearchFound>;

/** A row of the context list (`contexts`): the item, and how the list's text search found it when it has text. */
export const ContextListItem = ContextRecord.extend({ found: SearchFound.optional() });
export type ContextListItem = z.infer<typeof ContextListItem>;

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
  /** What it and everything it uses create, update or remove in the hub, each once. */
  registry: z.array(RegistryEffect),
  cost: CostEstimate,
  times: RunTimes.optional(),
  longRunning: z.boolean(),
  notice: z.string().optional(),
});
export type FnFacts = z.infer<typeof FnFacts>;

/** The hub asks a kind's system what a fn of that kind would cost (`estimate` on the system link). */
export const KindEstimateRequest = z.object({
  kind: z.string().min(1),
  payload: Json,
  /** The call's args, when estimating one call rather than the fn in general. */
  args: Json.optional(),
  /** The fn's run history so far (absent when it has none), so the kind can blend it in. */
  history: CostEstimate.optional(),
});
export type KindEstimateRequest = z.infer<typeof KindEstimateRequest>;

/** The kind's answer: an estimate with basis `payload` or `free`, or none (the hub uses the history). */
export const KindEstimateAnswer = z.object({ estimate: CostEstimate.optional() });
export type KindEstimateAnswer = z.infer<typeof KindEstimateAnswer>;

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
  /** Absent on facts worked out before build 6; they are worked out again as their fns change. */
  registry: z.array(RegistryEffect).optional(),
  system: SystemName,
  instance: InstanceName.optional(),
  updatedAt: Timestamp,
});
export type FnFactsRecord = z.infer<typeof FnFactsRecord>;

/** One type a fn reads or writes (the `fnTypes` table), so search finds the fns of a type in the database. */
export const FnTypeUse = z.object({ fn: QualifiedName, type: QualifiedName, use: z.enum(['read', 'write']) });
export type FnTypeUse = z.infer<typeof FnTypeUse>;

/**
 * Build 8: one named type a fn's signature mentions (the `fnSignatureTypes` table: its args, result and kind payload,
 * as written, not deeply), written in the fn's transaction, so the catalog finds the fns to re-describe or refuse when
 * a type changes by querying, not by loading every fn.
 */
export const FnSignatureType = z.object({ fn: QualifiedName, type: QualifiedName, kind: FnKindName, system: SystemName });
export type FnSignatureType = z.infer<typeof FnSignatureType>;

/**
 * Build 8: a fn's direct link to a fn it depends on (`FnDecl.deps`, `dep`) or to the kind it is a fn of (`kind`): the
 * `fnLinks` table, written by the catalog in the fn's transaction, so the catalog finds a fn's dependents and a kind's
 * fns by querying, not by loading every fn (`fnUses`, the facts module's deep list, is worked out after the change).
 */
export const FnLink = z.object({ fn: QualifiedName, to: QualifiedName, link: z.enum(['dep', 'kind']), system: SystemName });
export type FnLink = z.infer<typeof FnLink>;

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

/**
 * An earlier version of a named type (the `typeVersions` table), written whenever a manifest, patch or runtime
 * change replaces its definition, numbered from 1 per type. `meta` is kept with it, so a table type's schema hash at
 * each version can be looked back on.
 */
export const TypeVersionRecord = z.object({
  /** `<type>#<number>`. */
  id: z.string(),
  type: QualifiedName,
  number: z.number().int().min(1),
  decl: TypeDecl,
  /** The instance whose change it was, for a fleet's instance types. */
  instance: InstanceName.optional(),
  savedAt: Timestamp,
});
export type TypeVersionRecord = z.infer<typeof TypeVersionRecord>;

// ─── Declared effects on the hub ──────────────────────────────────────────────

/** How a thing reads in an effects line. */
const THING_WORDS: { readonly [T in RegistryThing]: string } = {
  fns: 'fns', types: 'types', context: 'context', resources: 'resources', kinds: 'kinds', components: 'components',
  examples: 'examples', approvals: 'runs awaiting approval', secrets: 'secrets', connections: 'connections', records: 'records',
};

/** How an action starts an effects line. */
const ACTION_WORDS: { readonly [A in RegistryAction]: string } = { create: 'Creates', update: 'Updates', remove: 'Removes' };

/** The same effect, for keeping each once. */
export function registryKey(effect: RegistryEffect): string {
  return `${effect.action} ${effect.thing}${effect.kind === undefined ? '' : ` ${effect.kind}`}`;
}

/** Effects each once, in a stable order. */
export function uniqueEffects(effects: Iterable<RegistryEffect>): RegistryEffect[] {
  const byKey = new Map<string, RegistryEffect>();
  for (const effect of effects) byKey.set(registryKey(effect), effect);
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, effect]) => effect);
}

/**
 * What a fn changes in the hub, as one short line for its description: "Creates fns (database/query). Updates
 * context." A fns entry with no kind covers every kind, so the kinds are only listed when every entry names one.
 * Undefined when it changes nothing.
 */
export function effectsLine(effects: readonly RegistryEffect[]): string | undefined {
  const sentences: string[] = [];
  for (const action of REGISTRY_ACTIONS) {
    const things = new Map<RegistryThing, Set<string> | undefined>();
    for (const effect of effects) {
      if (effect.action !== action) continue;
      const kinds = things.has(effect.thing) ? things.get(effect.thing) : new Set<string>();
      if (kinds === undefined || effect.kind === undefined) { things.set(effect.thing, undefined); continue; }
      kinds.add(effect.kind);
      things.set(effect.thing, kinds);
    }
    if (things.size === 0) continue;
    const parts = [...things.entries()].map(([thing, kinds]) => (kinds === undefined || kinds.size === 0 ? THING_WORDS[thing] : `${THING_WORDS[thing]} (${[...kinds].sort().join(', ')})`));
    sentences.push(`${ACTION_WORDS[action]} ${parts.join(', ')}.`);
  }
  return sentences.length === 0 ? undefined : sentences.join(' ');
}

/** Whether `declared` covers a change: the same thing and action, and for fns the same kind or a declaration of any kind. */
export function effectCovered(declared: readonly RegistryEffect[], change: RegistryEffect): boolean {
  return declared.some((effect) => effect.thing === change.thing && effect.action === change.action && (effect.kind === undefined || effect.kind === change.kind));
}

/** The least mode a registry change needs: removing is a delete, creating and updating a write. */
export function registryMode(effects: readonly RegistryEffect[]): FnMode | undefined {
  if (effects.some((effect) => effect.action === 'remove')) return 'delete';
  return effects.length > 0 ? 'write' : undefined;
}
