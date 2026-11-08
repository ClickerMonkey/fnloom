/**
 * The decision-model setting's form, pure: the setting as typed (numbers as text, the model as a chosen id) read into
 * the hub's `SuggestDecision` with one plain problem, the setting in words for its row, and a try-out's outcomes split
 * into used and left out.
 */
import { SuggestDecision, type SuggestDecisionView, type SuggestionOutcome, type SuggestionRecord } from '@harness/core';
import { skipText } from '../../chat/logic/session.ts';

/** The form as typed. */
export interface DecisionDraft {
  readonly enabled: boolean;
  /** The chosen model's id; '' for none. */
  readonly model: string;
  readonly messages: string;
  readonly candidates: string;
  readonly cap: string;
  readonly floor: string;
}

/** The form filled from the stored setting. */
export function decisionDraft(view: SuggestDecisionView | undefined): DecisionDraft {
  const value = view?.value ?? SuggestDecision.parse({});
  const model = value.model !== undefined && 'model' in value.model.model ? value.model.model.model : '';
  return { enabled: value.enabled, model, messages: String(value.messages), candidates: String(value.candidates), cap: String(value.cap), floor: String(value.floor) };
}

/** The form read, or its one problem and where it is (the model, or one of the numbers). */
export type DecisionCheck = { readonly ok: true; readonly value: SuggestDecision } | { readonly ok: false; readonly problem: string; readonly at: 'model' | 'numbers' };

/** The form read into the setting, or its one problem. */
export function decisionOf(draft: DecisionDraft): DecisionCheck {
  const parsed = SuggestDecision.safeParse({
    enabled: draft.enabled, messages: Number(draft.messages), candidates: Number(draft.candidates), cap: Number(draft.cap), floor: Number(draft.floor),
    ...(draft.model === '' ? {} : { model: { model: { model: draft.model } } }),
  });
  if (parsed.success) { return { ok: true, value: parsed.data }; }
  const issue = parsed.error.issues[0];
  const field = issue?.path[0];
  if (field === 'model') { return { ok: false, problem: issue?.message ?? 'Pick a model.', at: 'model' }; }
  const words = typeof field === 'string' ? DECISION_FIELD_WORDS[field] : undefined;
  return { ok: false, problem: words === undefined ? 'Check the numbers.' : `${words} is out of range.`, at: 'numbers' };
}

/** The numeric fields in words, for a problem with one. */
const DECISION_FIELD_WORDS: Readonly<Partial<Record<string, string>>> = { messages: 'Recent messages', candidates: 'Candidates', cap: 'Most it picks', floor: 'Lowest score' };

/** The setting in words, for its row: "Off — the score decides" or "gpt-4o-mini · last 3 messages · up to 6". */
export function decisionModelText(view: SuggestDecisionView | undefined): string {
  const value = view?.value;
  if (value === undefined || !value.enabled) { return 'Off: the score threshold decides'; }
  const model = value.model !== undefined && 'model' in value.model.model ? value.model.model.model : 'a model';
  return `${model} · last ${value.messages} messages · up to ${value.cap} of ${value.candidates} above ${value.floor}`;
}

/** A try-out's outcomes: those used, and those left out with their reason in words. */
export function previewParts(record: SuggestionRecord): { used: SuggestionOutcome[]; left: { item: SuggestionOutcome; why: string }[] } {
  return {
    used: record.items.filter((item) => item.used),
    left: record.items.flatMap((item) => (item.used ? [] : [{ item, why: skipText({ reason: item.reason, note: item.note ?? '' }) }])),
  };
}
