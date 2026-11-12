/**
 * A page about one thing (`keepTitle`) names it in the phone's top bar ("fs", not "System") while it shows, and gives
 * the bar back when it goes; a plain page, or one drawn inside another, leaves the bar alone.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { STORES } from '../state/stores.ts';
import { fakeStores } from '../test/fakes.ts';
import AppPage from './AppPage.vue';

describe('the page title in the top bar', () => {
  it('is the kept title while the page shows', async () => {
    const { stores } = fakeStores({ signedIn: true });
    const provide = { [STORES]: stores };
    const page = mount(AppPage, { props: { title: 'fs', keepTitle: true }, global: { provide } });
    expect(stores.layout.pageTitle.value).toBe('fs');
    await page.setProps({ title: 'notes' });
    expect(stores.layout.pageTitle.value).toBe('notes');
    const plain = mount(AppPage, { props: { title: 'Systems' }, global: { provide } });
    expect(stores.layout.pageTitle.value).toBe('notes');
    plain.unmount();
    page.unmount();
    expect(stores.layout.pageTitle.value).toBeUndefined();
  });
});
