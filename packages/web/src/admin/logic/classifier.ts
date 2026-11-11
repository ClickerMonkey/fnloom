/**
 * The auto classifier's form, pure: the setting as typed (the model as a chosen id, '' for none; the message count as
 * text) read into the hub's `AutoClassifier` with one plain problem, and the setting in words for its row.
 */
import { AutoClassifier, type AutoClassifierView } from '@harness/core';

/** The form as typed. */
export interface ClassifierDraft {
  /** The chosen model's id; '' for none (every call above read waits for the person). */
  readonly model: string;
  readonly messages: string;
}

/** The model id a stored setting names, or '' for none. */
function modelId(value: AutoClassifier | undefined): string {
  const model = value?.model?.model;
  return model !== undefined && 'model' in model ? model.model : '';
}

/** The form filled from the stored setting. */
export function classifierDraft(view: AutoClassifierView | undefined): ClassifierDraft {
  const value = view?.value ?? AutoClassifier.parse({});
  return { model: modelId(value), messages: String(value.messages) };
}

/** The form read into the setting, or its one problem. */
export function classifierOf(draft: ClassifierDraft): { readonly ok: true; readonly value: AutoClassifier } | { readonly ok: false; readonly problem: string } {
  const parsed = AutoClassifier.safeParse({ messages: Number(draft.messages), ...(draft.model === '' ? {} : { model: { model: { model: draft.model } } }) });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: 'Recent messages is a whole number from 0 to 20.' };
}

/** The setting in words, for its row: "gpt-4o-mini · reads the last 4 messages", or what happens without one. */
export function classifierText(view: AutoClassifierView | undefined): string {
  const model = modelId(view?.value);
  if (model === '') { return 'No model: in auto mode every call that writes or deletes waits for the person'; }
  const messages = view?.value.messages ?? 0;
  return `${model} · reads the last ${messages} ${messages === 1 ? 'message' : 'messages'}`;
}
