/**
 * A/B compare in the web: the variants a person sets up before sending (each a set of changes to the chat's settings,
 * edited with the chat's own pickers), how a variant is named and summed up, and the compare's place in the URL
 * (`?compare=<turn>&v=<variant>`, the variant counted from 1 as people do).
 */
import {
  CompareSettings, MAX_VARIANTS, MIN_VARIANTS, type ChatCapabilities, type ChatMessage, type CompareVariantInput, type MessageId, type QualifiedName, type RunId, type CompareVariantView, type CompareView, type Session, type SystemName, type VariantIndex,
} from '@harness/core';
import { z } from 'zod';
import type { Tone } from '../../ui/index.ts';
import { formatCost, formatDuration, formatTokens } from './format.ts';
import { contextorLabel, FN_MODE_WORDS, modeLabel } from './modes.ts';
import { agentName } from './labels.ts';
import { modelLabel } from './session.ts';

export { MAX_VARIANTS, MIN_VARIANTS };

/** A variant in the URL: its number, from 1. */
export const VariantParam = z.enum(['1', '2', '3', '4']);
export type VariantParam = z.infer<typeof VariantParam>;

/** A variant's number in the URL from its index. */
export function variantParam(index: VariantIndex): VariantParam {
  return VariantParam.parse(String(index + 1));
}

/** A variant's index from its number in the URL. */
export function variantIndex(param: VariantParam): VariantIndex {
  return Number(param) - 1;
}

/** A variant's letter (A to D), as the compare names it when it has no name. */
export function variantLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** One variant being set up: its name and what it changes of the chat's settings. */
export interface VariantDraft {
  readonly label: string;
  readonly settings: CompareSettings;
}

/** The variants a compare starts with: the chat as it is, and one to change. */
export function startingDrafts(): VariantDraft[] {
  return [{ label: '', settings: {} }, { label: '', settings: {} }];
}

/** Add a variant (up to `MAX_VARIANTS`), starting as a copy of the last one so a small change is quick. */
export function addDraft(drafts: readonly VariantDraft[]): VariantDraft[] {
  const last = drafts.at(-1);
  return drafts.length >= MAX_VARIANTS ? [...drafts] : [...drafts, { label: '', settings: { ...(last?.settings ?? {}) } }];
}

/** Take a variant away, never going below `MIN_VARIANTS`. */
export function removeDraft(drafts: readonly VariantDraft[], index: number): VariantDraft[] {
  return drafts.length <= MIN_VARIANTS ? [...drafts] : drafts.filter((_, at) => at !== index);
}

/** Change one setting of a variant: a value sets it, `undefined` puts it back to the chat's. */
export function setSetting<K extends keyof CompareSettings>(draft: VariantDraft, key: K, value: CompareSettings[K] | undefined): VariantDraft {
  const { [key]: _dropped, ...rest } = draft.settings;
  return { ...draft, settings: value === undefined ? rest : { ...rest, [key]: value } };
}

/** The systems a variant uses, by name: its own choice, else the chat's (`all` is every one in `names`). */
export function variantSystems(draft: VariantDraft, session: Pick<Session, 'systems'>, names: readonly SystemName[]): ReadonlySet<SystemName> {
  const chosen = draft.settings.systems ?? session.systems;
  return new Set(chosen === 'all' ? names : chosen);
}

/** Turn one system on or off for a variant; landing back on the chat's own systems puts the setting back to the chat's. */
export function setSystem(draft: VariantDraft, session: Pick<Session, 'systems'>, names: readonly SystemName[], name: SystemName, on: boolean): VariantDraft {
  const enabled = variantSystems(draft, session, names);
  const next = names.filter((n) => (n === name ? on : enabled.has(n)));
  const value: SystemName[] | 'all' = next.length === names.length ? 'all' : next;
  const chats = variantSystems({ label: '', settings: {} }, session, names);
  const same = next.length === chats.size && next.every((n) => chats.has(n));
  return setSetting(draft, 'systems', same ? undefined : value);
}

/** What the hub is sent for the variants: each one's name (when given) and its changes, checked against core's schema. */
export function variantInputs(drafts: readonly VariantDraft[]): CompareVariantInput[] {
  return drafts.map((draft) => ({ ...(draft.label.trim() === '' ? {} : { label: draft.label.trim() }), settings: CompareSettings.parse(draft.settings) }));
}

/** Two variants with the same changes compare nothing: the index of the first repeat, if any. */
export function repeatedDraft(drafts: readonly VariantDraft[]): number | undefined {
  const seen = new Set<string>();
  for (const [at, draft] of drafts.entries()) {
    const key = JSON.stringify(Object.entries(draft.settings).sort(([a], [b]) => a.localeCompare(b)));
    if (seen.has(key)) { return at; }
    seen.add(key);
  }
  return undefined;
}

/** What a variant changes, in a few words each ("GPT-5", "Static tools", "Own prompt"); none for the chat as it is. */
export function settingsWords(settings: CompareSettings, models: ChatCapabilities['models']): string[] {
  return [
    settings.agent === undefined ? undefined : agentName(settings.agent),
    settings.model === undefined ? undefined : modelLabel(settings.model, models),
    settings.mode === undefined ? undefined : modeLabel(settings.mode.type),
    settings.contextor === undefined ? undefined : contextorLabel(settings.contextor.type),
    settings.fnMode === undefined ? undefined : FN_MODE_WORDS[settings.fnMode].label,
    settings.systems === undefined ? undefined : settings.systems === 'all' ? 'All systems' : `${settings.systems.length} system${settings.systems.length === 1 ? '' : 's'}`,
    settings.instructions === undefined ? undefined : 'Own prompt',
  ].filter((word): word is string => word !== undefined);
}

/** The settings a variant answers with, as the chat would read them: the chat's own with the variant's over them. */
export function settingsOf(session: Pick<Session, keyof CompareSettings>, settings: CompareSettings): CompareSettings {
  return { ...Object.fromEntries(Object.entries(session).filter(([key]) => key in CompareSettings.shape)), ...settings };
}

/** How a variant stands, for its badge. */
export function variantStatus(variant: Pick<CompareVariantView, 'status'>, chosen: VariantIndex | undefined, index: VariantIndex): { label: string; tone: Tone; live: boolean } {
  if (chosen === index) { return { label: 'Chosen', tone: 'ok', live: false }; }
  if (chosen !== undefined) { return { label: 'Discarded', tone: 'neutral', live: false }; }
  switch (variant.status) {
    case 'running': return { label: 'Answering', tone: 'accent', live: true };
    case 'paused': return { label: 'Paused', tone: 'warn', live: false };
    case 'done': return { label: 'Answered', tone: 'ok', live: false };
    case 'failed': return { label: 'Failed', tone: 'danger', live: false };
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral', live: false };
    case 'undone': return { label: 'Undone', tone: 'neutral', live: false };
  }
}

/** A variant's numbers: what it spent of its share, its tokens and its time. */
export function variantStats(variant: Pick<CompareVariantView, 'spent' | 'tokens' | 'time'>, reserved: number): { cost: string; tokens: string; time: string; share: number } {
  return {
    cost: `${formatCost(variant.spent)} of ${formatCost(reserved)}`, tokens: `${formatTokens(variant.tokens)} tokens`, time: formatDuration(variant.time),
    share: reserved <= 0 ? 0 : Math.min(1, variant.spent / reserved),
  };
}

/** Whether a variant can be chosen now: none was chosen yet, and it has finished answering. */
export function choosable(view: Pick<CompareView, 'chosen'>, variant: Pick<CompareVariantView, 'status'>): boolean {
  return view.chosen === undefined && variant.status !== 'running' && variant.status !== 'paused';
}

/** A piece of a variant's answer, as its column draws it. */
export type AnswerBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'call'; readonly fn: QualifiedName; readonly run: RunId };

/**
 * A variant's answer as pieces in the order the model made them: text, reasoning and the fns it called, with what
 * streamed since the view was read added at the end of its message. Pieces of the same kind next to each other join.
 */
export function answerBlocks(messages: readonly ChatMessage[], streamed: ReadonlyMap<MessageId, { readonly text: string; readonly reasoning: string }>): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  const add = (block: AnswerBlock): void => {
    const last = blocks.at(-1);
    if (block.kind !== 'call' && last?.kind === block.kind) { blocks[blocks.length - 1] = { kind: block.kind, text: last.text + block.text }; } else { blocks.push(block); }
  };
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'text' && part.text !== '') { add({ kind: 'text', text: part.text }); }
      if (part.type === 'reasoning' && part.text !== '') { add({ kind: 'reasoning', text: part.text }); }
      if (part.type === 'call') { add({ kind: 'call', fn: part.fn, run: part.run }); }
    }
    const more = streamed.get(message.id);
    if (more !== undefined && more.reasoning !== '') { add({ kind: 'reasoning', text: more.reasoning }); }
    if (more !== undefined && more.text !== '') { add({ kind: 'text', text: more.text }); }
  }
  return blocks;
}
