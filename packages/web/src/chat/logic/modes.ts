/**
 * Chat modes and contextors as the chat's settings show them: each variant's words, its settings as a gin type (read
 * off core's zod schema, without the `type` it is picked by) for the value editor, its defaults, and a choice read
 * back into the core config. And the context inspector's reading of a `SelectionReport`: how the window was split,
 * and the chosen items ranked by weight. Pure, so it is tested alone.
 */
import {
  ChatModeConfig, ContextorConfig, Json, type ChatModeType, type ContextorType, type Detail, type GinTypeDef, type SelectionReport, type SelectedItem,
} from '@harness/core';
import { ginOf, wireType } from '@harness/sdk';
import type { z } from 'zod';

/** One variant as the settings show it. */
export interface VariantChoice<T extends string> {
  readonly type: T;
  readonly label: string;
  readonly about: string;
  /** The variant's settings without `type`, for the value editor; absent when it has none. */
  readonly settings: GinTypeDef | undefined;
}

/** What each chat mode is, in plain words. */
const MODE_WORDS = {
  tools: { label: 'Strict tools', about: 'Every fn the agent may use is a native tool. Exact, but costs more tokens.' },
  static: { label: 'Static toolset', about: 'Five fixed tools; fns show as cards and the agent runs any with run(). Cheaper, looser.' },
} as const satisfies Record<ChatModeType, { label: string; about: string }>;

/** What each contextor is, in plain words. */
const CONTEXTOR_WORDS = {
  plain: { label: 'Whole conversation', about: 'Sends the whole conversation, trimmed oldest first only when it would not fit.' },
  suggest: { label: 'Suggestions', about: 'Adds suggested fns and context to each message, and can put the best context in the prompt.' },
  graph: { label: 'Context graph', about: 'A fresh prompt each message: the relevant history and the likely context and fns, chosen by weight to fit the model.' },
} as const satisfies Record<ContextorType, { label: string; about: string }>;

/** The settings of a variant, without its `type`, as a gin type (or none when `type` is all it has). */
function settingsOf(option: z.ZodObject): GinTypeDef | undefined {
  const rest = option.omit({ type: true });
  return Object.keys(rest.shape).length === 0 ? undefined : wireType(ginOf(rest));
}

/** The chat modes, in the order core lists them. */
export const MODE_CHOICES: readonly VariantChoice<ChatModeType>[] = ChatModeConfig.options.map((option) => {
  const type = option.shape.type.value;
  return { type, ...MODE_WORDS[type], settings: settingsOf(option) };
});

/** The contextors, in the order core lists them. */
export const CONTEXTOR_CHOICES: readonly VariantChoice<ContextorType>[] = ContextorConfig.options.map((option) => {
  const type = option.shape.type.value;
  return { type, ...CONTEXTOR_WORDS[type], settings: settingsOf(option) };
});

/** A variant's defaults: the config core makes of its `type` alone. */
export function defaultMode(type: ChatModeType): ChatModeConfig {
  return ChatModeConfig.parse({ type });
}

/** A contextor's defaults: the config core makes of its `type` alone. */
export function defaultContextor(type: ContextorType): ContextorConfig {
  return ContextorConfig.parse({ type });
}

/** A config's settings without its `type`, as the value editor edits them. */
export function settingsValue(config: ChatModeConfig | ContextorConfig): Json {
  const { type: _type, ...rest } = config;
  return Json.parse(rest);
}

/** A mode read back from its type and edited settings; undefined when they don't make a valid mode. */
export function modeFrom(type: ChatModeType, settings: Json): ChatModeConfig | undefined {
  const parsed = ChatModeConfig.safeParse({ ...(isObject(settings) ? settings : {}), type });
  return parsed.success ? parsed.data : undefined;
}

/** A contextor read back from its type and edited settings; undefined when they don't make a valid contextor. */
export function contextorFrom(type: ContextorType, settings: Json): ContextorConfig | undefined {
  const parsed = ContextorConfig.safeParse({ ...(isObject(settings) ? settings : {}), type });
  return parsed.success ? parsed.data : undefined;
}

function isObject(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A mode's or contextor's label. */
export const modeLabel = (type: ChatModeType): string => MODE_WORDS[type].label;
export const contextorLabel = (type: ContextorType): string => CONTEXTOR_WORDS[type].label;

// ─── The context inspector ────────────────────────────────────────────────────

/** The parts a prompt's window is split into, in the order the budget bar draws them. */
export const BUDGET_PARTS = ['fixed', 'history', 'context', 'fns', 'margin', 'reasoning', 'output', 'free'] as const;
export type BudgetPart = (typeof BUDGET_PARTS)[number];

/** What each part of the window is, in plain words. */
export const BUDGET_WORDS = {
  fixed: { label: 'Fixed', about: 'Instructions, the mode’s tools and the current message.' },
  history: { label: 'History', about: 'Earlier messages of this chat.' },
  context: { label: 'Context', about: 'Context items the contextor chose.' },
  fns: { label: 'Fns', about: 'Fns shown as tools or cards.' },
  margin: { label: 'Margin', about: 'Kept free in case the estimate is low.' },
  reasoning: { label: 'Reasoning', about: 'Kept for the model to think.' },
  output: { label: 'Reply', about: 'Kept for the answer.' },
  free: { label: 'Unused', about: 'Room nothing needed.' },
} as const satisfies Record<BudgetPart, { label: string; about: string }>;

/** One part of the window, in tokens and as a share of it. */
export interface BudgetSlice {
  readonly part: BudgetPart;
  readonly tokens: number;
  readonly share: number;
  /** For history, context and fns: how much it asked for. */
  readonly asked?: number;
}

/** How a prompt's window was spent, part by part (parts with no tokens left out), adding up to the window. */
export function budgetSlices(budget: SelectionReport['budget']): BudgetSlice[] {
  const { window, output, reasoning, margin, fixed, pools } = budget;
  const used = fixed + pools.history.got + pools.context.got + pools.fns.got;
  const free = Math.max(0, window - output - reasoning - margin - used);
  const tokens: Record<BudgetPart, number> = { fixed, history: pools.history.got, context: pools.context.got, fns: pools.fns.got, margin, reasoning, output, free };
  const total = Math.max(1, window);
  return BUDGET_PARTS.filter((part) => tokens[part] > 0).map((part) => ({
    part, tokens: tokens[part], share: tokens[part] / total,
    ...(part === 'history' || part === 'context' || part === 'fns' ? { asked: pools[part].asked } : {}),
  }));
}

/** The prompt's budget for input: the window less the reply, reasoning and margin. */
export function inputBudget(budget: SelectionReport['budget']): number {
  return Math.max(0, budget.window - budget.output - budget.reasoning - budget.margin);
}

/** How full the input budget the request's estimate came to (0 to 1). */
export function budgetFill(budget: SelectionReport['budget']): number {
  const room = inputBudget(budget);
  return room === 0 ? 1 : Math.min(1, budget.estimate / room);
}

/** Detail levels, most first, for ordering. */
const DETAIL_RANK = { full: 0, signature: 1, listed: 2 } as const satisfies Record<Detail, number>;

/** What each detail level means for an item, in plain words. */
export const DETAIL_WORDS = {
  listed: 'Name only',
  signature: 'Signature',
  full: 'In full',
} as const satisfies Record<Detail, string>;

/** A chosen item as the inspector lists it: its weight as a share of the strongest one's. */
export interface RankedItem extends SelectedItem {
  readonly weight: number;
}

/** Items most detailed and strongest first, each with its activation relative to the strongest. */
export function rankItems(items: readonly SelectedItem[]): RankedItem[] {
  const top = Math.max(0, ...items.map((item) => item.activation));
  return [...items]
    .sort((a, b) => DETAIL_RANK[a.detail] - DETAIL_RANK[b.detail] || b.activation - a.activation || a.name.localeCompare(b.name))
    .map((item) => ({ ...item, weight: top === 0 ? 0 : item.activation / top }));
}
