/**
 * The image embedding setting's form, pure: where the index embeds pictures (off, the text model's space, or a model
 * of their own), the form as chosen read into the hub's `ImageEmbedding` with one plain problem, the embedders that
 * can be picked as select options, and the setting and the space in use in words.
 */
import {
  IMAGE_EMBEDDING_DEFAULT, ImageEmbedding, type ImageEmbedderOption, type ImageEmbeddingUse, type ImageEmbeddingView, type ImageSpaceState, type QualifiedName,
} from '@harness/core';
import type { IconName, SelectOption } from '../../ui/index.ts';

/** Each choice in words, with its icon and what it means. */
export const IMAGE_USE_WORDS = {
  off: { label: 'Off', icon: 'eye-off', about: 'Pictures aren’t indexed: search finds them by name only, as files.' },
  text: { label: 'Same as text', icon: 'link', about: 'The text model embeds pictures too, in one space, when it can: text search then finds pictures.' },
  model: { label: 'A model', icon: 'image', about: 'A model of their own embeds pictures, in a second space: search by a picture, and by text when the model reads text too.' },
} as const satisfies Record<ImageEmbeddingUse, { label: string; icon: IconName; about: string }>;

/** The form as chosen. */
export interface ImageDraft {
  readonly use: ImageEmbeddingUse;
  /** The chosen embedder (`<system>/<model>`); '' for none yet. */
  readonly embedder: string;
}

/** The form filled from the stored setting. */
export function imageDraft(view: ImageEmbeddingView | undefined): ImageDraft {
  const value = view?.value ?? IMAGE_EMBEDDING_DEFAULT;
  return { use: value.use, embedder: value.use === 'model' ? value.embedder : '' };
}

/** The form read into the setting, or its one problem. */
export function imageEmbeddingOf(draft: ImageDraft): { readonly ok: true; readonly value: ImageEmbedding } | { readonly ok: false; readonly problem: string } {
  if (draft.use === 'model' && draft.embedder === '') { return { ok: false, problem: 'Pick the model that embeds pictures.' }; }
  const parsed = ImageEmbedding.safeParse(draft.use === 'model' ? { use: 'model', embedder: draft.embedder } : { use: draft.use });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problem: 'That model name isn’t <system>/<model>.' };
}

/** What an embedder reads, in words: pictures, and text in the same space or apart. */
export function embedderReads(option: Pick<ImageEmbedderOption, 'text' | 'crossModal'>): string {
  if (option.crossModal) { return 'pictures and text, one space'; }
  return option.text ? 'pictures; text apart' : 'pictures only';
}

/** The embedders to pick from, as select options; the stored one stays listed while it isn't connected. */
export function embedderOptions(options: readonly ImageEmbedderOption[], chosen: string): SelectOption<string>[] {
  const listed = options.map((option) => ({
    value: option.embedder, label: `${option.name === option.embedder ? option.name : `${option.name} (${option.embedder})`} · ${option.dimensions} dims · ${embedderReads(option)}`,
  }));
  const missing = chosen !== '' && !options.some((option) => option.embedder === chosen) ? [{ value: chosen, label: `${chosen} · not connected` }] : [];
  return [{ value: '', label: 'Pick a model' }, ...missing, ...listed];
}

/** The space in use in words, and whether it works. */
export function spaceText(state: ImageSpaceState | undefined, text?: QualifiedName): { readonly text: string; readonly works: boolean } {
  if (state === undefined) { return { text: 'Not loaded yet.', works: false }; }
  switch (state.space) {
    case 'none': return { text: state.reason, works: false };
    case 'shared': return { text: `One space: ${state.embedder} embeds pictures beside ${state.embedder === text ? 'the text' : 'text'}.`, works: true };
    case 'own': return {
      text: `A second space: ${state.embedder} embeds pictures${state.crossModal ? ', and text searches them too' : '; search them by a picture'}.`, works: true,
    };
  }
}

/** The setting in words, for its row. */
export function imageSettingText(view: ImageEmbeddingView | undefined): string {
  if (view === undefined) { return 'Not loaded yet'; }
  const chosen = view.value.use === 'model' ? view.value.embedder : IMAGE_USE_WORDS[view.value.use].label;
  return `${chosen} · ${spaceText(view.state, view.text).text}`;
}
