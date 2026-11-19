/**
 * Where the index embeds pictures (an admin setting for the whole hub): off, the text model's space, or a model of
 * their own (a second space). Reading it shows the embedders that can embed pictures and the space in use.
 */
import type { ImageEmbedding, ImageEmbeddingView } from '@harness/core';
import { Loaded, Task, type Outcome } from '../../state/loaded.ts';
import type { AdminApi } from '../api.ts';

type ImagesApi = Pick<AdminApi, 'imageEmbedding' | 'setImageEmbedding'>;

/** The image embedding setting. */
export class ImageEmbeddingStore {
  readonly #api: ImagesApi;
  readonly setting = new Loaded<ImageEmbeddingView>();
  readonly saving = new Task();

  constructor(api: ImagesApi) {
    this.#api = api;
  }

  async load(quiet = false): Promise<void> {
    await this.setting.load(() => this.#api.imageEmbedding.call({}), "Couldn't load where pictures are embedded.", quiet);
  }

  /** Save the setting; answers what was stored, with the space now in use. */
  async save(value: ImageEmbedding): Promise<Outcome<ImageEmbeddingView>> {
    const result = await this.saving.run(() => this.#api.setImageEmbedding.call(value), "Couldn't save where pictures are embedded.");
    if (result.ok) { this.setting.set(result.value); }
    return result;
  }
}
