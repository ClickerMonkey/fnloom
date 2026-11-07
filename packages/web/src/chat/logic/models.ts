/**
 * The model picker's logic: which of the hub's chat models match a search ("claude", "free", "vision 128k"), the
 * filters and sorts it offers, and a model's price, context and abilities in plain words. Pure, so it is tested alone.
 */
import type { ModelInfo } from '@harness/core';
import { formatCost, formatTokens } from './format.ts';

/** A model as the hub lists it (the chat's picker and the admin's model table both read these). */
export type ChatModel = ModelInfo;

/** The filters the picker offers: free models, and the abilities people pick a model for. */
export const MODEL_FILTERS = ['free', 'tools', 'vision', 'reasoning'] as const;
export type ModelFilter = (typeof MODEL_FILTERS)[number];

/** How each filter reads, and whether a model passes it. Every filter must have one. */
export const FILTER_LOOK = {
  free: { label: 'Free', test: (model) => isFree(model) },
  tools: { label: 'Tools', test: (model) => model.capabilities.includes('tools') },
  vision: { label: 'Vision', test: (model) => model.capabilities.includes('vision') },
  reasoning: { label: 'Reasoning', test: (model) => model.capabilities.includes('reasoning') },
} as const satisfies Record<ModelFilter, { label: string; test: (model: ChatModel) => boolean }>;

/** The orders the picker offers. */
export const MODEL_SORTS = ['name', 'price', 'context'] as const;
export type ModelSort = (typeof MODEL_SORTS)[number];

/** How each order reads, and how it compares two models. Unknown prices sort last; bigger context first. */
export const SORT_LOOK = {
  name: { label: 'Name', compare: (a, b) => a.name.localeCompare(b.name) },
  price: { label: 'Price', compare: (a, b) => priceOf(a) - priceOf(b) || a.name.localeCompare(b.name) },
  context: { label: 'Context', compare: (a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0) || a.name.localeCompare(b.name) },
} as const satisfies Record<ModelSort, { label: string; compare: (a: ChatModel, b: ChatModel) => number }>;

/** The abilities a row shows as badges, in this order. */
const SHOWN_ABILITIES = ['tools', 'vision', 'reasoning', 'structured', 'audio', 'files'] as const;

/** What the picker is asked for: the search words, the filters on, and the order. */
export interface ModelQuery {
  readonly text: string;
  readonly filters: ReadonlySet<ModelFilter>;
  readonly sort: ModelSort;
}

/** The id suffix OpenRouter gives a model's free variant (`google/gemma-4:free`), whose list price aeye leaves out. */
const FREE_VARIANT = /:free$/;

/** Whether a model costs nothing: both of its prices are zero, or it is a provider's free variant with no price listed. */
export function isFree(model: ChatModel): boolean {
  if (model.pricing === undefined) { return FREE_VARIANT.test(model.id); }
  return model.pricing.input === 0 && model.pricing.output === 0;
}

/** A model's price for sorting: what a million tokens in and out cost together, unknown prices last. */
function priceOf(model: ChatModel): number {
  if (isFree(model)) { return 0; }
  return model.pricing === undefined ? Number.POSITIVE_INFINITY : model.pricing.input + model.pricing.output;
}

/**
 * Whether a model matches the search words: every word is in its name, id, provider or abilities. A word that names a filter
 * ("free", "vision") applies that filter instead, so typing "free" shows the free models.
 */
function matches(model: ChatModel, words: readonly string[]): boolean {
  const haystack = `${model.name} ${model.id} ${model.provider} ${model.capabilities.join(' ')}`.toLowerCase();
  return words.every((word) => {
    const filter = MODEL_FILTERS.find((f) => f === word);
    return filter === undefined ? haystack.includes(word) : FILTER_LOOK[filter].test(model);
  });
}

/** The models that match a query, in its order. */
export function findModels(models: readonly ChatModel[], query: ModelQuery): ChatModel[] {
  const words = query.text.toLowerCase().split(/\s+/).filter((word) => word !== '');
  return models
    .filter((model) => matches(model, words) && [...query.filters].every((filter) => FILTER_LOOK[filter].test(model)))
    .sort(SORT_LOOK[query.sort].compare);
}

/** A model's price in words: "Free", "$0.15 in · $0.60 out per M tokens", or "Price unknown". */
export function priceText(model: ChatModel): string {
  if (isFree(model)) { return 'Free'; }
  if (model.pricing === undefined) { return 'Price unknown'; }
  return `${formatCost(model.pricing.input)} in · ${formatCost(model.pricing.output)} out per M tokens`;
}

/** A model's context size in tokens, in words ("128k"), or empty when the provider doesn't say. */
export function contextSize(model: ChatModel): string {
  const size = model.contextWindow;
  return size === undefined || size <= 0 ? '' : formatTokens(size);
}

/** A model's context in words: "128k context", or empty when unknown. */
export function contextText(model: ChatModel): string {
  const size = contextSize(model);
  return size === '' ? '' : `${size} context`;
}

/** The abilities a model's row shows, worth picking it for. */
export function abilities(model: ChatModel): string[] {
  return SHOWN_ABILITIES.filter((ability) => model.capabilities.includes(ability));
}
