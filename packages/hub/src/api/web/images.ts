/**
 * Where the index embeds images (admins): the setting with the embedders that can embed images and the space in use,
 * and setting it (`core/image-embeddings.ts`, `index/image-setting.ts`).
 */
import { plugin } from '@ayepi/plugin';
import { imageEmbeddingSlice } from '@harness/core';
import type { HubServices } from '../../boot/index.ts';
import type { FullHandlers } from './access.ts';
import type { systemsPlugin } from './systems.ts';

/** The image embedding plugin. Requires the systems plugin, which binds `adminOnly`. */
export function imageEmbeddingPlugin(hub: HubServices, systems: ReturnType<typeof systemsPlugin>) {
  return plugin({ name: 'web.imageEmbedding', spec: imageEmbeddingSlice, requires: [systems] })
    .handlers((): FullHandlers<typeof imageEmbeddingSlice> => ({
      imageEmbedding: () => hub.index.images.view(),
      setImageEmbedding: ({ data, user }) => hub.index.images.set(data, user.id),
    }));
}
