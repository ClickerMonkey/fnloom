/**
 * The hub's display name shows everywhere the app names itself, live: the sign-in page (brand, lead, version line),
 * the shell's brand, the tab title, and the admin's Settings field; a rename reaches open tabs through the user
 * channel. A source scan keeps "Harness" out of anything a person would read.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { STORES } from '../state/stores.ts';
import { checkHubName, HUB_NAME_KEY } from '../state/identity.ts';
import { fakeStores } from '../test/fakes.ts';
import App from './App.vue';
import { createAppRouter } from './router.ts';
import { tabTitle } from './title.ts';

const NAME = 'Diffenderfer Hub';

async function start(path: string, signedIn: boolean) {
  const fakes = fakeStores({ signedIn });
  fakes.api.identity.identity.call = () => Promise.resolve({ name: NAME, source: 'setting', version: '2.1.0' });
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  await flushPromises();
  return { ...fakes, app };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('the hub name', () => {
  it('names the hub on the sign-in page, and nowhere says Harness', async () => {
    const { app } = await start('/sign-in', false);
    expect(app.get('[data-testid="brand-name"]').text()).toBe(NAME);
    expect(app.text()).toContain(`Sign in to ${NAME}.`);
    expect(app.get('[data-testid="hub-version"]').text()).toBe(`${NAME} · 2.1.0`);
    expect(document.title).toContain(NAME);
    expect(`${app.text()} ${document.title}`).not.toMatch(/harness/i);
    app.unmount();
  });

  it('names the hub in the shell and the tab title, and follows a rename live', async () => {
    const { app, events, store } = await start('/inbox', true);
    expect(app.get('nav[aria-label="Main"] [data-testid="brand-name"]').text()).toBe(NAME);
    expect(document.title).toBe(`Inbox · ${NAME}`);
    expect(`${app.text()} ${document.title}`).not.toMatch(/harness/i);
    expect(store.getItem(HUB_NAME_KEY)).toBe(JSON.stringify(NAME));

    events.push({ type: 'identity', identity: { name: 'Home Base', source: 'setting', version: '2.1.0' } });
    await flushPromises();
    expect(app.get('[data-testid="brand-name"]').text()).toBe('Home Base');
    expect(document.title).toBe('Inbox · Home Base');
    app.unmount();
  });

  it('lets an admin rename the hub from Settings, and clear it back to the default', async () => {
    const { app, api } = await start('/settings/hub', true);
    const input = app.get<HTMLInputElement>('[data-testid="hub-name-card"] input');
    expect(input.element.value).toBe(NAME);
    await input.setValue('  ');
    await app.get('[data-testid="hub-name-card"] form').trigger('submit');
    expect(app.text()).toContain('Give the hub a name.');
    expect(api.identity.setHubName.calls).toHaveLength(0);

    await input.setValue('Home Base');
    await app.get('[data-testid="hub-name-card"] form').trigger('submit');
    await flushPromises();
    expect(api.identity.setHubName.calls).toEqual([[{ name: 'Home Base' }]]);
    expect(app.get('[data-testid="brand-name"]').text()).toBe('Home Base');

    await app.get('[data-testid="hub-name-reset"]').trigger('click');
    await flushPromises();
    expect(api.identity.setHubName.calls.at(-1)).toEqual([{ name: null }]);
    app.unmount();
  });

  it('checks a name as the hub does, and titles the tab', () => {
    expect(checkHubName(' Home ')).toEqual({ ok: true, name: 'Home' });
    expect(checkHubName('x'.repeat(41)).ok).toBe(false);
    expect(tabTitle('Chat', 0, 'Home')).toBe('Chat · Home');
    expect(tabTitle('Home', 3, 'Home')).toBe('(3) Home');
    expect(tabTitle('Inbox', 120, 'Home')).toBe('(99+) Inbox · Home');
  });
});

/** Folders and files whose text is samples or test data, not the app's own words. */
const SKIP = /\.test\.ts$|\/test\/|\/design\/samples\.ts$|manifest\.gen\.ts$/;

/** Every source file of the app, by path. */
const SOURCES: Record<string, string> = import.meta.glob('../**/*.{ts,vue}', { query: '?raw', import: 'default', eager: true });

describe('no fixed product name in what people read', () => {
  it('has no "Harness" in templates or strings', () => {
    const found: string[] = [];
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    for (const [at, text] of Object.entries(SOURCES)) {
      if (SKIP.test(at)) { continue; }
      text.split('\n').forEach((line, i) => {
        const code = line.trim();
        // comments are for readers of the code; code names (`harness system pack`, storage keys) are lower case
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*') || code.startsWith('<!--')) { return; }
        if (/\bHarness\b/.test(line)) { found.push(`${at}:${String(i + 1)}: ${code}`); }
      });
    }
    expect(found).toEqual([]);
  });
});
