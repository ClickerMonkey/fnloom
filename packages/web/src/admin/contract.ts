/**
 * The admin pages' reads that `hubWebSpec` doesn't have yet: listing what the admin endpoints set (budgets, priority
 * rules, policies, model categories, actor settings), browsing runs, LLM calls and resources, a system's fns and
 * logs, the resolved limits for any person, and removing a rule. They are written with the same middleware defs and
 * record schemas as `hubWebSpec`, so moving `adminReads` and `adminEvents` into core's admin group is a cut and paste
 * and nothing in the web app changes. Until the hub serves them, the pages that use them say so.
 */
import { spec, use } from '@ayepi/core';
import {
  Actor, ActorId, ActorKind, ActorSetting, BudgetId, BudgetRule, FnRecord, LlmInteraction, LlmStatus, ModelCategory, ModelCategoryId, PageRequest, Policy,
  PolicyId, PriorityRule, PriorityRuleId, ProviderId, QualifiedName, ResolvedLimits, ResourceRecord, Run, RunStatus, SessionId, SettingDecl, SystemName,
  Timestamp, Usd, adminOnly, hubAuth, hubWebSpec, page, tel,
} from '@harness/core';
import { z } from 'zod';

/** One line of an installed system's output, or a note the hub wrote about it (started, crashed, upgraded). Not core's `LogLine`, which is a structured log a connected system sends over the link. */
export const OutputLine = z.object({ at: Timestamp, stream: z.enum(['stdout', 'stderr', 'hub']), text: z.string() });
export type OutputLine = z.infer<typeof OutputLine>;

/** A model a provider offers, as aeye's model list describes it. Prices are per million tokens. */
export const ModelInfo = z.object({
  id: z.string(),
  provider: ProviderId,
  name: z.string(),
  contextWindow: z.number().int().min(0).optional(),
  pricing: z.object({ input: Usd, output: Usd }).optional(),
  /** What it can do: `chat`, `tools`, `vision`, `reasoning`, `embedding`, … */
  capabilities: z.array(z.string()),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** A budget with what has been spent in its current period. */
export const BudgetView = BudgetRule.extend({ spent: Usd });
export type BudgetView = z.infer<typeof BudgetView>;

/** An actor setting a system declared. */
export const SettingView = z.object({ setting: QualifiedName, system: SystemName, decl: SettingDecl });
export type SettingView = z.infer<typeof SettingView>;

/** What the runs browser can narrow by. */
export const RunFilter = z.object({ status: RunStatus.optional(), fn: z.string().optional(), system: SystemName.optional(), session: SessionId.optional() });
export type RunFilter = z.infer<typeof RunFilter>;

/** An LLM call in a list: everything but the request and response, which `llmCall` fetches. */
export const LlmSummary = LlmInteraction.omit({ request: true, response: true });
export type LlmSummary = z.infer<typeof LlmSummary>;

/** What the LLM calls browser can narrow by. */
export const LlmFilter = z.object({ status: LlmStatus.optional(), model: z.string().optional(), system: SystemName.optional(), session: SessionId.optional() });
export type LlmFilter = z.infer<typeof LlmFilter>;

/** What the resources browser can narrow by. */
export const ResourceFilter = z.object({ search: z.string().optional(), system: SystemName.optional() });
export type ResourceFilter = z.infer<typeof ResourceFilter>;

/** A rule an admin can remove, by what it is. */
export const RuleRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('budget'), id: BudgetId }),
  z.object({ kind: z.literal('priority'), id: PriorityRuleId }),
  z.object({ kind: z.literal('policy'), id: PolicyId }),
  z.object({ kind: z.literal('category'), id: ModelCategoryId }),
  z.object({ kind: z.literal('provider'), id: ProviderId }),
]);
export type RuleRef = z.infer<typeof RuleRef>;

/** The proposed admin reads. */
export const adminReads = use(tel, hubAuth, adminOnly).group({
  /** A system's fns, with whether each can be used now and its running numbers. */
  systemFns: { body: z.object({ system: SystemName }), response: z.array(FnRecord), ws: 'systemFns' },
  /** The end of an installed system's output, oldest first; new lines arrive on `systemLog`. */
  systemLogs: { body: z.object({ system: SystemName, limit: z.number().int().min(1).max(2_000).optional() }), response: z.array(OutputLine), ws: 'systemLogs' },
  models: { body: z.object({ provider: ProviderId.optional() }), response: z.array(ModelInfo), ws: 'models' },
  modelCategories: { body: z.object({}), response: z.array(ModelCategory), ws: 'modelCategories' },
  budgets: { body: z.object({}), response: z.array(BudgetView), ws: 'budgets' },
  priorityRules: { body: z.object({}), response: z.array(PriorityRule), ws: 'priorityRules' },
  /** The priority and budgets a turn by `user` (in `session`, when given) would get now. */
  resolveLimits: { body: z.object({ user: ActorId, session: SessionId.optional() }), response: ResolvedLimits, ws: 'resolveLimits' },
  policies: { body: z.object({}), response: z.array(Policy), ws: 'policies' },
  actors: { body: z.object({ kind: ActorKind.optional() }), response: z.array(Actor), ws: 'actors' },
  actorSettings: { body: z.object({}), response: z.object({ declared: z.array(SettingView), values: z.array(ActorSetting) }), ws: 'actorSettings' },
  /** Runs, newest first. */
  runs: { body: PageRequest.extend(RunFilter.shape), response: page(Run), ws: 'runs' },
  /** LLM calls, newest first. */
  llmCalls: { body: PageRequest.extend(LlmFilter.shape), response: page(LlmSummary), ws: 'llmCalls' },
  /** Resources the hub knows, most recently seen first. */
  resources: { body: PageRequest.extend(ResourceFilter.shape), response: page(ResourceRecord), ws: 'resources' },
  removeRule: { body: RuleRef, response: z.object({ ok: z.boolean() }), ws: 'removeRule' },
});

/** The proposed admin events. */
export const adminEvents = {
  /** New output lines of one installed system. */
  systemLog: { params: z.object({ system: SystemName }), data: OutputLine, guard: [hubAuth, adminOnly], ws: 'on.systemLog' },
};

/** Only the proposed part, for its manifest. */
export const proposedSpec = spec({ endpoints: adminReads, events: adminEvents });

/** The web API the app is typed by: the hub's, plus the proposed admin reads. */
export const webSpec = spec({
  endpoints: { ...hubWebSpec.endpoints, ...adminReads },
  events: { ...hubWebSpec.events, ...adminEvents },
});
export type WebSpec = typeof webSpec;
