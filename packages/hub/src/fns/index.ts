/**
 * The fns module (build 5, from the owner's feedback): what the hub knows about fns beyond the catalog.
 *
 * - `FnSearch` (`search.ts`): fns and context found in the hub's database: the filters run as SQL over the `fnFacts`,
 *   `fnTypes` and `context` tables, then words (FTS5) and meaning (sqlite-vec) rank what they let through, merged by
 *   reciprocal rank. Served on the web (`searchFns`), the system link (`searchFns`) and as `hub/fns_search`, through
 *   the admin's search decisions (`decided.ts`), which may filter a page's hits with a decision model or an LLM.
 * - `FnExamples` (`examples.ts`): every fn's examples in the `fnExamples` table, indexed like everything else, so the
 *   prompt takes the most relevant few and `hub/fns_examples` pages through the rest.
 * - `FnFactsService` (`facts.ts`): a fn's mode and the types it reads and writes, worked out deeply; whether it is
 *   free; its cost estimate from the `CostEstimator` of its kind (`costs.ts`); its run times.
 * - `FnModeGate` (`gate.ts`): what a chat's fn mode (`none` … `delete`, `auto`) lets its agent run, with the auto
 *   classifier (`auto.ts`) for `auto`.
 * - `ClientLogs` (`client-logs.ts`): the browser's logs and traffic as one hub resource file per person.
 */
import type {
  ActorId, AutoClassifier, AutoClassifierView, ClientLogBatch, ClientLogReceipt, CostEstimate, FnExample, FnExamplesPage, FnExamplesQuery, FnFacts, FnMode,
  FnRecord, FnSearchPage, FnSearchQuery, FnMetricsDay, FnExamplesPatch, Json, QualifiedName, RegistryEffect, RunId, SearchItemKind, SensitivityFlag, Session, SessionId, SystemName,
} from '@harness/core';
import type { AccessScope } from '../access/index.ts';
import type { SearchDecisions } from './decided.ts';

/** Who a search or a read is for: what they may see and use, and who they are (for `visibility`). */
export interface Asker {
  readonly actor: ActorId;
  readonly access: AccessScope;
  /** Build 6: a further per-hit rule (the session's systems, a hub MCP's scope); every hit when absent. */
  readonly keep?: (item: SearchItemKind, name: QualifiedName) => boolean;
  /** The session asking from, if any: a memory scoped to it is seen there only (`seesOrigin`). */
  readonly session?: SessionId;
  /** The run asking, if any: the search decisions' model calls are charged to it. */
  readonly run?: RunId | undefined;
  /** The latest user message of the turn asking, if any: what the search decisions judge a hit's fit against, with the text. */
  readonly latest?: string | undefined;
  /** A model asks (`hub/fns_search`): fns whose visibility leaves the model out are never hits, since it can't load them. */
  readonly forModel?: boolean;
}

/** Fns and context, searched in the hub's database. */
export interface FnSearch {
  search(query: FnSearchQuery, asker: Asker): Promise<FnSearchPage>;
}

/** Every fn's examples, stored apart and searchable. */
export interface FnExamples {
  /** Store the declared examples of these fns (replacing what they declared before) and drop those of removed fns. */
  sync(fns: readonly FnRecord[], removed: readonly QualifiedName[]): Promise<void>;
  /** A page of one fn's examples, the most relevant to the query first; refused for a fn the asker can't see. */
  page(query: FnExamplesQuery, asker: Asker): Promise<FnExamplesPage>;
  /** Build 6: a system's runtime examples of one of its fns: added or replaced by key, or removed (`examples` on the link). */
  patch(system: SystemName, patch: FnExamplesPatch): Promise<{ added: number; removed: number }>;
  /** The examples that go into a prompt with a fn: `count` of them, the most relevant to `text`. */
  forPrompt(fn: FnRecord, text: string, count: number): Promise<FnExample[]>;
}

/** What the facts of fns are, worked out deeply and kept current. */
export interface FnFactsService {
  /** A fn's facts; with `args`, the cost estimate is for that call. */
  facts(fn: QualifiedName, args?: Json): Promise<FnFacts>;
  /** The modes of some fns, as stored (a fn not worked out yet is worked out now). */
  modes(fns: readonly QualifiedName[]): Promise<ReadonlyMap<QualifiedName, FnMode>>;
  /** Build 6: what some fns create, update or remove in the hub, worked out deeply (`FnFacts.registry`). */
  registry(fns: readonly QualifiedName[]): Promise<ReadonlyMap<QualifiedName, readonly RegistryEffect[]>>;
  /** The long-running warnings of some fns ("x usually takes about 3 minutes."), from their run times; quick fns are left out. */
  notices(fns: readonly QualifiedName[]): Promise<ReadonlyMap<QualifiedName, string>>;
  /** Work out and store the facts of these fns again (their declarations changed), and forget removed ones. */
  refresh(fns: readonly FnRecord[], removed: readonly QualifiedName[]): Promise<void>;
}

/** What a cost estimator is given: the fn, its own facts so far, the call's args, and its run history. */
export interface CostInput {
  readonly fn: FnRecord;
  readonly free: boolean;
  readonly args?: Json | undefined;
  readonly history: readonly FnMetricsDay[];
}

/** Estimates what a call of a fn costs. Each kind may have its own; the first that answers wins. */
export interface CostEstimator {
  estimate(input: CostInput): Promise<CostEstimate | undefined>;
}

/** What a chat's fn mode says about one call its agent makes. */
export type ModeVerdict =
  /** The mode doesn't stand in the way: the policies decide as always. */
  | { readonly effect: 'pass' }
  /** The mode doesn't allow it: the call fails and the agent hears why. */
  | { readonly effect: 'refuse'; readonly reason: string }
  /** `auto`: the classifier let it go ahead without asking (a policy that denies or asks still wins). */
  | { readonly effect: 'allow'; readonly reason: string }
  /** `auto`: the classifier wants the person to decide. */
  | { readonly effect: 'ask'; readonly reason: string };

/** Decides what a chat's fn mode lets its agent run. */
export interface FnModeGate {
  /** `flags`: the sensitive files the call would touch, as its system answered (build 8); empty when none or not asked. */
  check(input: { readonly session: Session; readonly fn: FnRecord; readonly args: Json; readonly run: RunId; readonly flags: readonly SensitivityFlag[] }): Promise<ModeVerdict>;
}

/** One call the auto mode classifier is asked about. */
export interface ClassifyInput {
  readonly session: Session;
  readonly fn: FnRecord;
  readonly mode: FnMode;
  readonly args: Json;
  readonly run: RunId;
  /** Build 6: what the fn changes in the hub, in one line (`effectsLine`). */
  readonly changes?: string;
  /** Build 8: the sensitive files the call would touch that its rules let through (`SensitivityFlag`); absent when none. */
  readonly flags?: readonly SensitivityFlag[];
}

/** The auto mode classifier: its setting (admins), and its answer about one call. */
export interface AutoModeClassifier {
  setting(): Promise<AutoClassifierView>;
  set(value: AutoClassifier, by: ActorId): Promise<AutoClassifierView>;
  /** Whether the call may go ahead without the person; `ask` without a model, on an error, or when it is slow. */
  classify(input: ClassifyInput): Promise<{ readonly allow: boolean; readonly reason: string }>;
}

/** The browser's logs and traffic, kept as hub resources, one file per person at a time. */
export interface ClientLogs {
  write(user: ActorId, batch: ClientLogBatch): Promise<ClientLogReceipt>;
}

/** What the prompt planner asks of this module: examples for a fn's card, and fns' modes for a chat's fn mode. */
export interface FnsForPrompt {
  examples(fn: FnRecord, text: string): Promise<FnExample[]>;
  modes(fns: readonly QualifiedName[]): Promise<ReadonlyMap<QualifiedName, FnMode>>;
  /** Build 6: what fns change in the hub, for the line in their descriptions; absent leaves the line out. */
  registry?(fns: readonly QualifiedName[]): Promise<ReadonlyMap<QualifiedName, readonly RegistryEffect[]>>;
  /** What long-running fns warn of, for the line beside it; absent leaves the warning out. */
  notices?(fns: readonly QualifiedName[]): Promise<ReadonlyMap<QualifiedName, string>>;
}

/** The module's services (`HubServices.fns`). */
export interface FnsServices {
  readonly search: FnSearch;
  /** The admin's search decisions: who filters a search's hits, for fns and for context. */
  readonly decisions: SearchDecisions;
  readonly examples: FnExamples;
  readonly facts: FnFactsService;
  readonly gate: FnModeGate;
  readonly classifier: AutoModeClassifier;
  readonly clientLogs: ClientLogs;
}

/** Mode ranks live in core, beside `FnMode`. */
export { MODE_RANK, strongerMode } from '@harness/core';
