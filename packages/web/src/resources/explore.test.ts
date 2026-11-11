/** The file explorer: its addresses (pure), and the page over the fake stores, every view in the URL. */
import { ResourceRoot } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../app/App.vue';
import { createAppRouter } from '../app/router.ts';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import { crumbsOf, entryName, pathUnder, placeOf, sortEntries, uriUnder } from './logic/explore.ts';
import { EXPLORE_ROOT, EXPLORE_TREE, exploreEntry } from './test/fakes.ts';

afterEach(() => { document.body.innerHTML = ''; });

describe('the explorer’s addresses', () => {
  it('reads a page path against the roots and goes back and forth between paths and uris', () => {
    const slashed = ResourceRoot.parse({ ...EXPLORE_ROOT, uri: 'file:///work/' });
    expect(uriUnder(EXPLORE_ROOT, ['src', 'lib'])).toBe('file:///work/src/lib');
    expect(uriUnder(slashed, ['src'])).toBe('file:///work/src');
    expect(uriUnder(EXPLORE_ROOT, [])).toBe('file:///work');
    expect(pathUnder(EXPLORE_ROOT, 'file:///work/src/lib/')).toEqual(['src', 'lib']);
    expect(pathUnder(slashed, 'file:///work')).toEqual([]);
    expect(pathUnder(EXPLORE_ROOT, 'file:///elsewhere/a')).toBeUndefined();
    expect(placeOf([EXPLORE_ROOT], ['work', 'src'])).toEqual({ root: EXPLORE_ROOT, path: ['src'] });
    expect(placeOf([EXPLORE_ROOT], ['gone'])).toEqual({ root: undefined, path: [] });
    expect(entryName('file:///work/src/app.ts')).toBe('app.ts');
    expect(crumbsOf(EXPLORE_ROOT, ['my%20docs']).map((c) => c.label)).toEqual(['work', 'my docs']);
    expect(sortEntries([exploreEntry('file:///w/b10', 'file'), exploreEntry('file:///w/b2', 'file'), exploreEntry('file:///w/z', 'folder')]).map((e) => e.name)).toEqual(['z', 'b2', 'b10']);
  });
});

describe('the explorer page', () => {
  it('lists an instance’s roots, goes into folders, opens a file beside them, all in the URL, reading live', async () => {
    const fakes = fakeStores({ signedIn: true });
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push('/explore/fs/main');
    await router.isReady();
    mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
    await flushPromises();
    const names = (): string[] => [...document.body.querySelectorAll('[data-testid="explore-entry"] .name')].map((el) => el.textContent);
    const press = async (name: string): Promise<void> => {
      [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="explore-entry"] .open')].find((el) => el.textContent.trim() === name)?.click();
      await flushPromises();
    };

    expect(names()).toEqual(['work']);
    await press('work');
    expect(router.currentRoute.value.fullPath).toBe('/explore/fs/main/work');
    expect(names()).toEqual(['src', 'README.md']);
    await press('src');
    expect(router.currentRoute.value.fullPath).toBe('/explore/fs/main/work/src');
    expect(names()).toEqual(['lib', 'app.ts']);
    expect(document.body.querySelector('[data-testid="explore-crumbs"]')?.textContent).toContain('work/src');
    await press('app.ts');
    expect(router.currentRoute.value.fullPath).toBe('/explore/fs/main/work/src?open=app.ts');
    expect(document.body.querySelector('[data-testid="explore-file"]')?.textContent).toContain('export const answer = 42;');
    const api = fakes.resources.api;
    expect(api.exploreRead.calls.map(([body]) => body)).toEqual([{ uri: 'file:///work/src/app.ts', want: ['text'] }]);
    expect(api.exploreList.calls.map(([body]) => body.uri)).toEqual(['file:///work', 'file:///work/src']);
    expect(Object.keys(EXPLORE_TREE)).toContain('file:///work/src/lib');
  });
});
