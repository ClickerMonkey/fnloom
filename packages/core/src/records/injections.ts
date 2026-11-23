/**
 * Injected context as the hub reads it back: each context item's injection with what its targets hit now and where its
 * review stands (`ContextInjection`, what the catalog lists for the planner and the admin pages), and one target with
 * the agents it hits (`InjectTargetView`, what a review card and an item's page show).
 */
import { z } from 'zod';
import { AgentTargetDecl, InjectDecl } from '../inject.ts';
import { ActorId, QualifiedName, SystemName, Timestamp } from '../primitives.ts';

/** One target of an item with the agents it hits now: the review card and the item's page show these. */
export const InjectTargetView = z.object({ target: AgentTargetDecl, agents: z.array(QualifiedName) });
export type InjectTargetView = z.infer<typeof InjectTargetView>;

/**
 * Where an injection's review stands: `approved` (live: what was reviewed, or hub-made context an admin set by hand, or
 * the hub's own), `pending` (new or changed, waiting in its system's Pending review) or `declined` (an admin declined
 * it, so it stays off).
 */
export const INJECTION_REVIEW = ['approved', 'pending', 'declined'] as const;
export const InjectionReview = z.enum(INJECTION_REVIEW);
export type InjectionReview = z.infer<typeof InjectionReview>;

/** One context item that declares `inject`, as the catalog lists it. */
export const ContextInjection = z.object({
  context: QualifiedName,
  /** Its owning system; `hub` for the hub's own and for hub-made context. */
  system: SystemName,
  /** What people (and the injected section's heading) call it: its title, else its description. */
  title: z.string(),
  inject: InjectDecl,
  /** Its fns, which join each agent's starting tools. */
  fns: z.array(QualifiedName),
  /** Each target with the agents it hits now. */
  targets: z.array(InjectTargetView),
  /** Every agent it reaches now, once each, in name order. */
  agents: z.array(QualifiedName),
  review: InjectionReview,
  /** Switched off by itself or with its system's context (`contextOff`). */
  off: z.boolean(),
  /** Written by its system at each load (dynamic context): its text can change from turn to turn. */
  dynamic: z.boolean(),
});
export type ContextInjection = z.infer<typeof ContextInjection>;

/** One hook whose `explains` is injected into the agents that get its blocks. */
export const HookExplains = z.object({
  hook: QualifiedName,
  system: SystemName,
  explains: z.string(),
  review: InjectionReview,
});
export type HookExplains = z.infer<typeof HookExplains>;

/**
 * One change in a review that changes what agents are told: a context item whose injection is new, changed (its text,
 * summary, title, targets, order, mode or fns) or gone, or a hook whose `explains` is. The review card lists its
 * targets and the agents each hits now; `tokens` is its text's rough size.
 */
export const InjectionChangeView = z.object({
  section: z.enum(['context', 'hooks']),
  name: QualifiedName,
  title: z.string(),
  change: z.enum(['added', 'changed', 'removed']),
  tokens: z.number().int().min(0).optional(),
  targets: z.array(InjectTargetView),
  agents: z.array(QualifiedName),
  /** The items it takes out of those agents' sections while it is in (`InjectDecl.replaces`); absent when none. */
  replaces: z.array(QualifiedName).optional(),
});
export type InjectionChangeView = z.infer<typeof InjectionChangeView>;

// ─── The admin's view and switches (slice F) ──────────────────────────────────

/**
 * An admin's switch (and order) for one injected item in one agent (table `injectionSettings`, keyed by agent and
 * item). Only rows that differ from the default exist: no row means on, at the item's declared order.
 */
export const InjectionSetting = z.object({
  agent: QualifiedName,
  context: QualifiedName,
  on: z.boolean(),
  /** Another order for this agent than the item declares (`inject.order`); lower comes first. */
  order: z.number().int().min(0).max(1000).optional(),
  by: ActorId,
  at: Timestamp,
});
export type InjectionSetting = z.infer<typeof InjectionSetting>;

/**
 * Why an injected item isn't in an agent's prompt now: `off` (an admin switched it off for this agent, or switched the
 * item itself off), `pending` (waiting in its system's Pending review), `declined` (an admin declined it),
 * `system-off` (its system is off or not connected), `fns-unusable` (a fn it brings or requires can't be used),
 * `mode` (it is for the other chat mode), `replaced` (an item in the section replaces it: `InjectDecl.replaces`),
 * `no-fit` (it didn't fit the agent's cap).
 */
export const INJECTION_LEFT_OUT = ['off', 'pending', 'declined', 'system-off', 'fns-unusable', 'mode', 'replaced', 'no-fit'] as const;
export const InjectionLeftOut = z.enum(INJECTION_LEFT_OUT);
export type InjectionLeftOut = z.infer<typeof InjectionLeftOut>;

/** Where an injected item comes from: a context item, or a hook's `explains` (what its block means). */
export const InjectionSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('context') }),
  z.object({ type: z.literal('hook'), hook: QualifiedName }),
]);
export type InjectionSource = z.infer<typeof InjectionSource>;

/** One injected item as an agent's Injected tab (and `hub/ctx_injections_list`) shows it. */
export const InjectionView = z.object({
  agent: QualifiedName,
  /** The context item (for a hook's `explains`, the hook's name). */
  context: QualifiedName,
  /** A context item, or a hook's `explains`. */
  source: InjectionSource,
  system: SystemName,
  /** The target that took it into this agent, as declared (`hub/chat*`, `hub/chat`). */
  via: AgentTargetDecl,
  title: z.string(),
  /** The detail the agent takes it at (`AgentInjected.detail`). */
  detail: z.enum(['full', 'summary']),
  /** As the model reads it (fn names rendered). */
  text: z.string(),
  tokens: z.number().int().min(0),
  /** Its order in this agent: the admin's, else the declared one. */
  order: z.number().int(),
  /** Whether an admin left it on for this agent (the default). */
  on: z.boolean(),
  /** Why it isn't in the agent's prompt now; absent when it is. */
  leftOut: z.object({ why: InjectionLeftOut, reason: z.string() }).optional(),
  /** Who last switched or reordered it for this agent, and when; absent when nobody has. */
  switched: z.object({ by: ActorId, at: Timestamp }).optional(),
});
export type InjectionView = z.infer<typeof InjectionView>;

/** What `hub/ctx_injections_list` answers: the injections asked for and, for one item, its targets. */
export const InjectionsPage = z.object({ injections: z.array(InjectionView), targets: z.array(InjectTargetView) });
export type InjectionsPage = z.infer<typeof InjectionsPage>;

/** What `hub/ctx_injection_set` takes: switch one item on or off for one agent, give it another order, or both. */
export const SetInjection = z.object({
  agent: QualifiedName,
  context: QualifiedName,
  on: z.boolean().optional(),
  /** Another order for this agent; `null` goes back to the item's declared order. */
  order: z.number().int().min(0).max(1000).nullable().optional(),
});
export type SetInjection = z.infer<typeof SetInjection>;
