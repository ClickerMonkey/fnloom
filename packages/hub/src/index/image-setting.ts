/**
 * The image embedding setting (admins): where the index embeds images (`core/image-embeddings.ts`). It is one
 * `hubOptions` row (`imageEmbedding`); setting it works the embedders out again, so the index moves its images to the
 * new space (the indexer hears the change and embeds them there). Reading it shows the embedders that can embed images
 * and the space in use, or why there is none.
 */
import { IMAGE_EMBEDDING_DEFAULT, ImageEmbedding, type ActorId, type ImageEmbeddingView, type QualifiedName } from '@harness/core';
import type { HubStore } from '../store/index.ts';
import type { SystemEmbedders } from './embedders.ts';

/** What the setting needs. */
export interface ImageEmbeddingSettingsOptions {
  readonly store: HubStore;
  readonly clock: () => number;
  /** The text (document) embedder's name. */
  readonly document: QualifiedName;
  /** The embedders, looked up when used (they read this setting at each refresh). */
  readonly embedders: () => Pick<SystemEmbedders, 'refresh' | 'imageState' | 'imageOptions'>;
}

/** Reads and sets where images are embedded. */
export class ImageEmbeddingSettings {
  readonly #o: ImageEmbeddingSettingsOptions;

  constructor(options: ImageEmbeddingSettingsOptions) {
    this.#o = options;
  }

  /** The stored choice (the default, same as text, until an admin sets one). */
  async value(): Promise<ImageEmbedding> {
    return (await this.#row())?.value ?? IMAGE_EMBEDDING_DEFAULT;
  }

  /** The setting for the admin page: the choice, who set it, the choices there are, and the space in use. */
  async view(): Promise<ImageEmbeddingView> {
    const row = await this.#row();
    const embedders = this.#o.embedders();
    return {
      value: row?.value ?? IMAGE_EMBEDDING_DEFAULT, ...(row === undefined ? {} : { setBy: row.setBy, updatedAt: row.updatedAt }),
      text: this.#o.document, options: embedders.imageOptions(), state: embedders.imageState(),
    };
  }

  /** Set where images are embedded; the embedders are worked out again before it answers, so the view shows the new space. */
  async set(value: ImageEmbedding, by: ActorId): Promise<ImageEmbeddingView> {
    await this.#o.store.table('hubOptions').put({ key: 'imageEmbedding', value: ImageEmbedding.parse(value), setBy: by, updatedAt: this.#o.clock() });
    await this.#o.embedders().refresh();
    return this.view();
  }

  async #row() {
    const row = await this.#o.store.table('hubOptions').get('imageEmbedding');
    return row?.key === 'imageEmbedding' ? row : undefined;
  }
}
