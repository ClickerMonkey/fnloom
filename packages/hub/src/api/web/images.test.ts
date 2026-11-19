/**
 * The pictures setting over the web API: an admin reads where pictures are embedded (the choice, the embedders that
 * can embed pictures, the space in use) and sets it, through the real setting over the hub's store; the embedders are
 * worked out again before the answer, so it shows the new space.
 */
import { QualifiedName, type ImageSpaceState } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ImageEmbeddingSettings } from '../../index/image-setting.ts';
import { rig, webRig } from '../testing/rig.ts';

const DOCUMENT = QualifiedName.parse('embedder/document');
const CLIP = QualifiedName.parse('pics/clip');

describe('the pictures setting endpoints', () => {
  it('reads the default, then sets a model of their own and answers with the space it gives', async () => {
    const built: { settings?: ImageEmbeddingSettings } = {};
    const real = (): ImageEmbeddingSettings => { if (built.settings === undefined) { throw new Error('not built yet'); } return built.settings; };
    const r = await rig({ index: { images: { view: () => real().view(), set: (value, by) => real().set(value, by), value: () => real().value() } } });
    // the embedders: a text-only document embedder, and a picture model that becomes the space once it is chosen
    let state: ImageSpaceState = { space: 'none', reason: `${DOCUMENT} embeds text only: pick an image model.` };
    const embedders = {
      refresh: async () => { const value = await real().value(); if (value.use === 'model') { state = { space: 'own', embedder: value.embedder, crossModal: true }; } },
      imageState: () => state,
      imageOptions: () => [{ embedder: CLIP, name: 'pics/clip', dimensions: 512, text: true, images: true, crossModal: true }],
    };
    built.settings = new ImageEmbeddingSettings({ store: r.store, clock: () => 7, document: DOCUMENT, embedders: () => embedders });
    const web = await webRig(r);
    const as = web.as(await web.admin());
    expect(await web.client.call('imageEmbedding', {}, as)).toEqual({ value: { use: 'text' }, text: DOCUMENT, options: embedders.imageOptions(), state: { space: 'none', reason: `${DOCUMENT} embeds text only: pick an image model.` } });
    const set = await web.client.call('setImageEmbedding', { use: 'model', embedder: CLIP }, as);
    expect(set).toMatchObject({ value: { use: 'model', embedder: CLIP }, updatedAt: 7, state: { space: 'own', embedder: CLIP, crossModal: true } });
    expect(await web.client.call('imageEmbedding', {}, as)).toMatchObject({ value: { use: 'model', embedder: CLIP }, updatedAt: 7 });
  });
});
