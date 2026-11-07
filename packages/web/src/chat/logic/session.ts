/**
 * Facts about a session the chat shows around the thread: who will answer the next message (the hub's reply rule,
 * worked out the same way before sending), the agent and model it answers with, the budget meter, and what the
 * embedding index suggested for a message.
 * Pure, so they are tested alone.
 */
import type { ActorId, ChatCapabilities, ChatMessage, LimitScope, ModelChoice, QualifiedName, ResolvedLimits, Session } from '@harness/core';
import type { Tone } from '../../ui/index.ts';
import { formatCost } from './format.ts';
import { agentName, fnLabel, humanize, localName, systemOf } from './labels.ts';

/** Who will answer a message, by the hub's reply rule, and the words that say so. */
export interface Answerers {
  readonly agents: readonly ActorId[];
  readonly text: string;
}

/**
 * The reply rule: with one person in the session, the session's agent answers every message. With more, an agent
 * answers a reply to one of its own messages, and every agent answers a reply-all.
 */
export function whoAnswers(session: Pick<Session, 'agent' | 'participants'>, replyTo: Pick<ChatMessage, 'author'> | undefined, replyAll: boolean): Answerers {
  const people = session.participants.filter((p) => p.role !== 'agent');
  const agents = session.participants.filter((p) => p.role === 'agent').map((p) => p.actor);
  const name = agentName(session.agent);
  if (people.length <= 1) { return { agents: agents.slice(0, 1), text: `${name} will answer` }; }
  if (replyAll) { return { agents, text: agents.length === 1 ? `${name} will answer` : `${agents.length} agents will answer` }; }
  if (replyTo !== undefined && agents.includes(replyTo.author)) { return { agents: [replyTo.author], text: 'The agent you reply to will answer' }; }
  return { agents: [], text: 'No agent will answer; reply to one or use Reply all' };
}

/** A budget's scope for people: "Session", "Your budget", "Group", "Hub". */
export function scopeLabel(scope: LimitScope): string {
  switch (scope.scope) {
    case 'hub': return 'Hub';
    case 'group': return 'Group';
    case 'user': return 'Your budget';
    case 'session': return 'This session';
    case 'turn': return 'This turn';
    case 'system': return `System ${scope.system}`;
    case 'fn': return fnLabel(scope.fn);
    case 'model': return `Model ${scope.model}`;
  }
}

/** One limit in the meter's tooltip: a budget rule (keyed by its id), or the cap every turn gets (keyed `turn`). */
export interface BudgetRow {
  readonly key: string;
  readonly label: string;
  readonly left: number;
  readonly tightest: boolean;
}

/** The budget meter: how much of the tightest budget is used, its tone, and every budget for the tooltip. */
export interface BudgetMeter {
  readonly label: string;
  /** Spent over spent-plus-left, 0 to 1. */
  readonly fraction: number;
  readonly tone: Tone;
  readonly text: string;
  readonly rows: readonly BudgetRow[];
}

/** When the meter turns amber, as a share used. */
export const BUDGET_WARN_AT = 0.8;

/**
 * The meter for `limits` (what was left when they were read) after `spentSince` more was spent, with the cap each
 * turn gets as a limit too (`turnSpent` is what the turn going now has spent). Undefined when nothing limits. The hub
 * reports what is left, not each budget's size, so "used" is the spend against it plus what is left.
 */
export function budgetMeter(limits: ResolvedLimits | undefined, spent: number, spentSince: number, turnSpent = 0): BudgetMeter | undefined {
  if (limits === undefined) { return undefined; }
  const rows = [
    ...limits.budgets.map((b) => ({ key: b.rule, label: scopeLabel(b.scope), left: Math.max(0, b.remaining - spentSince), used: spent })),
    ...(limits.turn.cost > 0 ? [{ key: 'turn', label: 'Each turn', left: Math.max(0, limits.turn.cost - turnSpent), used: turnSpent }] : []),
  ];
  const tightestKey: string | undefined = limits.limitedBy ?? [...rows].sort((a, b) => a.left - b.left)[0]?.key;
  const marked = rows.map(({ used: _, ...row }) => ({ ...row, tightest: row.key === tightestKey }));
  const tight = rows.find((row) => row.key === tightestKey) ?? rows[0];
  if (tight === undefined) { return undefined; }
  const fraction = tight.left <= 0 ? 1 : tight.used <= 0 ? 0 : tight.used / (tight.used + tight.left);
  const tone: Tone = tight.left <= 0 ? 'danger' : fraction >= BUDGET_WARN_AT ? 'warn' : 'ok';
  return { label: tight.label, fraction, tone, text: tight.left <= 0 ? `${tight.label}: budget reached` : `${formatCost(tight.left)} left · ${tight.label}`, rows: marked };
}

/** How a suggestion reached the turn: added by itself, only offered, or loaded by the agent. */
export type SuggestionState = 'auto' | 'offered' | 'loaded';

/** A fn or context the hub suggested for a message. */
export interface SuggestionItem {
  readonly name: QualifiedName;
  readonly label: string;
  readonly system: string;
  readonly why: string;
  readonly state: SuggestionState;
  /** How well it matched the message (higher is better); absent for what was added without a match. */
  readonly score: number | undefined;
}

/** What the index suggested for a message, from its `extra` and `hook` parts. */
export interface MessageSuggestions {
  readonly context: readonly SuggestionItem[];
  readonly fns: readonly SuggestionItem[];
}

const item = (name: QualifiedName, why: string | undefined, state: SuggestionState, label: string, score?: number): SuggestionItem =>
  ({ name, label, system: systemOf(name), why: why ?? '', state, score });

/** Best match first; items without a score after the scored ones, in the order they came. */
function byScore(items: Iterable<SuggestionItem>): SuggestionItem[] {
  return [...items].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
}

/** A match score as people read it: `0.873` → "87%". */
export function scoreText(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
}

/** The suggestions of a message; marked loaded when the session's agent has them now. */
export function messageSuggestions(message: Pick<ChatMessage, 'parts'>, session: Pick<Session, 'tools' | 'context'> | undefined): MessageSuggestions {
  const context = new Map<QualifiedName, SuggestionItem>();
  const fns = new Map<QualifiedName, SuggestionItem>();
  const loadedFns = new Set(session?.tools ?? []);
  const loadedContext = new Set(session?.context ?? []);
  for (const part of message.parts) {
    if (part.type !== 'extra' && part.type !== 'hook') { continue; }
    for (const block of part.blocks) {
      if (block.type === 'suggest-context') {
        for (const s of block.items) { context.set(s.context, item(s.context, s.why, loadedContext.has(s.context) ? 'loaded' : 'offered', humanize(localName(s.context)), s.score)); }
      } else if (block.type === 'suggest-fns') {
        for (const s of block.items) { fns.set(s.fn, item(s.fn, s.why, loadedFns.has(s.fn) ? 'loaded' : 'offered', fnLabel(s.fn), s.score)); }
      } else if (block.type === 'load') {
        for (const name of block.context ?? []) { context.set(name, item(name, undefined, 'auto', humanize(localName(name)))); }
        for (const name of block.fns ?? []) { fns.set(name, item(name, undefined, 'auto', fnLabel(name))); }
      }
    }
  }
  return { context: byScore(context.values()), fns: byScore(fns.values()) };
}

/** The words for a suggestion's state. */
export const SUGGESTION_STATE = { auto: 'Added', offered: 'Offered', loaded: 'Loaded' } as const satisfies Record<SuggestionState, string>;

/** A chat's model as a picker's value: `default` for the one its agent's fn chooses, else `model:<id>`. */
export type ModelPick = 'default' | `model:${string}`;

/** The picker value of a chat's model choice. A category or automatic choice shows as the agent's (it isn't one id). */
export function modelPick(choice: ModelChoice | undefined): ModelPick {
  return choice !== undefined && 'model' in choice ? `model:${choice.model}` : 'default';
}

/** The model choice a picker value stands for: `null` goes back to the agent's own. */
export function modelChoiceOf(pick: ModelPick): ModelChoice | null {
  return pick === 'default' ? null : { model: pick.slice('model:'.length) };
}

/** What a chat answers with, in words: the model's name, a category, or the agent's own choice. */
export function modelLabel(choice: ModelChoice | undefined, models: ChatCapabilities['models']): string {
  if (choice === undefined) { return 'Agent’s model'; }
  if ('model' in choice) { return models.find((m) => m.id === choice.model)?.name ?? choice.model; }
  if ('category' in choice) { return `${humanize(choice.category)} models`; }
  return 'Automatic';
}

/** The agents a chat can switch to, as picker options: each agent's name and what it does, the current one first. */
export function agentOptions(agents: ChatCapabilities['agents'], current: QualifiedName | undefined): Array<{ fn: QualifiedName; name: string; description: string }> {
  const listed = agents.some((a) => a.fn === current) || current === undefined ? agents : [{ fn: current, description: '' }, ...agents];
  return [...listed].sort((a, b) => Number(b.fn === current) - Number(a.fn === current)).map((a) => ({ fn: a.fn, name: agentName(a.fn), description: a.description }));
}
