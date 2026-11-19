/**
 * Image embeddings: where the index puts pictures (image resources, and images context items show) so search can find
 * them by an image, and by text when the model shares a space with it.
 *
 * Images get a second vector space, with its own model (an embedder with aeye's `imageEmbedding`). A model that is
 * also `crossModalEmbedding` (its text and image vectors compare, like EmbeddingGemma v2) can serve both: chosen as the
 * text model too, or as "same as text", there is one space and text search finds images. The admin's one setting
 * (`hubOptions['imageEmbedding']`) says which; `resolveImageSpace` is the one rule that turns it into the space in use.
 * With no image space (the default with a text-only embedder) nothing about images is indexed, as before.
 */
import { z } from 'zod';
import { ActorId, QualifiedName, Timestamp } from './primitives.ts';

/** Where images are embedded: `off` (not at all), `text` (same as text), or a `model` of their own. */
export const IMAGE_EMBEDDING_USES = ['off', 'text', 'model'] as const;
export const ImageEmbeddingUse = z.enum(IMAGE_EMBEDDING_USES);
export type ImageEmbeddingUse = z.infer<typeof ImageEmbeddingUse>;

/**
 * The image embedding setting (admins), one choice:
 * - `off`: images aren't indexed.
 * - `text`: the text (document) embedder embeds them, in its space; only when it embeds images in a space shared with
 *   text (`imageEmbedding` and `crossModalEmbedding`). The default: a text-only embedder means no images, as before.
 * - `model`: `embedder` (`<system>/<model>`, an embedding model with `imageEmbedding`) embeds them. Its own, second
 *   space; or the text space when it is the text embedder and shares it.
 */
export const ImageEmbedding = z.discriminatedUnion('use', [
  z.object({ use: z.literal('off') }),
  z.object({ use: z.literal('text') }),
  z.object({ use: z.literal('model'), embedder: QualifiedName }),
]);
export type ImageEmbedding = z.infer<typeof ImageEmbedding>;

/** The setting before any admin chose: same as text. */
export const IMAGE_EMBEDDING_DEFAULT: ImageEmbedding = { use: 'text' };

/** What an embedder can embed: text, images, and whether the two share its space. */
export const EmbedderAbilities = z.object({ text: z.boolean(), images: z.boolean(), crossModal: z.boolean() });
export type EmbedderAbilities = z.infer<typeof EmbedderAbilities>;

/** An embedder the setting can name: an embedding model of an offered provider, with its size and abilities. */
export const ImageEmbedderOption = EmbedderAbilities.extend({ embedder: QualifiedName, name: z.string(), dimensions: z.number().int().min(1) });
export type ImageEmbedderOption = z.infer<typeof ImageEmbedderOption>;

/**
 * The image space in use. `shared`: images are in the text space (text search finds them). `own`: a second space;
 * `crossModal` says whether text can search it (the model embeds a text query beside the images). `none`: no images are
 * indexed, and `reason` says why.
 */
export const ImageSpaceState = z.discriminatedUnion('space', [
  z.object({ space: z.literal('none'), reason: z.string() }),
  z.object({ space: z.literal('shared'), embedder: QualifiedName }),
  z.object({ space: z.literal('own'), embedder: QualifiedName, crossModal: z.boolean() }),
]);
export type ImageSpaceState = z.infer<typeof ImageSpaceState>;

/** The setting for the admin page: the stored choice, who set it, the text embedder, the image-able embedders, and what is in use. */
export const ImageEmbeddingView = z.object({
  value: ImageEmbedding,
  setBy: ActorId.optional(),
  updatedAt: Timestamp.optional(),
  /** The text (document) embedder, `HARNESS_EMBEDDER_DOCUMENT`. */
  text: QualifiedName,
  /** Embedders connected now that embed images. */
  options: z.array(ImageEmbedderOption),
  state: ImageSpaceState,
});
export type ImageEmbeddingView = z.infer<typeof ImageEmbeddingView>;

/** An embedder as `resolveImageSpace` reads it: its name and abilities. */
export interface ImageSpaceCandidate extends EmbedderAbilities {
  readonly name: QualifiedName;
}

/** Whether an embedder can hold images in the text space: it embeds images in a space shared with its text. */
const sharesText = (embedder: EmbedderAbilities): boolean => embedder.images && embedder.crossModal;

/**
 * The image space a setting gives, from the text (document) embedder and the embedder it names (each undefined while
 * not connected). The one rule: the hub's index and the admin page both read it.
 */
export function resolveImageSpace(setting: ImageEmbedding, document: ImageSpaceCandidate | undefined, named: ImageSpaceCandidate | undefined): ImageSpaceState {
  switch (setting.use) {
    case 'off':
      return { space: 'none', reason: 'Image embedding is off.' };
    case 'text':
      if (document === undefined) return { space: 'none', reason: 'The text embedder is not connected.' };
      return sharesText(document) ? { space: 'shared', embedder: document.name } : { space: 'none', reason: `${document.name} embeds text only: pick an image model.` };
    case 'model': {
      if (named === undefined) return { space: 'none', reason: `${setting.embedder} is not connected.` };
      if (!named.images) return { space: 'none', reason: `${named.name} doesn't embed images.` };
      if (named.name !== document?.name) return { space: 'own', embedder: named.name, crossModal: named.crossModal };
      return sharesText(named) ? { space: 'shared', embedder: named.name } : { space: 'none', reason: `${named.name}'s image vectors don't share its text space.` };
    }
  }
}
