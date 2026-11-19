/**
 * Where pictures are embedded: the form's logic (the choice read into the hub's setting, the embedders as options, the
 * space in words) and the dialog (off, same as text, or a model of their own, which it needs picked).
 */
import { QualifiedName, type ImageEmbeddingView } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { embedderOptions, embedderReads, imageDraft, imageEmbeddingOf, imageSettingText, spaceText } from '../logic/images.ts';
import { IMAGE_VIEW } from '../test/fakes.ts';
import ImageEmbeddingDialog from './ImageEmbeddingDialog.vue';

afterEach(() => { document.body.innerHTML = ''; });

const CLIP = QualifiedName.parse('pics/clip');
const DOCUMENT = QualifiedName.parse('embedder/document');
const clip = { embedder: CLIP, name: 'pics/clip', dimensions: 512, text: true, images: true, crossModal: true };
const own: ImageEmbeddingView = { value: { use: 'model', embedder: CLIP }, text: DOCUMENT, options: [clip], state: { space: 'own', embedder: CLIP, crossModal: true } };

function find(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(selector);
  if (el === null) { throw new Error(`no ${selector}`); }
  return el;
}
const click = async (selector: string): Promise<void> => { find(selector).click(); await flushPromises(); };

describe('the pictures setting, in words and as a form', () => {
  it('reads the form into the setting, and needs a model picked for a model of their own', () => {
    expect(imageDraft(undefined)).toEqual({ use: 'text', embedder: '' });
    expect(imageDraft(own)).toEqual({ use: 'model', embedder: CLIP });
    expect(imageEmbeddingOf({ use: 'off', embedder: CLIP })).toEqual({ ok: true, value: { use: 'off' } });
    expect(imageEmbeddingOf({ use: 'model', embedder: '' })).toEqual({ ok: false, problem: 'Pick the model that embeds pictures.' });
    expect(imageEmbeddingOf({ use: 'model', embedder: CLIP })).toEqual({ ok: true, value: { use: 'model', embedder: CLIP } });
  });

  it('lists the embedders with what they read, keeping a chosen one that is gone', () => {
    expect(embedderReads(clip)).toBe('pictures and text, one space');
    expect(embedderReads({ text: false, crossModal: false })).toBe('pictures only');
    expect(embedderOptions([clip], '').map((o) => o.label)).toEqual(['Pick a model', 'pics/clip · 512 dims · pictures and text, one space']);
    expect(embedderOptions([], 'pics/gone').map((o) => o.value)).toEqual(['', 'pics/gone']);
  });

  it('says which space is in use, or why there is none', () => {
    expect(spaceText(own.state)).toEqual({ text: 'A second space: pics/clip embeds pictures, and text searches them too.', works: true });
    expect(spaceText({ space: 'shared', embedder: DOCUMENT }, DOCUMENT)).toEqual({ text: 'One space: embedder/document embeds pictures beside the text.', works: true });
    expect(spaceText(IMAGE_VIEW.state).works).toBe(false);
    expect(imageSettingText(IMAGE_VIEW)).toBe('Same as text · embedder/document embeds text only: pick an image model.');
    expect(imageSettingText(own)).toBe('pics/clip · A second space: pics/clip embeds pictures, and text searches them too.');
  });
});

describe('ImageEmbeddingDialog', () => {
  it('chooses off, same as text, or a model of their own, showing the space in use now', async () => {
    const dialog = mount(ImageEmbeddingDialog, { attachTo: document.body, props: { open: false, view: { ...IMAGE_VIEW, options: [clip] } } });
    await dialog.setProps({ open: true });
    await flushPromises();
    expect(find('[data-testid=images-now]').textContent).toContain('embeds text only');
    expect(document.body.querySelector('[data-testid=images-model]')).toBeNull();
    await click('[data-testid=images-save]');
    expect(dialog.emitted('save')?.[0]).toEqual([{ use: 'text' }]);
    // off
    await click('[data-testid=images-use] [role=radio]:nth-child(1)');
    await click('[data-testid=images-save]');
    expect(dialog.emitted('save')?.[1]).toEqual([{ use: 'off' }]);
    // a model of their own needs one picked
    await click('[data-testid=images-use] [role=radio]:nth-child(3)');
    await click('[data-testid=images-save]');
    expect(document.body.textContent).toContain('Pick the model that embeds pictures.');
    expect(dialog.emitted('save')).toHaveLength(2);
    const select = find('[data-testid=images-model] select');
    if (!(select instanceof HTMLSelectElement)) { throw new Error('no select'); }
    select.value = CLIP;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(find('[data-testid=images-reads]').textContent).toBe('Reads pictures and text, one space.');
    await click('[data-testid=images-save]');
    expect(dialog.emitted('save')?.[2]).toEqual([{ use: 'model', embedder: CLIP }]);
    dialog.unmount();
  });
});
