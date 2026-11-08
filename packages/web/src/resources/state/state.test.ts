import { flushPromises } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { failingCaller } from '../../test/fakes.ts';
import { fakeResources, fakeResourcesApi, fakeSystemViewers, uri } from '../test/fakes.ts';
import type { ModeRead } from '../logic/viewers.ts';

const RAW: ModeRead = { as: 'text', form: 'raw' };

describe('the viewer store', () => {
  it('opens a resource from the library, plans its modes and loads what the shown mode reads', async () => {
    const { resources, api } = fakeResources();
    const { store } = resources.viewer();
    await store.open(uri('fs://work/README.md'));
    expect(store.opened.value.value?.from).toBe('library');
    expect(store.plan.value?.modes.map((m) => m.id)).toEqual(['preview', 'source', 'info']);
    expect(store.mode.value?.id).toBe('preview');
    store.asked.value = 'source';
    expect(store.mode.value?.id).toBe('source');
    store.load(RAW);
    await flushPromises();
    expect(store.text(RAW)?.text).toContain('# Harness');
    store.load(RAW);
    expect(api.read.calls).toHaveLength(1);
  });

  it('reads a converted version from its presigned download', async () => {
    const { resources } = fakeResources();
    const { store } = resources.viewer();
    await store.open(uri('fs://work/data/book.xlsx'));
    const read = store.mode.value?.reads;
    if (read === undefined) { throw new Error('no mode'); }
    store.load(read);
    await flushPromises();
    const version = store.version(read);
    expect(version?.kind === 'table' ? version.tables.map((t) => t.name) : []).toEqual(['People', 'Places']);
  });

  it("falls back to the system's read for a resource the library doesn't hold", async () => {
    const api = { ...fakeResourcesApi(), forms: failingCaller<'resourceForms'>(new Error('not built')) };
    const { resources } = fakeResources({ api });
    const { store } = resources.viewer();
    await store.open(uri('fs://work/notes.md'));
    expect(store.opened.value.value).toMatchObject({ from: 'system', text: '# From the system' });
    store.load(RAW);
    await flushPromises();
    expect(store.text(RAW)?.text).toBe('# From the system');
    expect(api.read.calls).toHaveLength(0);
  });

  it('makes a form and opens again with it; a change to the opened resource reloads it', async () => {
    const { resources, api, events } = fakeResources({ api: fakeResourcesApi({ offers: [{ kind: 'ocr', model: 'openai/gpt-4o-mini' }] }) });
    const { store } = resources.viewer();
    await store.open(uri('fs://work/art/logo.png'));
    expect(store.plan.value?.modes.find((m) => m.id === 'ocr')?.draws).toBe('offer');
    expect(await store.make('ocr')).toBe(true);
    expect(api.convert.calls[0]?.[0]).toEqual({ uri: 'fs://work/art/logo.png', kind: 'ocr' });
    expect(api.forms.calls).toHaveLength(2);
    events.push({ uri: uri('fs://work/other.md'), forms: [] });
    events.push({ uri: uri('fs://work/art/logo.png'), forms: ['ocr'] });
    await flushPromises();
    expect(api.forms.calls).toHaveLength(3);
  });

  it("offers the systems' viewers and builds their props", async () => {
    const systems = fakeSystemViewers([{ component: {}, system: 'notes', mode: 'tab', label: 'Outline' }]);
    const { resources } = fakeResources({ systems });
    const { store } = resources.viewer();
    await store.open(uri('fs://work/README.md'));
    expect(store.plan.value?.modes.map((m) => m.id)).toEqual(['preview', 'source', 'system:notes', 'info']);
    const view = store.systemView('notes');
    expect(view?.forms).toEqual(['markdown']);
    expect(await view?.text()).toContain('# Harness');
  });

  it('stops following changes when its scope ends', async () => {
    const { resources, events } = fakeResources();
    const scope = effectScope();
    scope.run(() => { resources.viewer(); });
    await flushPromises();
    expect(events.listeners).toBe(1);
    scope.stop();
    expect(events.listeners).toBe(0);
  });
});

describe('the browser store', () => {
  it('shows a page with its facets, and each group in the groups view', async () => {
    const { resources, api } = fakeResources();
    const browser = resources.browser;
    await browser.show({ view: 'groups', group: 'source' });
    expect(browser.list.items.value).toHaveLength(9);
    expect(browser.facets.value.map((f) => `${f.value}:${f.count}`)).toEqual(['fs:8', 'hub:1']);
    expect([...browser.groups.value.keys()]).toEqual(['fs', 'hub']);
    expect(api.browseGroup.calls.map((c) => c[0]?.in)).toEqual(['fs', 'hub']);
    expect(browser.groups.value.get('hub')?.value.value?.items.map((r) => r.uri)).toEqual(['hub://resources/uploads/talk.mp3']);
  });

  it('loads folders as they open, and keeps the selection to what is shown', async () => {
    const { resources } = fakeResources();
    const browser = resources.browser;
    await browser.show({});
    await browser.openFolder('');
    expect(browser.folders.value.get('')?.value.value?.map((f) => f.value)).toEqual(['fs://work', 'hub://resources']);
    browser.toggle(uri('fs://work/README.md'));
    expect(browser.selectedCount.value).toBe(1);
    browser.toggleAll();
    expect(browser.selectedCount.value).toBe(9);
    browser.toggleAll();
    expect(browser.selectedCount.value).toBe(0);
  });

  it('uploads files and imports each, imports addresses, renames and deletes', async () => {
    const { resources, api, sender } = fakeResources();
    const browser = resources.browser;
    await browser.show({});
    await browser.upload([new File(['abc'], 'notes.txt', { type: 'text/plain' })]);
    expect(sender.sent).toEqual(['/_files?put=notes.txt']);
    expect(browser.uploads.value).toMatchObject([{ name: 'notes.txt', status: 'done', uri: 'hub://resources/notes.txt' }]);
    expect(api.importResource.calls[0]?.[0]).toMatchObject({ name: 'notes.txt' });
    expect((await browser.importUrl('https://example.com/a')).ok).toBe(true);
    expect(await browser.rename(uri('hub://resources/notes.txt'), 'renamed.txt')).toBe(true);
    browser.toggle(uri('hub://resources/uploads/talk.mp3'));
    expect(await browser.remove([uri('hub://resources/uploads/talk.mp3')])).toEqual({ deleted: 1, kept: 0 });
    expect(browser.selectedCount.value).toBe(0);
  });

  it('peeks at images and text for cards, once per version', async () => {
    const { resources, api } = fakeResources();
    const browser = resources.browser;
    await browser.show({});
    const [readme] = browser.list.items.value;
    const logo = browser.list.items.value.find((r) => r.stat.name === 'logo.png');
    if (readme === undefined || logo === undefined) { throw new Error('missing fixtures'); }
    browser.peek(readme);
    browser.peek(readme);
    browser.peek(logo);
    await flushPromises();
    expect(browser.peek(readme).value.value).toMatchObject({ kind: 'text' });
    const peeked = browser.peek(logo).value.value;
    expect(peeked?.kind === 'image' ? peeked.url : '').toContain('logo.png');
    expect(api.read.calls).toHaveLength(1);
  });
});
