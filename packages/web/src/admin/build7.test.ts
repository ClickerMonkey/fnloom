/**
 * Build 7 on the admin pages: a system's review (its fns joined with their facts, its declared items, grants, pending
 * changes as diffs, checks), the review store (switches, going live and approving by the reviewed hash, test calls),
 * the parts of a system one kind at a time with switches, and a system's own config component.
 */
import { ApiError } from '@ayepi/core/client';
import { SystemParts, type Json } from '@harness/core';
import { g, wireType } from '@harness/sdk';
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import ChangeList from './components/ChangeList.vue';
import ConfigCustom from './components/ConfigCustom.vue';
import PartsByKind from './components/PartsByKind.vue';
import ReviewFnList from './components/ReviewFnList.vue';
import { checksConcerns, checksLine, checksWarn, clientFileUrl, declaredItems, fnReviews, grantRows, lineDiff, refusalLine, timeText, withSwitch } from './logic/review.ts';
import { partChoices, partGroups, shownPart } from './logic/systems.ts';
import { ConfigComponents, configTarget, UNAPPROVED_CONFIG } from './state/config-component.ts';
import { fakeAdmin, fakeAdminApi } from './test/fakes.ts';
import { notesManifest, review } from './test/review.ts';
import { fakeCaller } from '../test/fakes.ts';

afterEach(() => { document.body.innerHTML = ''; });
const stubs = { RouterLink: RouterLinkStub };

describe('review logic', () => {
  it('joins each fn with its facts, its effects line and its switch', () => {
    const fns = fnReviews(review({ off: [{ section: 'fns', name: 'notes/find' }] }));
    expect(fns.map((fn) => [fn.name, fn.on, fn.facts?.mode, fn.effects])).toEqual([
      ['notes/find', false, undefined, undefined],
      ['notes/save', true, 'write', 'Creates context.'],
    ]);
  });

  it('words a refusal as what it tried, then why', () => {
    expect(refusalLine({ attempt: 'OPENAI_API_KEY', detail: 'it may read only NOTES_TOKEN' })).toBe('Tried OPENAI_API_KEY: it may read only NOTES_TOKEN.');
    expect(timeText({ times: { runs: 3, typical: 1_200, slow: 3_000, longest: 4_000 }, longRunning: false })).toMatch(/^About .+, slow .+$/);
    expect(timeText({ longRunning: false })).toBe('No runs yet');
  });

  it('lists declared context and types, marking runtime additions and off items', () => {
    const sample = review({ manifest: notesManifest('hash-1', { runtime: { types: ['Note'] } }), off: [{ section: 'context', name: 'notes/how' }] });
    expect(declaredItems(sample, 'context')).toMatchObject([{ name: 'notes/how', on: false, runtime: false }]);
    expect(declaredItems(sample, 'types')).toMatchObject([{ name: 'notes/Note', on: true, runtime: true }]);
  });

  it('switches an item into and out of the off list, once', () => {
    const item = { section: 'kinds' as const, name: 'notes/memo' };
    const off = withSwitch(withSwitch([], item, false), item, false);
    expect(off).toEqual([item]);
    expect(withSwitch(off, item, true)).toEqual([]);
  });

  it('reads grants as rows, and none without grants', () => {
    const rows = grantRows(review().manifest.grants, (usd) => `$${usd}`);
    expect(rows.map((row) => [row.key, row.values])).toEqual([
      ['hub', ['Call models through the hub', 'Search fns and examples']], ['roles', ['chat']], ['spend', ['$0.05 a run', '$1 a day']], ['network', ['api.example.com']],
    ]);
    expect(grantRows(undefined, String)).toEqual([]);
  });

  it('diffs a change line by line', () => {
    const diff = lineDiff({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
    expect(diff.filter((line) => line.kind !== 'same').map((line) => `${line.kind} ${line.text.trim()}`)).toEqual(['remove "b": 2', 'add "b": 3,', 'add "c": 4']);
    expect(lineDiff(undefined, { a: 1 }).every((line) => line.kind === 'add')).toBe(true);
  });

  it('sums up checks and says when they need a look', () => {
    expect(checksLine(review().checks)).toBe('3 passed, 1 failed, 1 skipped · 1 scan concern');
    expect(checksWarn(review().checks)).toBe(true);
    expect(checksLine(undefined)).toBe('No checks recorded');
    expect(checksConcerns(review().checks)).toBe('1 test failed and the scan found 1 concern');
    expect(checksConcerns(undefined)).toBeUndefined();
  });

  it('offers only the part kinds a system has, falling back to the first', () => {
    const groups = partGroups(SystemParts.parse({
      parts: [{ section: 'commands', name: '/memo', about: '', origin: 'contract', version: 'v1', decl: {} }], more: {},
    }));
    const choices = partChoices(groups, 0);
    expect(choices.map((choice) => [choice.value, choice.count])).toEqual([['commands', 1]]);
    expect(shownPart(choices, 'roots')).toBe('commands');
    expect(shownPart([], 'roots')).toBeUndefined();
  });

  it('finds a contract’s config component in its client build, approved only when the hub says so', () => {
    expect(configTarget(review())).toBeUndefined();
    const manifest = notesManifest('h', { client: { entry: 'client/index.js', hash: 'c1', files: [] }, configComponent: { component: 'NotesConfig', mode: 'replace' } });
    expect(configTarget({ manifest, clientApproved: true })).toEqual({ system: 'notes', client: manifest.client, decl: { component: 'NotesConfig', mode: 'replace' }, approved: true });
    expect(configTarget({ manifest })).toMatchObject({ approved: false });
    expect(clientFileUrl(manifest.name, { entry: 'client/index.js', hash: 'c1' })).toBe('/clients/notes/c1/client/index.js');
  });
});

describe('ReviewStore', () => {
  it('switches fns by their flag and other parts by name, putting a refused switch back', async () => {
    const { admin, api } = fakeAdmin();
    await admin.review.open(review().system);
    expect(await admin.review.switch({ section: 'fns', name: 'notes/find' }, false)).toBe(true);
    expect(api.switchItem.calls.at(-1)?.[0]).toEqual({ section: 'fns', name: 'notes/find', on: false });
    expect(admin.review.isOn({ section: 'fns', name: 'notes/find' })).toBe(false);

    const refusing = fakeAdminApi();
    refusing.switchPart = fakeCaller<'switchPart'>(() => Promise.reject(new ApiError(409, 'CHANGED', 'that kind changed')));
    const second = fakeAdmin({ api: refusing });
    await second.admin.review.open(review().system);
    expect(await second.admin.review.switch({ section: 'kinds', name: 'notes/memo' }, false)).toBe(false);
    expect(refusing.switchPart.calls[0]?.[0]).toEqual({ system: 'notes', section: 'kinds', name: 'notes/memo', on: false });
    expect(second.admin.review.isOn({ section: 'kinds', name: 'notes/memo' })).toBe(true);
    expect(second.admin.review.switching.problem.value).toBe('That kind changed.');
  });

  it('goes live with the reviewed hash and the items kept off, and approves by the pending hash', async () => {
    const { admin, api } = fakeAdmin();
    api.systemReview = fakeCaller<'systemReview'>(() => Promise.resolve(review({ off: [{ section: 'types', name: 'notes/Note' }] })));
    const store = fakeAdmin({ api }).admin.review;
    await store.open(review().system);
    expect(await store.goLive()).toEqual({ ok: true, value: 'live' });
    expect(api.goLive.calls[0]?.[0]).toEqual({ system: 'notes', hash: 'hash-1', off: [{ section: 'types', name: 'notes/Note' }] });

    expect(await store.approve()).toEqual({ ok: false, problem: 'Nothing waits for review.' });
    api.systemReview = fakeCaller<'systemReview'>(() => Promise.resolve(review({ stage: 'live', pending: { version: '1.1.0', hash: 'hash-2', by: 'contract', changes: [], since: 1, summary: { line: 'No changes', counts: [], flags: [] }, fns: [] } })));
    const live = fakeAdmin({ api }).admin.review;
    await live.open(review().system);
    expect(await live.approve()).toEqual({ ok: true, value: 'hash-2' });
    expect(api.approveReview.calls[0]?.[0]).toMatchObject({ hash: 'hash-2' });
    expect(await live.reject()).toEqual({ ok: true, value: true });
    expect(admin).toBeDefined();
  });

  it('runs a test call and pages refusals', async () => {
    const { admin, api } = fakeAdmin();
    expect(await admin.review.testCall('notes/find', { q: 'x' })).toEqual({ ok: true, value: 'run_test' });
    expect(api.testCall.calls[0]?.[0]).toEqual({ fn: 'notes/find', args: { q: 'x' } });
    await admin.review.loadRefusals(review().system, 'mode');
    expect(api.refusals.calls[0]?.[0]).toEqual({ system: 'notes', limit: 50, rule: 'mode' });
    expect(admin.review.refusals.items.value.map((r) => r.id)).toEqual(['rfs_1']);
  });
});

describe('review components', () => {
  it('lists fns with switches, and opens one to its instructions, examples and test call', async () => {
    const wrapper = mount(ReviewFnList, { props: { fns: fnReviews(review()) }, global: { stubs } });
    await wrapper.find('[data-fn="notes/find"] [role="switch"]').trigger('click');
    expect(wrapper.emitted('switch')?.[0]).toEqual(['notes/find', false]);
    expect(wrapper.text()).toContain('Creates context.');
    await wrapper.find('[data-fn="notes/find"] [data-testid="review-fn"]').trigger('click');
    const body = wrapper.find('[data-testid="review-fn-body"]');
    expect(body.text()).toContain('Search by words in the title.');
    expect(body.text()).toContain('find({"q":"plans"})');
    expect(body.find('[data-testid="review-fn-facts"]').text()).toContain('native');
    expect(body.find('[data-testid="review-fn-no-facts"]').exists()).toBe(true);
    await body.find('[data-testid="review-fn-test"]').trigger('click');
    expect(wrapper.emitted('test')?.[0]?.[0]).toMatchObject({ name: 'notes/find' });
  });

  it('shows a change’s raw line diff behind its toggle', async () => {
    const wrapper = mount(ChangeList, { props: { changes: [{ section: 'fns', name: 'notes/find', change: 'changed', origin: 'contract', before: { a: 1 }, after: { a: 2 } }] } });
    expect(wrapper.text()).toContain('Changed');
    expect(wrapper.find('[data-testid="review-diff"]').exists()).toBe(false);
    await wrapper.find('[data-testid="toggle-raw-diff"]').trigger('click');
    expect(wrapper.findAll('.line.add').map((line) => line.text())).toEqual(['+   "a": 2']);
    expect(wrapper.findAll('.line.remove').map((line) => line.text())).toEqual(['−   "a": 1']);
  });

  it('lists an injection’s targets on its card, each with the agents it hits now, or that it hits none yet', () => {
    const after = { name: 'deals', description: 'Deals.', content: 'Look it up.', imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', tags: [], inject: { into: ['hub/chat*', 'billing/*'], order: 40, requires: [] } };
    const wrapper = mount(ChangeList, {
      props: {
        changes: [{ section: 'context', name: 'notes/deals', change: 'added', origin: 'contract', after }],
        injections: [{
          section: 'context', name: 'notes/deals', title: 'Deals', change: 'added', tokens: 3,
          targets: [{ target: 'hub/chat*', agents: ['hub/chat', 'hub/chat_small'] }, { target: 'billing/*', agents: [] }], agents: ['hub/chat', 'hub/chat_small'],
        }],
      },
      global: { stubs },
    });
    const targets = wrapper.findAll('[data-testid="inject-target"]');
    expect(targets.map((target) => target.find('code').text())).toEqual(['hub/chat*', 'billing/*']);
    expect(targets[0]?.find('[data-testid="inject-no-agent"]').exists()).toBe(false);
    expect(targets[1]?.find('[data-testid="inject-no-agent"]').text()).toBe('hits no agent yet');
    expect(wrapper.find('[data-testid="inject-targets"]').text()).toContain('Will be told to');
  });

  it('shows one kind of part at a time, each with its switch', async () => {
    const groups = partGroups(SystemParts.parse({
      parts: [
        { section: 'kinds', name: 'notes/memo', about: 'A memo kind', origin: 'contract', version: 'v1', decl: {} },
        { section: 'commands', name: '/memo', about: 'Memo', origin: 'runtime', version: 'v2', decl: {}, on: false },
      ],
      more: {},
    }));
    const wrapper = mount(PartsByKind, {
      props: { groups, roots: [], part: 'roots', rootPage: () => '/', ownerPage: () => '/', isOn: (item: { name: string }) => item.name !== '/memo', 'onUpdate:part': () => undefined },
      global: { stubs },
    });
    expect(wrapper.findAll('[data-part-tab]').map((choice) => choice.attributes('data-part-tab'))).toEqual(['kinds', 'commands']);
    expect(wrapper.findAll('[data-part]').map((row) => row.attributes('data-part'))).toEqual(['notes/memo']);
    await wrapper.find('[data-part-tab="commands"]').trigger('click');
    expect(wrapper.emitted('update:part')?.[0]).toEqual(['commands']);
    await wrapper.setProps({ part: 'commands' });
    expect(wrapper.find('[data-part="/memo"]').classes()).toContain('off');
  });
});

describe('a system’s own config component', () => {
  const TYPE = wireType(g.obj({ folder: g.text({ minLength: 1 }) }));
  /** A stand-in for a system's config component: shows the folder and offers a change. */
  const NotesConfig = defineComponent({
    props: { config: { type: null, required: false, default: undefined }, type: { type: null, required: true }, validate: { type: Function, required: true }, client: { type: null, required: true } },
    emits: ['change'],
    setup(props, { emit }) {
      return () => h('div', { 'data-testid': 'notes-config' }, [
        h('span', JSON.stringify(props.config)),
        h('button', { 'data-testid': 'pick', onClick: () => { emit('change', { folder: '/notes' }); } }, 'Pick'),
        h('button', { 'data-testid': 'clear', onClick: () => { emit('change', { folder: '' }); } }, 'Clear'),
      ]);
    },
  });

  function loader(exports: Record<string, unknown>) {
    const register = vi.fn();
    const share = vi.fn(() => Promise.resolve());
    const imported: string[] = [];
    const made = new ConfigComponents({
      import: (url) => { imported.push(url); return Promise.resolve(exports); },
      share,
      runtime: { register, systemClient: () => ({ online: true, send: {}, run: {} }) },
    });
    return { made, register, share, imported };
  }
  const target = { system: notesManifest().name, client: { entry: 'index.js', hash: 'c1' }, decl: { component: 'NotesConfig', mode: 'replace' as const }, approved: true };

  it('imports a build once, sharing the app’s modules first, and says when the export is missing', async () => {
    const { made, share, imported } = loader({ NotesConfig });
    expect(await made.load(target)).toBe(NotesConfig);
    await made.load(target);
    expect(imported).toEqual(['/clients/notes/c1/index.js']);
    expect(share).toHaveBeenCalledTimes(1);
    await expect(made.load({ ...target, decl: { component: 'Gone', mode: 'replace' } })).rejects.toThrow('no config component named Gone');
  });

  it('never imports a build no admin approved: the page says it loads once approved', async () => {
    const { made, imported } = loader({ NotesConfig });
    await expect(made.load({ ...target, approved: false })).rejects.toThrow(UNAPPROVED_CONFIG);
    const wrapper = mount(ConfigCustom, { props: { target: { ...target, approved: false }, loader: made, type: TYPE, value: { folder: '/old' } satisfies Json } });
    await flushPromises();
    expect(wrapper.find('[data-testid="config-custom-unapproved"]').text()).toBe('Its settings page loads once you approve it.');
    expect(wrapper.find('[data-testid="notes-config"]').exists()).toBe(false);
    expect(imported).toEqual([]);
  });

  it('draws it with the config, checks a change with gin, and saves a valid one', async () => {
    const { made } = loader({ NotesConfig });
    const wrapper = mount(ConfigCustom, { props: { target, loader: made, type: TYPE, value: { folder: '/old' } satisfies Json } });
    await flushPromises();
    expect(wrapper.find('[data-testid="notes-config"]').text()).toContain('/old');
    await wrapper.find('[data-testid="clear"]').trigger('click');
    expect(wrapper.find('[data-testid="config-custom-problems"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="config-custom-save"]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-testid="pick"]').trigger('click');
    await wrapper.find('[data-testid="config-custom-save"]').trigger('click');
    expect(wrapper.emitted('save')?.[0]).toEqual([{ folder: '/notes' }]);
  });
});
