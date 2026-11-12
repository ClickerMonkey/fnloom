/**
 * Installed vs live. A paired system is `installed`: the hub knows its contract but offers nothing. An admin
 * reviews everything it declares on the review page (`SystemReview`), switches items off, configures it, makes test
 * calls, and goes live: the reviewed contract and its hash are saved (`LiveContract`). A later contract version, or a
 * runtime addition outside what was reviewed, waits as a `PendingReview` with its changes while the live version keeps
 * working. Every call the hub refuses because a system went past what it declared is a `RefusalRecord`.
 */
import { z } from 'zod';
import { InstallChecks } from './checks.ts';
import { FnFacts } from './fn-facts.ts';
import { SystemGrants, SystemStage } from './grants.ts';
import { Manifest } from './manifest.ts';
import { ActorId, IDS, InstanceName, InstanceRef, Json, QualifiedName, RunId, SystemName, Timestamp } from './primitives.ts';
import { DeclaredBy } from './records/systems.ts';
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
  updatedAt: Timestamp,
});
export type SystemReviewRecord = z.infer<typeof SystemReviewRecord>;

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
  pending: PendingReview.optional(),
  off: z.array(ItemRef),
  refusals: z.object({ total: z.number().int().min(0), last: z.array(RefusalRecord).max(10) }),
  /** Short-lived links to the checks' preview images, by content hash, so the gallery can show them (made per read, never stored). */
  previewUrls: z.record(z.string(), z.string()).optional(),
});
export type SystemReview = z.infer<typeof SystemReview>;

/** Go live, or approve a pending review: the hash the admin reviewed (refused if it moved since) and the items to keep off. */
export const GoLiveRequest = z.object({ system: SystemName, hash: z.string().min(1), off: z.array(ItemRef).default([]) });
export type GoLiveRequest = z.infer<typeof GoLiveRequest>;

/** An admin's test call while the system is installed (or a pending item): a real run, marked as a test. */
export const TestCallRequest = z.object({ fn: QualifiedName, args: Json, instance: InstanceName.optional() });
export type TestCallRequest = z.infer<typeof TestCallRequest>;
