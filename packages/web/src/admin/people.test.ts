/**
 * SSO in the web app: the People pages (Admin › People: people, groups, sign-in), URL-bound and on the admin's fake
 * hub; the People store's calls; the pages' words; and the sign-in page's provider buttons, its hand-over of an SSO
 * session, and a refused sign-in's problem.
 */
import { SSO_TEST_PAGE, type Tokens } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../app/App.vue';
import { createAppRouter } from '../app/router.ts';
import { links } from '../app/routes.ts';
import { STORES } from '../state/stores.ts';
import { fakeApi, fakeCaller, fakeStores, tokens } from '../test/fakes.ts';
import { policyText, readDomain, signInLabels, testHeadline } from './logic/people.ts';
import { PeopleStore } from './state/people.ts';
import { fakeAdmin, fakeAdminApi } from './test/fakes.ts';
import { ADA, BO, TEST_RESULT, fakePeopleApi } from './test/people.ts';

afterEach(() => { document.body.innerHTML = ''; });

async function open(path: string, options: { signedIn?: boolean; api?: ReturnType<typeof fakeApi>; admin?: ReturnType<typeof fakeAdmin> } = {}) {
  const fakes = fakeStores({ signedIn: options.signedIn ?? true, ...(options.api === undefined ? {} : { api: options.api }), ...(options.admin === undefined ? {} : { admin: options.admin }) });
  const router = createAppRouter(fakes.stores.session, createMemoryHistory());
  await router.push(path);
  await router.isReady();
  mount(App, { attachTo: document.body, global: { plugins: [router], provide: { [STORES]: fakes.stores } } });
  await flushPromises();
  return { ...fakes, router };
}

const text = (selector: string): string => document.body.querySelector(selector)?.textContent ?? '';

describe('the People pages\' words', () => {
  it('says what each first-sign-in policy lets in, and reads domains as typed', () => {
    expect(policyText({ mode: 'invite' })).toMatch(/^Only people an admin added/);
    expect(policyText({ mode: 'domains', domains: ['a.com', 'b.com', 'c.com'] })).toContain('a.com, b.com or c.com');
    expect(policyText({ mode: 'anyone' })).toMatch(/verified email/);
    expect([readDomain('@Example.COM'), readDomain('example'), readDomain('not a domain')]).toEqual(['example.com', undefined, undefined]);
  });

  it('names how a person signs in, and a test sign-in at a glance', () => {
    expect(signInLabels(ADA)).toEqual(['Break-glass password']);
    expect(signInLabels(BO)).toEqual(['Acme']);
    expect(testHeadline(TEST_RESULT)).toEqual({ tone: 'warn', title: 'This sign-in would be refused' });
    expect(testHeadline({ ...TEST_RESULT, problem: 'down' }).tone).toBe('danger');
  });
});

describe('the People store', () => {
  it('opens a person by email, reports a refused change, and starts a test sign-in', async () => {
    const api = fakePeopleApi();
    const people = new PeopleStore(api);
    await people.openPerson('bo@example.com');
    expect(people.person.value.value?.name).toBe('Bo');
    expect(api.people.calls.at(-1)?.[0]).toEqual({ filters: [{ field: 'email', op: 'is', value: 'bo@example.com' }], limit: 1 });
    const refused = await people.update({ user: ADA.id, role: 'member' });
    expect(refused.ok).toBe(false);
    expect(people.save.problem.value).toContain('break-glass');
    await expect(people.startTest('acme')).resolves.toEqual({ ok: true, value: { url: 'https://id.acme.test/authorize?state=s', test: 'tst_1' } });
    await people.check('acme');
    expect(people.checks.value.get('acme')?.ok).toBe(true);
  });
});

describe('Admin › People', () => {
  it('lists people with how each signs in, and opens one from the URL by email', async () => {
    await open('/admin/people?user=bo%40example.com');
    expect(document.body.querySelector('h1')?.textContent).toContain('People');
    expect(text('[data-testid="person-act_ada"]')).toContain('Break-glass');
    expect(text('[data-testid="person-act_bo"]')).toContain('Acme');
    const panel = text('[data-testid="person-panel"]');
    expect(panel).toContain('Finance');
    expect(panel).toContain('Synced');
  });

  it('adds a person from the dialog the URL opens', async () => {
    const admin = fakeAdmin();
    const { router } = await open('/admin/people?add=1', { admin });
    const form = document.body.querySelector('[data-testid="add-person-form"]');
    const inputs = form?.querySelectorAll('input') ?? [];
    for (const [input, value] of [[inputs[0], 'Cy'], [inputs[1], 'cy@example.com']] as const) {
      if (input instanceof HTMLInputElement) { input.value = value; input.dispatchEvent(new Event('input')); }
    }
    document.body.querySelector<HTMLButtonElement>('[data-testid="add-person-save"]')?.click();
    await flushPromises();
    expect(admin.api.addUser.calls.at(-1)?.[0]).toEqual({ name: 'Cy', email: 'cy@example.com', role: 'member' });
    expect(router.currentRoute.value.query['add']).toBeUndefined();
  });

  it('shows groups with their counts and opens one with its members', async () => {
    await open('/admin/people/groups?group=act_finance');
    expect(text('[data-testid="group-act_finance"]')).toContain('1 person');
    expect(text('[data-testid="group-panel"]')).toContain('Bo');
  });

  it('shows the providers read-only, checks one, keeps the policy, and shows a test sign-in that came back', async () => {
    const admin = fakeAdmin();
    await open(`${SSO_TEST_PAGE}?test=tst_1`, { admin });
    expect(text('[data-testid="provider-acme"]')).toContain('https://hub.test/auth/sso/callback');
    expect(text('[data-testid="provider-acme"]')).toContain('makes an admin');
    expect(text('[data-testid="sso-test"]')).toContain('This sign-in would be refused');
    expect(text('[data-testid="sso-test"]')).toContain('no group here named Nope');
    document.body.querySelector<HTMLButtonElement>('[data-testid="check-acme"]')?.click();
    await flushPromises();
    expect(text('[data-testid="provider-acme"]')).toContain('2 signing keys.');
    const anyone = [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="sign-in-policy"] [role="radio"]')].find((b) => b.textContent.includes('Anyone'));
    anyone?.click();
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('[data-testid="save-policy"]')?.click();
    await flushPromises();
    expect(admin.api.setSignInPolicy.calls.at(-1)?.[0]).toEqual({ mode: 'anyone' });
  });

  it('is in the admin nav, at its own URL', () => {
    expect(links.people('sign-in', { test: 't' })).toEqual({ name: 'people', params: { tab: 'sign-in' }, query: { test: 't' } });
    expect(fakeAdminApi().signInSettings).toBeDefined();
  });
});

describe('Settings › Account', () => {
  it('shows a member how they sign in and the groups they are in', async () => {
    await open('/settings/account');
    const facts = text('[data-testid="account-facts"]');
    expect(facts).toContain('Acme');
    expect(facts).toContain('Team');
    expect(document.body.textContent).toContain('Groups from your sign-in provider update each time you sign in.');
  });
});

describe('the sign-in page with SSO', () => {
  it('offers each provider as a link to the hub\'s start, keeping where to go after, with the password folded away', async () => {
    const api = fakeApi();
    api.auth.setup = fakeCaller<'setup'>(() => Promise.resolve({ needsAdmin: false, name: 'Hub', version: '1', sso: [{ id: 'acme', label: 'Acme' }] }));
    await open('/sign-in?next=%2Finbox', { signedIn: false, api });
    const link = document.body.querySelector<HTMLAnchorElement>('[data-testid="sso-acme"]');
    expect(link?.getAttribute('href')).toBe('/auth/sso/acme/start?next=%2Finbox');
    expect(link?.textContent).toContain('Continue with Acme');
    expect(document.body.querySelector('[data-testid="sign-in-form"]')).toBeNull();
    document.body.querySelector<HTMLButtonElement>('[data-testid="password-toggle"]')?.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="sign-in-form"]')).not.toBeNull();
  });

  it('swaps the hand-off code in the fragment for a session, wipes it from the address, and goes on', async () => {
    const api = fakeApi();
    const fresh: Tokens = tokens({ refresh: 'rotated' });
    api.auth.redeemSso = fakeCaller<'redeemSso'>(() => Promise.resolve(fresh));
    const { router, stores } = await open('/sign-in?next=%2Finbox#sso=handover-1', { signedIn: false, api });
    expect(api.auth.redeemSso.calls[0]?.[0]).toEqual({ code: 'handover-1' });
    expect(api.auth.refresh.calls).toHaveLength(0);
    expect(stores.session.refreshToken.value).toBe('rotated');
    await vi.waitFor(() => { expect(router.currentRoute.value.path).toBe('/inbox'); });
    expect(router.currentRoute.value.hash).toBe('');
  });

  it('shows why a provider sign-in was refused', async () => {
    await open(`/sign-in?problem=${encodeURIComponent('This hub is invite only.')}`, { signedIn: false });
    expect(text('[data-testid="sign-in-problem"]')).toBe('This hub is invite only.');
  });
});
