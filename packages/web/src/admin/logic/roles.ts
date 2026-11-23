/**
 * Model roles and limits as the models page shows them: what each role is for, the models that can do it (by the
 * capability the role needs), a role's setting read into the editor's fields and written back as a `RoleChoice`, and a
 * model's limits with where each came from. Pure, so it is tested alone.
 */
import {
  DEFAULT_DECIDE_THRESHOLD, ModelLimits, ROLE_CAPABILITY, RoleChoice, type DictationEngine, type LimitSource, type ModelInfo, type ModelLimitsView, type ModelRole, type ModelRoleView, type ProviderId,
} from '@harness/core';
import type { Outcome } from '../../ui/index.ts';

/** What each role is for, and the ability its model needs (core's `ROLE_CAPABILITY`) in words. */
export const ROLE_WORDS = {
  chat: { label: 'Chat', about: 'The model agents answer with unless they choose one.', can: 'chat' },
  transcribe: { label: 'Transcription', about: 'Turns audio resources and recordings into text.', can: 'hear audio' },
  dictate: { label: 'Dictation', about: 'Turns what people say into the composer into text.', can: 'hear audio' },
  speak: { label: 'Speech', about: 'Reads answers aloud.', can: 'speak' },
  describe: { label: 'Image descriptions', about: 'Describes images so agents can read them, and answers questions about an image for a chat model that cannot see images.', can: 'see images' },
  ocr: { label: 'Text in images', about: 'Reads the text in images and scanned pages.', can: 'see images' },
  decide: {
    label: 'Decisions', about: 'A decision model answering yes/no questions: context crawls, systems reusing what they have, and suggestions when set to it.',
    can: 'decide',
  },
} as const satisfies Record<ModelRole, { label: string; about: string; can: string }>;

/** Where a role's setting came from, in words. */
export const ROLE_FROM_WORDS = { setting: 'Set here', env: 'Hub default', none: 'Off' } as const satisfies Record<ModelRoleView['from'], string>;

/** The models that can do a role, the able ones first by name; the rest follow so a model aeye doesn't label can still be picked. */
export function modelsFor(role: ModelRole, models: readonly ModelInfo[]): { readonly able: readonly ModelInfo[]; readonly other: readonly ModelInfo[] } {
  const capability = ROLE_CAPABILITY[role];
  const byName = [...models].sort((a, b) => a.name.localeCompare(b.name));
  return { able: byName.filter((m) => m.capabilities.includes(capability)), other: byName.filter((m) => !m.capabilities.includes(capability)) };
}

/** A role's editor: dictation's engine, the model (an id) and its pinned provider, a language, and the decide threshold. */
export interface RoleDraft {
  readonly engine: DictationEngine['engine'];
  readonly model: string;
  /** The pinned provider; '' for any that offers the model. */
  readonly provider: ProviderId;
  readonly language: string;
  /** The decide role's threshold as typed, 0 to 1. */
  readonly threshold: string;
}

/** Whether a role has a language hint (the decide role reads no audio or images). */
export function hasLanguage(role: ModelRole): boolean {
  return role !== 'decide';
}

/** The editor's fields for a role's current setting (empty when it has none, or chooses by category or automatically). */
export function roleDraft(view: ModelRoleView): RoleDraft {
  const choice = view.choice;
  const empty: RoleDraft = { engine: view.role === 'dictate' ? 'browser' : 'model', model: '', provider: '', language: '', threshold: String(DEFAULT_DECIDE_THRESHOLD) };
  if (choice === undefined) { return empty; }
  if (choice.role === 'decide') {
    return { ...empty, model: 'model' in choice.model ? choice.model.model : '', provider: choice.provider ?? '', threshold: String(choice.threshold) };
  }
  const language = choice.language ?? '';
  if (choice.role === 'dictate') {
    if (choice.engine.engine === 'browser') { return { ...empty, engine: 'browser', language }; }
    return { ...empty, engine: 'model', model: 'model' in choice.engine.model ? choice.engine.model.model : '', provider: choice.engine.provider ?? '', language };
  }
  return { ...empty, model: 'model' in choice.model ? choice.model.model : '', provider: choice.provider ?? '', language };
}

/** The setting the editor's fields make, or a sentence saying what is missing. */
export function roleChoiceOf(role: ModelRole, draft: RoleDraft): Outcome<RoleChoice> {
  const language = draft.language.trim();
  const pinned = { model: { model: draft.model.trim() }, ...(draft.provider === '' ? {} : { provider: draft.provider }) };
  const extra = language === '' ? {} : { language };
  if (role === 'dictate' && draft.engine === 'browser') { return { ok: true, value: RoleChoice.parse({ role, engine: { engine: 'browser' }, ...extra }) }; }
  if (draft.model.trim() === '') { return { ok: false, problem: 'Choose a model.' }; }
  if (role === 'decide') {
    const threshold = Number(draft.threshold);
    if (draft.threshold.trim() === '' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) { return { ok: false, problem: 'The threshold is a probability from 0 to 1.' }; }
    return { ok: true, value: RoleChoice.parse({ role, ...pinned, threshold }) };
  }
  const parsed = RoleChoice.safeParse(role === 'dictate' ? { role, engine: { engine: 'model', ...pinned }, ...extra } : { role, ...pinned, ...extra });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: parsed.error.issues[0]?.message ?? 'That setting isn’t valid.' };
}

/** What a role resolves to now, in words: the model and provider (and the decide threshold), or why it can't be used. */
export function resolvedText(view: ModelRoleView): string {
  if (view.choice?.role === 'dictate' && view.choice.engine.engine === 'browser') { return 'The browser’s own speech recognition (no model call).'; }
  const resolved = view.resolved;
  if (resolved === undefined) { return view.from === 'none' ? 'Not set: this job is off.' : 'Not checked yet.'; }
  if ('problem' in resolved) { return resolved.problem; }
  const threshold = view.choice?.role === 'decide' ? ` · yes at ${Math.round(view.choice.threshold * 100)}% or more` : '';
  return `${resolved.model} on ${resolved.provider}${threshold}`;
}

/** A role's language hint, when it has one. */
export function roleLanguage(view: ModelRoleView): string | undefined {
  return view.choice === undefined || view.choice.role === 'decide' ? undefined : view.choice.language;
}

/** Whether a role works now. */
export function roleWorks(view: ModelRoleView): boolean {
  return view.resolved !== undefined && !('problem' in view.resolved);
}

// ─── Limits ───────────────────────────────────────────────────────────────────

/** Each limit's words. */
export const LIMIT_WORDS = {
  contextWindow: { label: 'Context window', unit: 'tokens', about: 'The window the provider serves (Ollama’s num_ctx), not what the model was trained to.' },
  maxOutputTokens: { label: 'Reply', unit: 'tokens', about: 'The most a reply may be.' },
  reasoningTokens: { label: 'Reasoning', unit: 'tokens', about: 'Kept for a reasoning model to think, on top of the reply.' },
  charsPerToken: { label: 'Characters per token', unit: 'chars', about: 'For estimates, before calibration.' },
} as const satisfies Record<keyof ModelLimits, { label: string; unit: string; about: string }>;

/** The limit fields, in order. */
export const LIMIT_FIELDS = Object.keys(LIMIT_WORDS).filter((key): key is keyof ModelLimits => key in LIMIT_WORDS);

/** Where a limit came from, in words. */
export const LIMIT_SOURCE_WORDS = { admin: 'Set here', probe: 'Provider', 'model-info': 'Model info', default: 'Hub default' } as const satisfies Record<LimitSource, string>;

/** The editor's text for each limit: the admin's own value, or blank when another source fills it. */
export function limitsDraft(view: ModelLimitsView): Record<keyof ModelLimits, string> {
  const own = (field: keyof ModelLimits): string => (view.sources[field] === 'admin' ? String(view.limits[field]) : '');
  return { contextWindow: own('contextWindow'), maxOutputTokens: own('maxOutputTokens'), reasoningTokens: own('reasoningTokens'), charsPerToken: own('charsPerToken') };
}

/** The limits the editor's text makes: blank leaves a field to the next source; a field that isn't a number is a problem. */
export function limitsOf(draft: Readonly<Record<keyof ModelLimits, string>>): Outcome<ModelLimits> {
  const limits: Record<string, number> = {};
  for (const field of LIMIT_FIELDS) {
    const text = draft[field].trim();
    if (text === '') { continue; }
    const value = Number(text);
    if (!Number.isFinite(value)) { return { ok: false, problem: `${LIMIT_WORDS[field].label} must be a number.` }; }
    limits[field] = value;
  }
  // the bounds (a whole number of tokens, at least 256 for a window, …) are the schema's
  const parsed = ModelLimits.safeParse(limits);
  if (parsed.success) { return { ok: true, value: parsed.data }; }
  const issue = parsed.error.issues[0];
  const field = LIMIT_FIELDS.find((f) => f === issue?.path[0]);
  return { ok: false, problem: `${field === undefined ? 'A limit' : LIMIT_WORDS[field].label}: ${issue?.message ?? 'not valid'}.` };
}

/** A model's key among every provider's models: its provider and id. */
export function modelKey(model: { readonly provider: string; readonly id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * The roles each model fills now, by `modelKey`: what systems' aeye (`ctx.ai()`, the hub link's `models`) is told
 * beside each model, so a system picks the hub's chat or transcription model by role.
 */
export function rolesByModel(roles: readonly ModelRoleView[]): ReadonlyMap<string, readonly ModelRole[]> {
  const filled = new Map<string, ModelRole[]>();
  for (const view of roles) {
    const resolved = view.resolved;
    if (resolved === undefined || !('model' in resolved)) { continue; }
    const key = modelKey({ provider: resolved.provider, id: resolved.model });
    filled.set(key, [...(filled.get(key) ?? []), view.role]);
  }
  return filled;
}
