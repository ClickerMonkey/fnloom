/** The chat's side panels keep a width per panel type (Phil, 2026-11-18), through the real ChatView and its URL. */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../../app/App.vue';
import { createAppRouter } from '../../app/router.ts';
import { PANEL_WIDTH } from '../../state/layout.ts';
import { STORES } from '../../state/stores.ts';
import { fakeStores } from '../../test/fakes.ts';

function screen(width: number): void {
  const happyDOM: unknown = Reflect.get(window, 'happyDOM');
  const setViewport: unknown = typeof happyDOM === 'object' && happyDOM !== null ? Reflect.get(happyDOM, 'setViewport') : undefined;
  if (typeof setViewport !== 'function') { throw new Error('happy-dom has no setViewport'); }
  Reflect.apply(setViewport, happyDOM, [{ width, height: 900 }]);
}

const mounted: { unmount: () => void }[] = [];
beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => {
  for (const app of mounted.splice(0)) { app.unmount(); }
  screen(1440);
});

describe('ChatView panel width', () => {
  it('drags a panel from its left edge, saved for that panel type only (settings and people apart)', async () => {
    screen(1440);
    const fakes = fakeStores({ signedIn: true });
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push('/chat/ses_1?panel=settings');
    await router.isReady();
    const app = mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
    mounted.push(app);
    await flushPromises();
    const chat = (): HTMLElement => app.get<HTMLElement>('[data-testid=chat]').element;
    expect(chat().style.getPropertyValue('--panel')).toBe(`${PANEL_WIDTH.reset}px`);
    // the edge sits on the panel's left: moving it left widens the panel
    await app.get('[data-testid=chat-panel] [data-testid=splitter]').trigger('keydown', { key: 'ArrowLeft' });
    expect(fakes.stores.layout.panelWidth('panel:settings')).toBe(PANEL_WIDTH.reset + 16);
    expect(chat().style.getPropertyValue('--panel')).toBe(`${PANEL_WIDTH.reset + 16}px`);
    await router.push('/chat/ses_1?panel=people');
    await flushPromises();
    expect(chat().style.getPropertyValue('--panel')).toBe(`${PANEL_WIDTH.reset}px`);
    await router.push('/chat/ses_1?panel=settings');
    await flushPromises();
    expect(chat().style.getPropertyValue('--panel')).toBe(`${PANEL_WIDTH.reset + 16}px`);
    // End goes to the most the window allows: 60% of 1440
    await app.get('[data-testid=chat-panel] [data-testid=splitter]').trigger('keydown', { key: 'End' });
    expect(fakes.stores.layout.panelWidth('panel:settings')).toBe(864);
  });
});
