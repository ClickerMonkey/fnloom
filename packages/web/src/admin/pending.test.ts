/**
 * The Pending tab (to-do item 12): the diff logic its views share (words, markdown blocks, sequences), its groups and
 * fn facts, grants as a delta, the store deciding one change at a time by the pending hash, and the tab itself: the
 * hub's summary strip, each change drawn as its tab draws it, per-change Approve and Decline, the raw diff toggle, and
 * the runtime additions a page at a time. The install card shows the same strip.
 */
import { ApprovalPreview, FnChangeFacts, Json, type SystemReview, type ContractChange, type ReviewSummary } from '@harness/core';
import { g } from '@harness/sdk';
import { mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import ApprovalPreviewView from '../components/approvals/ApprovalPreview.vue';
import ChangeList from './components/ChangeList.vue';
import GrantsView from './components/GrantsView.vue';
import MarkdownDiff from './components/pending/MarkdownDiff.vue';
import PendingTab from './components/pending/PendingTab.vue';
import { blockDiff, changeGroups, changeView, factRows, grantDeltaRows, markdownBlocks, RUNTIME_PAGE, sequenceDiff, typeDiffPart, wordDiff } from './logic/review.ts';
import { fakeAdmin } from './test/fakes.ts';
import { review } from './test/review.ts';
import { fakeCaller } from '../test/fakes.ts';

afterEach(() => { document.body.innerHTML = ''; });
const stubs = { RouterLink: RouterLinkStub };
const money = (usd: number): string => `$${usd.toFixed(2)}`;

const SUMMARY: ReviewSummary = {
  line: '+1 fn, 1 changed, 1 context item changed, grants widened', grants: 'widened',
  counts: [{ section: 'fns', added: 1, changed: 1, removed: 0 }, { section: 'context', added: 0, changed: 1, removed: 0 }, { section: 'grants', added: 0, changed: 1, removed: 0 }],
  flags: [{ flag: 'delete-fns', line: 'Can delete: notes/purge', items: ['notes/purge'] }, { flag: 'hosts', line: 'New hosts: cdn.example.com', items: ['cdn.example.com'] }],
};
const CHANGES: ContractChange[] = [
  { section: 'fns', name: 'notes/purge', change: 'added', origin: 'contract', after: { description: 'Drop old notes.' } },
  { section: 'fns', name: 'notes/find', change: 'changed', origin: 'contract', before: { description: 'Find notes.' }, after: { description: 'Find notes by tag.' } },
  { section: 'context', name: 'notes/how', change: 'changed', origin: 'contract', before: { description: 'How.', content: '# Notes\n\nFind first.\n\nThen save.' }, after: { description: 'How.', content: '# Notes\n\nFind first, always.\n\nThen save.\n\nTag them.' } },
  { section: 'grants', name: 'notes', change: 'changed', origin: 'contract', before: { hub: ['ai'], network: ['api.example.com'] }, after: { hub: ['ai'], network: ['api.example.com', 'cdn.example.com'] } },
];
const FACTS = FnChangeFacts.array().parse([
  { name: 'notes/purge', after: { mode: 'delete', effects: 'Removes context.', reads: [], writes: [], deps: [] } },
  { name: 'notes/find', before: { mode: 'read', reads: [], writes: [], deps: [] }, after: { mode: 'read', reads: [], writes: [], deps: ['notes/tags'], cost: 0.01 } },
]);
const pendingReview = (changes: readonly ContractChange[] = CHANGES): SystemReview => review({
  stage: 'live', pending: { version: '1.1.0', hash: 'hash-2', by: 'contract', changes, since: 1, summary: SUMMARY, fns: FACTS },
  declined: [{ section: 'fns', name: 'notes/sneak', change: 'added', origin: 'runtime', version: '1.0.1', by: 'act_admin', at: 2 }],
});

describe('diffs the Pending tab draws', () => {
  it('diffs sequences, words and markdown blocks, pairing a replaced block as one change', () => {
    expect(sequenceDiff(['a', 'b', 'c'], ['a', 'c', 'd']).map((p) => `${p.kind}:${p.value}`)).toEqual(['same:a', 'remove:b', 'same:c', 'add:d']);
    expect(sequenceDiff(['a', 'b'], ['c'], 1).map((p) => p.kind)).toEqual(['remove', 'remove', 'add']);
    expect(wordDiff('Find notes.', 'Find notes by tag.')).toEqual([{ kind: 'same', text: 'Find ' }, { kind: 'remove', text: 'notes.' }, { kind: 'add', text: 'notes by tag.' }]);
    expect(markdownBlocks('# A\n\n```\nx\n\ny\n```\n\nz')).toEqual(['# A', '```\nx\n\ny\n```', 'z']);
    const blocks = blockDiff('# Notes\n\nFind first.\n\nThen save.', '# Notes\n\nFind first, always.\n\nThen save.\n\nTag them.');
    expect(blocks.map((b) => b.kind)).toEqual(['same', 'change', 'same', 'add']);
    expect(blocks[1]?.words?.filter((w) => w.kind !== 'same').map((w) => w.text)).toEqual(['first.', 'first, always.']);
    expect(blockDiff('Gone.', '').map((b) => b.kind)).toEqual(['remove']);
  });

  it('draws a context item as rendered blocks, folding long unchanged runs', () => {
    const many = Array.from({ length: 6 }, (_, at) => `Para ${at}.`).join('\n\n');
    const wrapper = mount(MarkdownDiff, { props: { before: many, after: `${many}\n\nNew one.` } });
    expect(wrapper.find('.fold').text()).toBe('5 unchanged blocks');
    expect(wrapper.find('[data-block="add"]').text()).toBe('New one.');
  });
});

describe('the Pending tab’s logic', () => {
  it('groups what it may do first, then sections, then runtime additions; and picks each change’s view', () => {
    const runtime: ContractChange = { section: 'fns', name: 'notes/auto', change: 'added', origin: 'runtime', after: {} };
    expect(changeGroups([...CHANGES, runtime]).map((group) => [group.key, group.changes.length, group.runtime])).toEqual([['grants', 1, false], ['fns', 2, false], ['context', 1, false], ['runtime', 1, true]]);
    expect(changeView({ section: 'config', name: 'notes' })).toBe('config-type');
    expect(changeView({ section: 'config', name: 'notes connect' })).toBe('raw');
    expect(changeView({ section: 'kinds', name: 'notes/saved' })).toBe('raw');
  });

  it('reads a fn’s facts before and after, marking what moved', () => {
    const rows = factRows(FACTS[1] ?? { name: 'none' }, money);
    expect(rows.filter((row) => row.changed).map((row) => [row.key, row.before, row.after])).toEqual([['deps', 'None', 'notes/tags'], ['cost', 'Not estimated', 'About $0.01 a run']]);
    expect(factRows(FACTS[0] ?? { name: 'none' }, money).every((row) => !row.changed && row.before === undefined)).toBe(true);
  });

  it('marks grant values granted, kept and gone, including whole rows that went away', () => {
    const rows = grantDeltaRows({ hub: ['ai'], secrets: ['OLD'], network: ['a.example.com'] }, { hub: ['ai'], network: ['a.example.com', 'b.example.com'] }, money);
    expect(rows.find((row) => row.key === 'network')?.values).toEqual([{ value: 'a.example.com', kind: 'same' }, { value: 'b.example.com', kind: 'add' }]);
    expect(rows.find((row) => row.key === 'secrets')?.values).toEqual([{ value: 'OLD', kind: 'remove' }]);
    expect(grantDeltaRows(undefined, { hub: ['ai'] }, money)[0]?.values).toEqual([{ value: 'Call models through the hub', kind: 'same' }]);
  });

  it('turns a type or config change into a type diff', () => {
    const def = Json.parse(g.obj({ a: g.text() }).toJSON());
    expect(typeDiffPart({ section: 'types', name: 'notes/Note', change: 'added', origin: 'contract', after: { def } })).toMatchObject({ type: 'type-diff', name: 'notes/Note', after: def });
    expect(typeDiffPart({ section: 'config', name: 'notes', change: 'removed', origin: 'contract', before: def })).toMatchObject({ name: 'notes config', before: def });
  });
});

describe('deciding one change at a time', () => {
  it('approves or declines one change by the pending hash, then reads the review again', async () => {
    const { admin, api } = fakeAdmin();
    api.systemReview = fakeCaller<'systemReview'>(() => Promise.resolve(pendingReview()));
    api.decideReview = fakeCaller<'decideReview'>(({ hash }) => Promise.resolve({ hash, waiting: 3 }));
    const store = fakeAdmin({ api }).admin.review;
    await store.open(pendingReview().system);
    const opened = api.systemReview.calls.length;
    expect(await store.decide({ section: 'fns', name: 'notes/purge' }, 'decline')).toEqual({ ok: true, value: { hash: 'hash-2', waiting: 3 } });
    expect(api.decideReview.calls[0]?.[0]).toEqual({ system: 'notes', hash: 'hash-2', approve: [], decline: [{ section: 'fns', name: 'notes/purge' }], off: [] });
    await store.decide({ section: 'grants', name: 'notes' }, 'approve');
    expect(api.decideReview.calls[1]?.[0]).toMatchObject({ approve: [{ section: 'grants', name: 'notes' }], decline: [] });
    expect(api.systemReview.calls.length).toBe(opened + 2);
    expect(store.decidingChange.value).toBeUndefined();
    expect(admin).toBeDefined();
  });

  it('says why when nothing waits', async () => {
    const { admin } = fakeAdmin();
    await admin.review.open(review().system);
    expect(await admin.review.decide({ section: 'fns', name: 'notes/find' }, 'approve')).toEqual({ ok: false, problem: 'Nothing waits for review.' });
  });
});

describe('the Pending tab', () => {
  it('opens with the hub’s summary and flags, draws each change with its tab’s view, and decides per change', async () => {
    const wrapper = mount(PendingTab, { props: { review: pendingReview(), now: 60_000 }, global: { stubs } });
    expect(wrapper.find('[data-testid="review-summary-line"]').text()).toBe(SUMMARY.line);
    expect(wrapper.findAll('[data-flag]').map((flag) => flag.attributes('data-flag'))).toEqual(['delete-fns', 'hosts']);
    expect(wrapper.find('[data-testid="review-summary-grants"]').text()).toBe('Grants widened');
    // grants first, as a delta; a fn's facts with its description as a prose diff; context as rendered blocks
    expect(wrapper.findAll('[data-group]').map((group) => group.attributes('data-group'))).toEqual(['grants', 'fns', 'context']);
    expect(wrapper.find('[data-grant="network"] [data-delta="add"]').text()).toContain('cdn.example.com');
    const find = wrapper.find('[data-change="fns:notes/find"]');
    expect(find.find('ins').text()).toBe('notes by tag.');
    expect(find.find('[data-fact="deps"]').classes()).toContain('changed');
    expect(wrapper.find('[data-change="context:notes/how"] [data-block="change"]').exists()).toBe(true);
    expect(wrapper.find('[data-change="context:notes/how"] [data-block="add"]').text()).toBe('Tag them.');

    await find.find('[data-testid="approve-change"]').trigger('click');
    await wrapper.find('[data-change="fns:notes/purge"] [data-testid="decline-change"]').trigger('click');
    expect(wrapper.emitted('approve')?.[0]?.[0]).toMatchObject({ name: 'notes/find' });
    expect(wrapper.emitted('decline')?.[0]?.[0]).toMatchObject({ name: 'notes/purge' });
    await wrapper.find('[data-testid="approve-all"]').trigger('click');
    expect(wrapper.emitted('approveAll')).toHaveLength(1);
    expect(wrapper.find('[data-testid="review-declined"] [data-testid="fn-pill"]').attributes('data-fn')).toBe('notes/sneak');
  });

  it('shows the raw diff per change on demand, and a part without a view of its own as its raw diff', async () => {
    const kind: ContractChange = { section: 'kinds', name: 'notes/saved', change: 'changed', origin: 'contract', before: { a: 1 }, after: { a: 2 } };
    const wrapper = mount(ChangeList, { props: { changes: [...CHANGES, kind], facts: FACTS }, global: { stubs } });
    expect(wrapper.find('[data-change="kinds:notes/saved"] [data-testid="review-diff"]').exists()).toBe(true);
    expect(wrapper.find('[data-change="kinds:notes/saved"] [data-testid="toggle-raw-diff"]').exists()).toBe(false);
    const find = wrapper.find('[data-change="fns:notes/find"]');
    expect(find.find('[data-testid="review-diff"]').exists()).toBe(false);
    await find.find('[data-testid="toggle-raw-diff"]').trigger('click');
    expect(wrapper.find('[data-change="fns:notes/find"] [data-testid="review-diff"]').exists()).toBe(true);
  });

  it('marks the change being decided and holds the others while a decision is under way', () => {
    const wrapper = mount(ChangeList, { props: { changes: CHANGES, facts: FACTS, deciding: 'fns:notes/find', busy: true }, global: { stubs } });
    expect(wrapper.find('[data-change="fns:notes/find"] [data-testid="approve-change"]').classes()).toContain('loading');
    expect(wrapper.find('[data-change="fns:notes/purge"] [data-testid="approve-change"]').attributes('disabled')).toBeDefined();
  });

  it('pages what was added while running', async () => {
    const runtime = Array.from({ length: RUNTIME_PAGE + 5 }, (_, at): ContractChange => ({ section: 'context', name: `notes/auto${at}`, change: 'added', origin: 'runtime', after: { description: `Auto ${at}`, content: 'x' } }));
    const wrapper = mount(ChangeList, { props: { changes: runtime }, global: { stubs } });
    expect(wrapper.findAll('[data-testid="review-change"]')).toHaveLength(RUNTIME_PAGE);
    await wrapper.find('[data-testid="more-changes"]').trigger('click');
    expect(wrapper.findAll('[data-testid="review-change"]')).toHaveLength(RUNTIME_PAGE + 5);
    expect(wrapper.find('[data-testid="more-changes"]').exists()).toBe(false);
  });

  it('draws grants as plain rows without delta, and the base-only card without grants', () => {
    expect(mount(GrantsView, { props: { grants: undefined } }).text()).toContain('No grants');
    expect(mount(GrantsView, { props: { grants: { hub: ['ai'] } } }).find('[data-delta]').exists()).toBe(false);
  });
});

describe('the install card', () => {
  it('opens with the same summary strip the Pending tab shows', () => {
    const preview = ApprovalPreview.parse({ title: 'Install notes 1.1.0 on fs/main', parts: [{ type: 'text', text: 'Notes.' }], irreversible: false, summary: SUMMARY });
    const wrapper = mount(ApprovalPreviewView, { props: { preview }, global: { stubs } });
    expect(wrapper.find('[data-testid="review-summary-line"]').text()).toBe(SUMMARY.line);
    expect(wrapper.findAll('[data-flag]')).toHaveLength(2);
    expect(mount(ApprovalPreviewView, { props: { preview: { ...preview, summary: undefined } }, global: { stubs } }).find('[data-testid="review-summary"]').exists()).toBe(false);
  });
});
