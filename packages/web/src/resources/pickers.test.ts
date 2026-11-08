import type { ResourceRecord } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FromResourceDialog from '../context/components/FromResourceDialog.vue';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import ResourceViewer from './ResourceViewer.vue';
import { linkLabel, shortAddress } from './logic/browse.ts';
import { typeWord } from './logic/formats.ts';
import { FOUND_LIMIT } from './state/search.ts';
import { fakeResources, FIXTURES, uri } from './test/fakes.ts';
import MediaViewer from './viewers/MediaViewer.vue';

afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

describe('resource words', () => {
  it('cuts a long address in the middle, keeping its distinguishing end', () => {
    const long = 'file:///C:/Users/pdiff/Documents/GitHub/harness/docs/research/contextor.md';
    const short = shortAddress(long, 40);
    expect(short).toHaveLength(40);
    expect(short.startsWith('file:///C:/')).toBe(true);
    expect(short.endsWith('research/contextor.md')).toBe(true);
    expect(short).toContain('…');
    expect(shortAddress('fs://work/a.md')).toBe('fs://work/a.md');
  });

  it('names a resource’s type by its format, else its extension, else its mime type', () => {
    expect(typeWord({ name: 'a.md', type: 'file', format: 'markdown' })).toBe('markdown');
    expect(typeWord({ name: 'ui-sample.wav', type: 'file', mime: 'audio/wav' })).toBe('wav');
    expect(typeWord({ name: 'clip', type: 'file', mime: 'audio/ogg; codecs=opus' })).toBe('ogg');
    expect(typeWord({ name: 'docs', type: 'folder' })).toBe('folder');
    expect(typeWord({ name: 'blob', type: 'file' })).toBe('file');
  });

  it('takes inline-code marks out of a link’s words', () => {
    expect(linkLabel({ title: '`docs/harness.md`', raw: 'docs/harness.md' })).toBe('docs/harness.md');
    expect(linkLabel({ raw: 'http://127.0.0.1:11434`' })).toBe('http://127.0.0.1:11434');
    expect(linkLabel({ title: '``', raw: './a.md' })).toBe('./a.md');
  });
});

describe('the resource search', () => {
  it('finds a few resources by words with its own caller, and clears on blank words', async () => {
    const { resources, api } = fakeResources();
    const search = resources.search();
    await search.search('  people ');
    expect(search.found.value.value?.map((r) => r.uri)).toEqual(['fs://work/data/people.csv']);
    expect(api.find.calls[0]?.[0]).toEqual({ search: 'people', limit: FOUND_LIMIT });
    expect(api.browse.calls).toHaveLength(0);
    await search.search('   ');
    expect(search.found.value.value).toBeUndefined();
  });
});

describe('making context from a resource', () => {
  it('searches as the person types, fills the address from a match, and sends it', async () => {
    vi.useFakeTimers();
    const found: readonly ResourceRecord[] = FIXTURES.slice(0, 2);
    const dialog = mount(FromResourceDialog, { attachTo: document.body, props: { open: false, found } });
    await dialog.setProps({ open: true });
    const input = document.body.querySelector<HTMLInputElement>('[data-testid=from-resource-find] input');
    if (input === null) { throw new Error('no find field'); }
    input.value = 'read';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(dialog.emitted('find')?.at(-1)).toEqual(['read']);
    const placeholder = document.body.querySelector('[data-testid=from-resource-uri] input')?.getAttribute('placeholder');
    expect(placeholder).toBe('hub://resources/uploads/notes.md');
    document.body.querySelector<HTMLButtonElement>('[data-uri="fs://work/src/main.ts"]')?.click();
    await flushPromises();
    expect(document.body.querySelector<HTMLInputElement>('[data-testid=from-resource-uri] input')?.value).toBe('fs://work/src/main.ts');
    document.body.querySelector<HTMLButtonElement>('[data-testid=from-resource-save]')?.click();
    await flushPromises();
    expect(dialog.emitted('save')?.[0]).toEqual([{ uri: 'fs://work/src/main.ts', copy: 'live' }]);
    dialog.unmount();
  });
});

describe('the resource viewer and media', () => {
  it('tells its frame what it opened (name, type, size), whatever a list holds', async () => {
    const fakes = fakeStores({ signedIn: true });
    const wrapper = mount(ResourceViewer, { props: { uri: uri('fs://work/README.md') }, global: { provide: { [STORES]: fakes.stores } } });
    await flushPromises();
    expect(wrapper.emitted('opened')?.[0]?.[0]).toMatchObject({ name: 'README.md', format: 'markdown', size: 1_200 });
  });

  it('says when there is no media, or it fails to load, with Try again', async () => {
    const empty = mount(MediaViewer, { props: { src: '', kind: 'audio' } });
    expect(empty.get('[data-testid=media-problem]').text()).toContain('There is no audio to play.');
    expect(empty.find('audio').exists()).toBe(false);
    const broken = mount(MediaViewer, { props: { src: 'https://files.test/talk.mp3', kind: 'audio', title: 'Talk' } });
    expect(broken.find('[data-testid=media-problem]').exists()).toBe(false);
    await broken.get('audio').trigger('error');
    expect(broken.get('[data-testid=media-problem]').text()).toContain('Couldn\'t load this audio.');
    await broken.findAll('button').find((b) => b.text().includes('Try again'))?.trigger('click');
    expect(broken.find('[data-testid=media-problem]').exists()).toBe(false);
  });
});
