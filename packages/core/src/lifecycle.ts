/**
 * Installed vs live. A paired system is `installed`: the hub knows its contract but offers nothing. An admin
 * reviews everything it declares on the review page (`SystemReview`), switches items off, configures it, makes test
 * calls, and goes live: the reviewed contract and its hash are saved (`LiveContract`). A later contract version, or a
 * runtime addition outside what was reviewed, waits as a `PendingReview` with its changes while the live version keeps
 * working. Every call the hub refuses because a system went past what it declared is a `RefusalRecord`.
 */
import { z } from 'zod';
import { ApprovalPreview, ProposalAsk } from './approvals.ts';
import { InstallChecks } from './checks.ts';
import { FnFacts } from './fn-facts.ts';
import { SystemGrants, SystemStage } from './grants.ts';
import { FnMode, Manifest } from './manifest.ts';
import { ActorId, IDS, InstanceName, InstanceRef, Json, QualifiedName, RunId, SystemName, Timestamp, Usd } from './primitives.ts';
import { DeclaredBy } from './records/systems.ts';
import { InjectionChangeView } from './records/injections.ts';
import { ReviewSummary } from './review-summary.ts';
import { SYSTEM_PART_SECTIONS } from './system-parts.ts';

export const RefusalId = IDS.refusal;
export type RefusalId = z.infer<typeof RefusalId>;

/**
 * Every kind of item a system adds that can be switched on or off by itself: its fns, context, types and resource roots,
 * and each section of its other parts (`SYSTEM_PART_SECTIONS`).
 */
export const ITEM_SECTIONS = ['fns', 'context', 'types', 'roots', ...SYSTEM_PART_SECTIONS] as const;
export const ItemSection = z.enum(ITEM_SECTIONS);
export type ItemSection = z.infer<typeof ItemSection>;

/** One item of a system: a section and the name the system page lists it by (`SystemPart.name`, a root's URI). */
export const ItemRef = z.object({ section: ItemSection, name: z.string().min(1) });
export type ItemRef = z.infer<typeof ItemRef>;

/**
 * An item an admin switched off (table `itemSwitches`) for the sections without their own flag (fns and context keep
 * `disabled` on their rows). Only off items are stored; deleting the row switches it back on.
 */
export const ItemSwitch = ItemRef.extend({ system: SystemName, by: ActorId, at: Timestamp });
export type ItemSwitch = z.infer<typeof ItemSwitch>;

/** What the admin approved when the system went live, or when they last approved a pending review. */
export const LiveContract = z.object({
  version: z.string(),
  /** `Manifest.hash` of the reviewed contract. */
  hash: z.string().min(1),
  grants: SystemGrants,
  /** Runtime additions approved beyond the contract, kept so they are not asked about again. */
  runtime: z.array(ItemRef),
  by: ActorId,
  at: Timestamp,
});
export type LiveContract = z.infer<typeof LiveContract>;

/** One difference between what is live and what the system now declares. */
export const ContractChange = z.object({
  /** An item, or the system's `grants` or `config` type as a whole. */
  section: z.union([ItemSection, z.enum(['grants', 'config'])]),
  name: z.string().min(1),
  change: z.enum(['added', 'changed', 'removed']),
  origin: DeclaredBy,
  before: Json.optional(),
  after: Json.optional(),
});
export type ContractChange = z.infer<typeof ContractChange>;

/** Which change of a pending review a decision is about: its section and name (`ContractChange`'s key). */
export const ChangeRef = ContractChange.pick({ section: true, name: true });
export type ChangeRef = z.infer<typeof ChangeRef>;

/** A change an admin declined: it never went live (a declined item stays off), kept so the review page can say so. */
export const DeclinedChange = ChangeRef.extend({ change: ContractChange.shape.change, origin: DeclaredBy, version: z.string(), by: ActorId, at: Timestamp });
export type DeclinedChange = z.infer<typeof DeclinedChange>;

/** How many declined changes a review row keeps, newest first. */
export const DECLINED_KEPT = 50;

/** A new contract version, or runtime additions outside what was reviewed, waiting for an admin. Changed items stay off. */
export const PendingReview = z.object({
  version: z.string(),
  hash: z.string().min(1),
  /** `contract`: a new contract version. `runtime`: additions the running system made outside what was reviewed. */
  by: DeclaredBy,
  changes: z.array(ContractChange),
  since: Timestamp,
});
export type PendingReview = z.infer<typeof PendingReview>;

/** The hub's review row for a system (table `systemReviews`): what is live, what waits, and its last install checks. */
export const SystemReviewRecord = z.object({
  system: SystemName,
  live: LiveContract.optional(),
  pending: PendingReview.optional(),
  /** Copied from the install run's approval preview (`ApprovalPreview.checks`) when it pairs. */
  checks: InstallChecks.optional(),
  /** The changes admins declined, newest first (at most `DECLINED_KEPT`). */
  declined: z.array(DeclinedChange).optional(),
  updatedAt: Timestamp,
});
export type SystemReviewRecord = z.infer<typeof SystemReviewRecord>;

/** What a fn's declaration says about it, for the before and after of a change (the hub's `fnMode` for its mode). */
export const DeclaredFnFacts = z.object({
  mode: FnMode,
  /** What it changes in the hub, in one line (`effectsLine`). */
  effects: z.string().optional(),
  reads: z.array(QualifiedName),
  writes: z.array(QualifiedName),
  deps: z.array(QualifiedName),
  /** Its rough cost per run (`FnLimits.cost`). */
  cost: Usd.optional(),
  /** Its own work spends nothing (`FnEffects.free`). */
  free: z.boolean().optional(),
});
export type DeclaredFnFacts = z.infer<typeof DeclaredFnFacts>;

/** A changed fn's facts before and after (absent on the side where it doesn't exist). */
export const FnChangeFacts = z.object({ name: z.string().min(1), before: DeclaredFnFacts.optional(), after: DeclaredFnFacts.optional() });
export type FnChangeFacts = z.infer<typeof FnChangeFacts>;

/**
 * A pending review as the review page reads it, with what the hub works out on each read: what its changes amount to
 * (`summary`), each changed fn's facts before and after, and each change to what agents are told (`injections`: the
 * targets of each new, changed or gone injection with the agents they hit now).
 */
export const PendingReviewView = PendingReview.extend({ summary: ReviewSummary, fns: z.array(FnChangeFacts), injections: z.array(InjectionChangeView).default([]) });
export type PendingReviewView = z.infer<typeof PendingReviewView>;

/** The rule a refused call broke. */
export const REFUSAL_RULES = ['stage', 'effects', 'mode', 'types', 'capability', 'models', 'budget', 'secrets', 'calls', 'network', 'files', 'visibility'] as const;
export const RefusalRule = z.enum(REFUSAL_RULES);
export type RefusalRule = z.infer<typeof RefusalRule>;

/** One call the hub (or fs's supervisor) refused because the system went past what it declared (table `refusals`). */
export const RefusalRecord = z.object({
  id: RefusalId,
  system: SystemName,
  instance: InstanceName,
  rule: RefusalRule,
  /** What was attempted: a link endpoint (`llm`), a fn (`fs/write`), a host, a path or a secret's name. */
  attempt: z.string().min(1),
  /** One readable line: "fs/read is declared read and called fs/write". */
  detail: z.string().min(1),
  run: RunId.optional(),
  fn: QualifiedName.optional(),
  at: Timestamp,
});
export type RefusalRecord = z.infer<typeof RefusalRecord>;

/** The rules a host's supervisor enforces on the machine, under Node's permission model and its allowlist proxy. */
export const HostRefusalRule = RefusalRule.extract(['network', 'files']);
export type HostRefusalRule = z.infer<typeof HostRefusalRule>;

/**
 * A refusal a host saw on the machine (`reportRefusal` on the link): a host its allowlist proxy refused, or a path
 * Node's permission model refused, for an instance it hosts. The hub keeps it as that instance's `RefusalRecord`.
 */
export const HostRefusal = z.object({
  instance: InstanceRef,
  rule: HostRefusalRule,
  /** The host (`api.example.com:443`) or the path. */
  attempt: z.string().min(1).max(1000),
  detail: z.string().min(1).max(2000),
});
export type HostRefusal = z.infer<typeof HostRefusal>;

/** A page of refusals, newest first. */
export const RefusalQuery = z.object({ system: SystemName.optional(), rule: RefusalRule.optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() });
export type RefusalQuery = z.infer<typeof RefusalQuery>;
export const RefusalPage = z.object({ items: z.array(RefusalRecord), next: z.string().optional() });
export type RefusalPage = z.infer<typeof RefusalPage>;

/**
 * Everything the review page shows about one system that its other endpoints don't (`system`, `systemFns`,
 * `systemParts` and `graph` give the rest): its stage, its contract, every fn's facts, its install checks, what is
 * live and what waits, the items switched off, and its recent refusals.
 */
export const SystemReview = z.object({
  system: SystemName,
  stage: SystemStage,
  manifest: Manifest,
  facts: z.array(FnFacts),
  checks: InstallChecks.optional(),
  live: LiveContract.optional(),
  pending: PendingReviewView.optional(),
  /** The changes admins declined, newest first. */
  declined: z.array(DeclinedChange).default([]),
  off: z.array(ItemRef),
  refusals: z.object({ total: z.number().int().min(0), last: z.array(RefusalRecord).max(10) }),
  /** Short-lived links to the checks' preview images, by content hash, so the gallery can show them (made per read, never stored). */
  previewUrls: z.record(z.string(), z.string()).optional(),
  /**
   * Whether the web may load the contract's client build (its renderers and config component): only once an admin
   * approved that very build, by going live or approving the change. Absent: not approved.
   */
  clientApproved: z.boolean().optional(),
});
export type SystemReview = z.infer<typeof SystemReview>;

/** Go live, or approve a pending review: the hash the admin reviewed (refused if it moved since) and the items to keep off. */
export const GoLiveRequest = z.object({ system: SystemName, hash: z.string().min(1), off: z.array(ItemRef).default([]) });
export type GoLiveRequest = z.infer<typeof GoLiveRequest>;

/**
 * Approve some of a pending review's changes and decline others, by the hash reviewed: approved ones go live (except
 * the items in `off`), declined ones stay off and are recorded, and the rest keep waiting.
 */
export const ReviewDecision = z.object({
  system: SystemName,
  hash: z.string().min(1),
  approve: z.array(ChangeRef).default([]),
  decline: z.array(ChangeRef).default([]),
  /** Approved items to keep switched off. */
  off: z.array(ItemRef).default([]),
}).refine((decision) => decision.approve.length + decision.decline.length > 0, { message: 'approve or decline at least one change', path: ['approve'] });
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/** What a decision left: the hash now live, and how many changes still wait. */
export const ReviewDecided = z.object({ hash: z.string(), waiting: z.number().int().min(0) });
export type ReviewDecided = z.infer<typeof ReviewDecided>;

/**
 * A system's answer to a preview (`preview` on the system link): the preview, or why the run can't go ahead at all
 * (it then fails as invalid input). An install host sends the contract the card would install (`contract`): the hub
 * checks it against the subject's hash, works out the card's `summary` from it, and never stores it. A preview may
 * also offer a choice on the card (`ask`, a form of an optional type, such as "let its runs go ahead without asking"):
 * the approver's answer, when they give one, is set as the run's `args[into]` before it goes ahead.
 */
export const PreviewAnswer = z.union([
  z.object({ preview: ApprovalPreview, contract: Manifest.optional(), ask: ProposalAsk.optional() }),
  z.object({ refused: z.string().min(1) }),
]);
export type PreviewAnswer = z.infer<typeof PreviewAnswer>;

/** An admin's test call while the system is installed (or a pending item): a real run, marked as a test. */
export const TestCallRequest = z.object({ fn: QualifiedName, args: Json, instance: InstanceName.optional() });
export type TestCallRequest = z.infer<typeof TestCallRequest>;
