/**
 * Injected context as the hub reads it back: each context item's injection with what its targets hit now and where its
 * review stands (`ContextInjection`, what the catalog lists for the planner and the admin pages), and one target with
 * the agents it hits (`InjectTargetView`, what a review card and an item's page show).
 */
import { z } from 'zod';
import { AgentTargetDecl, InjectDecl } from '../inject.ts';
import { QualifiedName, SystemName } from '../primitives.ts';

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
});
export type InjectionChangeView = z.infer<typeof InjectionChangeView>;
