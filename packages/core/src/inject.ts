/**
 * Injected context, as declared: a context item's `inject` (`InjectDecl`) names the agents (`hub/llm` fns) whose
 * system prompts it goes into, each by its exact qualified name or by a pattern (`AgentTargetDecl`), and an agent says
 * how it takes its injected section (`AgentInjected`). `targetHits` is the one place a pattern is matched; the hub and
 * the SDK's build check targets with `injectTargetProblems`. Kept apart from `manifest.ts` so the context options
 * (`context-graph.ts`) can use it too.
 */
import { z } from 'zod';
import { QualifiedName } from './primitives.ts';

// ─── Injected context: targets and patterns ───────────────────────────────────

/**
 * A target as declared: an agent's exact qualified name (`crm/reviewer`), or a pattern (`*`, or `system/local` holding
 * `*`). Each `*` stands for any run of characters (none included) on its own side of the `/`: it crosses `.`, never
 * `/`. `*` is the only special character; `**` is refused. Case counts.
 */
export const AGENT_TARGET_PATTERN = /^(?:\*|[a-z*][a-z0-9*-]*\/[A-Za-z0-9_*][A-Za-z0-9_.*-]*)$/;
export const AgentTargetDecl = z.string()
  .regex(AGENT_TARGET_PATTERN, 'an agent\'s name (crm/reviewer) or a pattern (hub/chat*, crm/*, *)')
  .refine((target) => !target.includes('**'), 'write one *');
export type AgentTargetDecl = z.infer<typeof AgentTargetDecl>;

/** Whether a target is a pattern (holds `*`) rather than one agent's exact name. */
export function isAgentPattern(target: string): boolean {
  return target.includes('*');
}

/** One side of a pattern as a regular expression: `*` is any run of characters but `/`, the rest stands for itself. */
function sideRegex(side: string): RegExp {
  return new RegExp(`^${side.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
}

/**
 * Whether an agent's qualified name is hit by a target: `*` alone hits every agent; an exact name hits only itself;
 * a pattern's `*` is any run of characters on its side of the `/` (crossing `.`, never `/`). Case counts.
 */
export function targetHits(target: AgentTargetDecl, agent: QualifiedName): boolean {
  if (target === '*') { return true; }
  if (!isAgentPattern(target)) { return target === agent; }
  const slash = target.indexOf('/');
  const at = agent.indexOf('/');
  if (slash < 0 || at < 0) { return false; }
  return sideRegex(target.slice(0, slash)).test(agent.slice(0, at)) && sideRegex(target.slice(slash + 1)).test(agent.slice(at + 1));
}

/** The agents a target hits, of those given, in their order. */
export function targetAgents(target: AgentTargetDecl, agents: readonly QualifiedName[]): QualifiedName[] {
  return agents.filter((agent) => targetHits(target, agent));
}

/**
 * What the hub and the SDK's build say about an item's targets, given every agent there is now: an exact name that is
 * no agent is refused (`problems`); a pattern that hits no agent yet is accepted with a warning (`warnings`), since an
 * agent installed later that it hits receives the item when it arrives.
 */
export function injectTargetProblems(into: readonly AgentTargetDecl[], agents: readonly QualifiedName[]): { problems: string[]; warnings: string[] } {
  const known = new Set<string>(agents);
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const target of into) {
    if (!isAgentPattern(target)) {
      if (!known.has(target)) { problems.push(`${target} is not an agent: inject into hub/llm fns only`); }
    } else if (targetAgents(target, agents).length === 0) {
      warnings.push(`${target} hits no agent yet`);
    }
  }
  return { problems, warnings };
}

/**
 * Where an item of context is injected: into the system prompts of the agents it targets, once an admin approved it
 * (a system's injection waits in its Pending review like any contract change), unless an admin switches it off for
 * an agent. Its `fns` join those agents' starting tools.
 */
export const InjectDecl = z.object({
  /** The agents it goes into: exact agent names or patterns (`AgentTargetDecl`). At least one. */
  into: z.array(AgentTargetDecl).min(1),
  /** Lower comes first. Default 100; the hub's own items are 10 to 30. */
  order: z.number().int().min(0).max(1000).default(100),
  /** Fns its text names without bringing them: it is left out unless they can be used too (as must its `fns`). */
  requires: z.array(QualifiedName).default([]),
  /** Only in this chat mode; absent, in both. */
  mode: z.enum(['tools', 'static']).optional(),
});
export type InjectDecl = z.infer<typeof InjectDecl>;

/**
 * How an agent takes its injected section: `none`, or its detail (`summary` gives each item at its summary, for a
 * small window) and a cap on the section's tokens (items past it fall back to their summary, a listing, then out).
 * Its instructions may hold `{{injectedContext}}`; without it the section follows them.
 */
export const AgentInjected = z.union([
  z.literal('none'),
  z.object({ detail: z.enum(['full', 'summary']).default('full'), maxTokens: z.number().int().min(1).optional() }),
]);
export type AgentInjected = z.infer<typeof AgentInjected>;
