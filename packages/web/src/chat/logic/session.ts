/**
 * Facts about a session the chat shows around the thread: who will answer the next message (the hub's reply rule,
 * worked out the same way before sending), the agent and model it answers with, the budget meter, and what the
 * embedding index suggested for a message.
 * Pure, so they are tested alone.
 */
import { SKIP_REASON_LABELS, type ActorId, type ChatCapabilities, type ChatMessage, type LimitScope, type ModelChoice, type QualifiedName, type ResolvedLimits, type Session, type SkipReason, type SuggestionDecider } from '@harness/core';
import type { Tone } from '../../ui/index.ts';
import { formatCost } from './format.ts';
import { agentName, fnLabel, humanize, localName, systemOf } from './labels.ts';

/** Who will answer a message, by the hub's reply rule, and the words that say so. */
export interface Answerers {
  readonly agents: readonly ActorId[];
  readonly text: string;
  /** Only the session's own agent, as always with one person: the agent shown beside the box already says so. */
  readonly usual: boolean;
}

/**
 * The reply rule: with one person in the session, the session's agent answers every message. With more, an agent
 * answers a reply to one of its own messages, and every agent answers a reply-all.
 */
export function whoAnswers(session: Pick<Session, 'agent' | 'participants'>, replyTo: Pick<ChatMessage, 'author'> | undefined, replyAll: boolean): Answerers {
  const people = session.participants.filter((p) => p.role !== 'agent');
  const agents = session.participants.filter((p) => p.role === 'agent').map((p) => p.actor);
  const name = agentName(session.agent);
  if (people.length <= 1) { return { agents: agents.slice(0, 1), text: `${name} will answer`, usual: true }; }
  if (replyAll) { return { agents, text: agents.length === 1 ? `${name} will answer` : `${agents.length} agents will answer`, usual: false }; }
  if (replyTo !== undefined && agents.includes(replyTo.author)) { return { agents: [replyTo.author], text: 'The agent you reply to will answer', usual: false }; }
  return { agents: [], text: 'No agent will answer; reply to one or use Reply all', usual: false };
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

/** A fn or context the hub looked at for a message and left out, with why. */
export interface SkippedItem {
  readonly name: QualifiedName;
  readonly label: string;
  readonly system: string;
  readonly reason: SkipReason;
  /** The decision model's words, or `''`. */
  readonly note: string;
  readonly score: number | undefined;
}

/**
 * What the index suggested for a message (its `extra` and `hook` parts plus the hub's suggestion record) and what it
 * left out (from the record). `by` and `threshold` say who chose, when the hub recorded it.
 */
export interface MessageSuggestions {
  readonly context: readonly SuggestionItem[];
  readonly fns: readonly SuggestionItem[];
  readonly skippedContext?: readonly SkippedItem[];
  readonly skippedFns?: readonly SkippedItem[];
  readonly by?: SuggestionDecider;
  readonly threshold?: number;
}

/** Who chose a message's suggestions, as people read it. */
export const SUGGESTION_DECIDER_LABELS = {
  score: 'Chosen by score', decision: 'Chosen by the decision model', graph: 'Chosen by the context graph',
} as const satisfies Record<SuggestionDecider, string>;

/** A skip reason with the decision model's note when it gave one: "The decision model declined it: off topic". */
export function skipText(skipped: Pick<SkippedItem, 'reason' | 'note'>): string {
  return skipped.note === '' ? SKIP_REASON_LABELS[skipped.reason] : `${SKIP_REASON_LABELS[skipped.reason]}: ${skipped.note}`;
}

const item = (name: QualifiedName, why: string | undefined, state: SuggestionState, label: string, score?: number): SuggestionItem =>
  ({ name, label, system: systemOf(name), why: why ?? '', state, score });

/** Best match first; items without a score after the scored ones, in the order they came. */
function byScore<T extends { readonly score: number | undefined }>(items: Iterable<T>): T[] {
  return [...items].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
}

/** A match score (the index's relevance, 0 to 1: 1 is the top of every list it searched) as people read it: `0.873` → "87%". */
export function scoreText(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
}

/** The suggestions of a message; marked loaded when the session's agent has them now. */
export function messageSuggestions(message: Pick<ChatMessage, 'parts' | 'suggestions'>, session: Pick<Session, 'tools' | 'context'> | undefined): MessageSuggestions {
  const context = new Map<QualifiedName, SuggestionItem>();
  const fns = new Map<QualifiedName, SuggestionItem>();
  const loadedFns = new Set(session?.tools ?? []);
  const loadedContext = new Set(session?.context ?? []);
  for (const part of message.parts) {
    // what the suggestions chooser loaded for the turn shows as added
    if (part.type === 'loaded-for-you') {
      for (const c of part.context) { context.set(c.context, item(c.context, c.why, 'auto', c.title ?? humanize(localName(c.context)))); }
      for (const f of part.fns) { fns.set(f.fn, item(f.fn, f.why, 'auto', f.label)); }
      continue;
    }
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
  const record = message.suggestions;
  if (record === undefined) { return { context: byScore(context.values()), fns: byScore(fns.values()) }; }
  const skippedContext: SkippedItem[] = [];
  const skippedFns: SkippedItem[] = [];
  for (const outcome of record.items) {
    const label = outcome.kind === 'fn' ? fnLabel(outcome.name) : humanize(localName(outcome.name));
    if (!outcome.used) {
      (outcome.kind === 'fn' ? skippedFns : skippedContext).push({ name: outcome.name, label, system: systemOf(outcome.name), reason: outcome.reason, note: outcome.note ?? '', score: outcome.score });
      continue;
    }
    const into = outcome.kind === 'fn' ? fns : context;
    const known = into.get(outcome.name);
    const loaded = (outcome.kind === 'fn' ? loadedFns : loadedContext).has(outcome.name);
    into.set(outcome.name, known === undefined
      ? item(outcome.name, outcome.note, loaded ? 'loaded' : 'offered', label, outcome.score)
      : { ...known, why: known.why === '' ? outcome.note ?? '' : known.why, score: known.score ?? outcome.score });
  }
  return {
    context: byScore(context.values()), fns: byScore(fns.values()), skippedContext: byScore(skippedContext), skippedFns: byScore(skippedFns), by: record.by,
    ...(record.threshold === undefined ? {} : { threshold: record.threshold }),
  };
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
