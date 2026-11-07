/**
 * Facts about a session the chat shows around the thread: who will answer the next message (the hub's reply rule,
 * worked out the same way before sending), the budget meter, and what the embedding index suggested for a message.
 * Pure, so they are tested alone.
 */
import type { ActorId, BudgetId, ChatMessage, LimitScope, QualifiedName, ResolvedLimits, Session } from '@harness/core';
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

/** One budget in the meter's tooltip. */
export interface BudgetRow {
  readonly rule: BudgetId;
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
 * The meter for `limits` (what was left when they were read) after `spentSince` more was spent. Undefined when no
 * budget applies. The hub reports what is left, not each budget's size, so "used" is the session's spend against it
 * plus what is left.
 */
export function budgetMeter(limits: ResolvedLimits | undefined, spent: number, spentSince: number): BudgetMeter | undefined {
  if (limits === undefined || limits.budgets.length === 0) { return undefined; }
  const rows = limits.budgets.map((b) => ({ rule: b.rule, label: scopeLabel(b.scope), left: Math.max(0, b.remaining - spentSince), tightest: false }));
  const tightestRule = limits.limitedBy ?? [...rows].sort((a, b) => a.left - b.left)[0]?.rule;
  const marked = rows.map((row) => ({ ...row, tightest: row.rule === tightestRule }));
  const tight = marked.find((row) => row.tightest) ?? marked[0];
  if (tight === undefined) { return undefined; }
  const fraction = tight.left <= 0 ? 1 : spent <= 0 ? 0 : spent / (spent + tight.left);
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
}

/** What the index suggested for a message, from its `extra` and `hook` parts. */
export interface MessageSuggestions {
  readonly context: readonly SuggestionItem[];
  readonly fns: readonly SuggestionItem[];
}

const item = (name: QualifiedName, why: string | undefined, state: SuggestionState, label: string): SuggestionItem =>
  ({ name, label, system: systemOf(name), why: why ?? '', state });

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
        for (const s of block.items) { context.set(s.context, item(s.context, s.why, loadedContext.has(s.context) ? 'loaded' : 'offered', humanize(localName(s.context)))); }
      } else if (block.type === 'suggest-fns') {
        for (const s of block.items) { fns.set(s.fn, item(s.fn, s.why, loadedFns.has(s.fn) ? 'loaded' : 'offered', fnLabel(s.fn))); }
      } else if (block.type === 'load') {
        for (const name of block.context ?? []) { context.set(name, item(name, undefined, 'auto', humanize(localName(name)))); }
        for (const name of block.fns ?? []) { fns.set(name, item(name, undefined, 'auto', fnLabel(name))); }
      }
    }
  }
  return { context: [...context.values()], fns: [...fns.values()] };
}

/** The words for a suggestion's state. */
export const SUGGESTION_STATE = { auto: 'Added', offered: 'Offered', loaded: 'Loaded' } as const satisfies Record<SuggestionState, string>;
