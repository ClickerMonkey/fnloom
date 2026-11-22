/**
 * The suggestions setting's form, pure: who picks (a decision model, an LLM, or none: the score alone), each chooser's model as a
 * chosen id, and the numbers as typed, read into the hub's `SuggestDecision` with one plain problem; the setting in
 * words for its row; and a try-out's outcomes split into used and left out. And the search settings' form: who filters
 * search hits (`SearchDecision`), for fns and for context. A model chooser of either also has an action: suggest what it
 * picks, or load it (`ChooserAction`).
 */
import {
  actionOf, LOAD_OUTCOME_LABELS, SEARCH_DECISION_DEFAULT, SUGGEST_DECISION_DEFAULT, SuggestDecision, SuggestPicking, type ChooserAction, type ModelInfo, type RoleModel, type SearchDecision, type SearchDecisionView,
  type SearchItemKind, type SearchJudge, type SuggestDecisionView, type SuggestionChooser, type SuggestionOutcome, type SuggestionRecord,
} from '@harness/core';
import { skipText } from '../../chat/logic/session.ts';
import type { IconName } from '../../ui/index.ts';

/** Each chooser in words, for the switch between them and the setting's row. */
export const CHOOSER_WORDS = {
  none: { label: 'No model', icon: 'list', about: 'The fns and context closest in meaning to the message, over the hub’s threshold, are suggested, best first.' },
  decision: { label: 'Decision model', icon: 'sparkles', about: 'A decision model answers one yes/no question per candidate; those at the Decisions role’s threshold or more are suggested.' },
  llm: { label: 'LLM', icon: 'chat', about: 'A chat model reads the candidates and the person’s last messages, and picks with reasons.' },
} as const satisfies Record<SuggestionChooser, { label: string; icon: IconName; about: string }>;

/** Each action in words, for the switch between them (a model chooser's only: no model only suggests). */
export const ACTION_WORDS = {
  suggest: { label: 'Suggest', icon: 'list', about: 'What it picks is offered to the chat model as cards; it loads what it needs.' },
  load: { label: 'Load', icon: 'download', about: 'What it picks is loaded for the turn: fns join the tools, context is put into the message (what doesn’t fit is suggested instead).' },
} as const satisfies Record<ChooserAction, { label: string; icon: IconName; about: string }>;

/** What a search judge's action does, in words. */
export const SEARCH_ACTION_WORDS = {
  suggest: { label: 'Return', icon: 'list', about: 'The kept hits are returned; the chat model loads what it needs.' },
  load: { label: 'Load', icon: 'download', about: 'When the chat model searches, the best kept hits are loaded for it too, and the search says so. The web’s search only filters.' },
} as const satisfies Record<ChooserAction, { label: string; icon: IconName; about: string }>;

/** The form as typed. */
export interface DecisionDraft {
  readonly by: SuggestionChooser;
  /** What a model chooser does with its picks. */
  readonly action: ChooserAction;
  /** The decision model's id; '' for the Decisions role's. */
  readonly decision: string;
  /** The LLM's id; '' for none yet. */
  readonly llm: string;
  readonly messages: string;
  readonly candidates: string;
  readonly cap: string;
  readonly floor: string;
}

/** A setting's model id, when it names one by id. */
function modelId(model: RoleModel | undefined): string {
  return model !== undefined && 'model' in model.model ? model.model.model : '';
}

/** The form filled from the stored setting (the numbers' defaults when no model picks). */
export function decisionDraft(view: SuggestDecisionView | undefined): DecisionDraft {
  const value = view?.value ?? SUGGEST_DECISION_DEFAULT;
  const numbers = value.by === 'none' ? SuggestPicking.parse({}) : value;
  return {
    by: value.by, action: actionOf(value),
    decision: value.by === 'decision' ? modelId(value.model) : '',
    llm: value.by === 'llm' ? modelId(value.model) : '',
    messages: String(numbers.messages), candidates: String(numbers.candidates), cap: String(numbers.cap), floor: String(numbers.floor),
  };
}

/** The form read, or its one problem and where it is (the model, or one of the numbers). */
export type DecisionCheck = { readonly ok: true; readonly value: SuggestDecision } | { readonly ok: false; readonly problem: string; readonly at: 'model' | 'numbers' };

/** The form read into the setting, or its one problem. */
export function decisionOf(draft: DecisionDraft): DecisionCheck {
  if (draft.by === 'none') { return { ok: true, value: SUGGEST_DECISION_DEFAULT }; }
  const chosen = draft.by === 'llm' ? draft.llm : draft.decision;
  if (draft.by === 'llm' && chosen === '') { return { ok: false, problem: 'Pick the LLM that picks the suggestions.', at: 'model' }; }
  const parsed = SuggestDecision.safeParse({
    by: draft.by, ...(draft.action === 'load' ? { action: 'load' } : {}), messages: Number(draft.messages), candidates: Number(draft.candidates), cap: Number(draft.cap), floor: Number(draft.floor),
    ...(chosen === '' ? {} : { model: { model: { model: chosen } } }),
  });
  if (parsed.success) { return { ok: true, value: parsed.data }; }
  const field = parsed.error.issues[0]?.path[0];
  const words = typeof field === 'string' ? DECISION_FIELD_WORDS[field] : undefined;
  return { ok: false, problem: words === undefined ? 'Check the numbers.' : `${words} is out of range.`, at: 'numbers' };
}

/** The numeric fields in words, for a problem with one. */
const DECISION_FIELD_WORDS: Readonly<Partial<Record<string, string>>> = { messages: 'Recent messages', candidates: 'Candidates', cap: 'Most it picks', floor: 'Lowest score' };

/** The models a chooser picks among: decision models for a decision model, chat models for an LLM. */
export function chooserModels(by: SuggestionChooser | SearchJudge, models: readonly ModelInfo[]): readonly ModelInfo[] {
  if (by === 'none') { return []; }
  const capability = by === 'decision' ? 'decision' : 'chat';
  return models.filter((model) => model.capabilities.includes(capability));
}

/**
 * The setting in words, for its row: "No model: …", or "judge decides · last 3 messages ·
 * up to 6 of 20 above 0.35".
 */
export function decisionModelText(view: SuggestDecisionView | undefined): string {
  const value = view?.value ?? SUGGEST_DECISION_DEFAULT;
  if (value.by === 'none') { return 'No model: the closest in meaning over the threshold are suggested'; }
  const model = modelId(value.model) || (value.by === 'decision' ? 'The Decisions role’s model' : 'A model');
  return `${model} ${value.by === 'decision' ? 'decides' : 'picks'}${actionOf(value) === 'load' ? ' and loads' : ''} · last ${value.messages} messages · up to ${value.cap} of ${value.candidates} above ${value.floor}`;
}

/** A try-out's outcomes: those used, and those left out with their reason in words. */
export function previewParts(record: SuggestionRecord): { used: SuggestionOutcome[]; left: { item: SuggestionOutcome; why: string }[]; loads: boolean } {
  return {
    used: record.items.filter((item) => item.used),
    left: record.items.flatMap((item) => (item.used ? [] : [{ item, why: skipText({ reason: item.reason, note: item.note ?? '' }) }])),
    loads: record.action === 'load',
  };
}

/** What became of a used item with the action `load`, in words; '' when it was suggested. */
export function loadText(item: SuggestionOutcome): string {
  return item.used && item.load !== undefined ? LOAD_OUTCOME_LABELS[item.load] : '';
}

/** Who filters search hits, in words, for the switch between them and the settings' rows. */
export const SEARCH_JUDGE_WORDS = {
  none: { label: 'As ranked', icon: 'list', about: 'Every hit is returned in its ranked order.' },
  decision: { label: 'Decision model', icon: 'sparkles', about: 'A decision model answers, for each hit, whether it fits what was searched for (and the person’s latest message); those at the Decisions role’s threshold or more are kept.' },
  llm: { label: 'LLM', icon: 'chat', about: 'A chat model reads the hits and what was searched for, and keeps those that fit, with reasons.' },
} as const satisfies Record<SearchJudge, { label: string; icon: IconName; about: string }>;

/** Each item kind's search setting, in words. */
export const SEARCH_ITEM_WORDS = {
  fn: { title: 'Fn search', label: 'Who filters fn search hits', hits: 'fn' },
  context: { title: 'Context search', label: 'Who filters context search hits', hits: 'context' },
} as const satisfies Record<SearchItemKind, { title: string; label: string; hits: string }>;

/** The search setting's form as typed: who filters, and each judge's model id ('' for the Decisions role's, or none yet). */
export interface SearchDraft {
  readonly by: SearchJudge;
  /** What a judge does with the kept hits. */
  readonly action: ChooserAction;
  readonly decision: string;
  readonly llm: string;
}

/** The form filled from a stored search setting. */
export function searchDraft(view: SearchDecisionView | undefined): SearchDraft {
  const value = view?.value ?? SEARCH_DECISION_DEFAULT;
  return { by: value.by, action: actionOf(value), decision: value.by === 'decision' ? modelId(value.model) : '', llm: value.by === 'llm' ? modelId(value.model) : '' };
}

/** The search form read into the setting, or its one problem. */
export function searchDecisionOf(draft: SearchDraft): { readonly ok: true; readonly value: SearchDecision } | { readonly ok: false; readonly problem: string } {
  if (draft.by === 'none') { return { ok: true, value: SEARCH_DECISION_DEFAULT }; }
  const action = draft.action === 'load' ? { action: 'load' as const } : {};
  if (draft.by === 'llm') {
    return draft.llm === '' ? { ok: false, problem: 'Pick the LLM that filters the hits.' } : { ok: true, value: { by: 'llm', model: { model: { model: draft.llm } }, ...action } };
  }
  return { ok: true, value: draft.decision === '' ? { by: 'decision', ...action } : { by: 'decision', model: { model: { model: draft.decision } }, ...action } };
}

/** A search setting in words, for its row: "As ranked: every hit is returned", or "judge keeps the hits that fit". */
export function searchDecisionText(view: SearchDecisionView | undefined): string {
  const value = view?.value ?? SEARCH_DECISION_DEFAULT;
  if (value.by === 'none') { return 'As ranked: every hit is returned'; }
  const model = modelId(value.model) || (value.by === 'decision' ? 'The Decisions role’s model' : 'A model');
  return `${model} keeps the hits that fit what was searched for${actionOf(value) === 'load' ? ', and loads the best for the chat model' : ''}`;
}
