/**
 * The widgets system's client (item 9): its module registers a proposal's result renderer by fn and a saved widget's
 * by kind, and the saved widgets' page; the proposal card previews with the app's result view, saves as the person and
 * waits for that run, then links to the widgets page, says why a save failed, and asks for a change in the composer;
 * a saved widget's Settings keeps a look by running `make_widget`; and the page searches the hub by the URL's `q`, a page
 * at a time, and opens a widget in a new chat.
 */
import { client } from '@ayepi/core/client';
import { ActorId, FnSearchQuery, hubWebSpec, Json, mintId, QualifiedName, SystemName, type FnSearchHit, type FnSearchPage, type HubWebSpec, type RunId } from '@harness/core';
import { APP_COMPONENTS, CHAT_HOST, RESULT_VIEW, type ChatHost, type ChatStart, type FnPillProps, type PageHost, type ResultViewProps, type RunOutcome, type SharedComponents, type SystemClient } from '@harness/sdk';
import { ClientRuntime, type ClientBridge } from '@harness/sdk/client';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, reactive, type Component } from 'vue';
import { SAMPLE_PROPOSAL, SAMPLE_WIDGET } from '../../../packages/web/src/data/test/samples.ts';
import type { WidgetsContract } from '../shared/index.ts';
import module from './index.ts';
import ProposalCard from './ProposalCard.vue';
import { changeRequest, lookArgs, saveArgs, savedName, widgetSearch, widgetsPageHref, WIDGETS_PAGE_SIZE } from './proposal.ts';
import SavedWidget from './SavedWidget.vue';
import WidgetsPage from './WidgetsPage.vue';

/** The app's result view as a stub that shows what it was handed. */
const shown: ResultViewProps[] = [];
const ResultStub = defineComponent((props: ResultViewProps) => {
  shown.push(props);
  return () => h('div', { 'data-testid': 'result-view' }, props.title);
}, { props: ['value', 'title', 'fn', 'args', 'viewKey', 'keepLook'] });

/** Stand-ins for the app's components: enough to draw and click. */
const slot = (tag: string): Component => defineComponent({ setup(_, { slots }) { return () => h(tag, slots['default']?.()); } });
const Input: Component = defineComponent({
  props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit }) { return () => h('input', { value: props['modelValue'], onInput: (e: Event) => { if (e.target instanceof HTMLInputElement) { emit('update:modelValue', e.target.value); } } }); },
});
const components: SharedComponents = {
  Frame: slot('main'), LoadState: slot('section'), Icon: slot('i'), Badge: slot('em'), Input,
  Markdown: slot('div'), Empty: slot('div'), Reasoning: slot('div'), Typing: slot('div'), ResourceViewer: slot('div'), ValueEditor: slot('div'),
  Select: slot('div'), Textarea: slot('div'), Dialog: slot('div'), Banner: slot('div'), Skeleton: slot('div'), Approval: slot('div'), Conversation: slot('div'), Composer: slot('div'),
  Button: defineComponent({ props: ['disabled', 'loading', 'icon', 'size', 'variant'], emits: ['click'], setup(props, { slots, emit }) { return () => h('button', { disabled: props['disabled'] === true, onClick: () => { emit('click'); } }, slots['default']?.()); } }),
  FnPill: defineComponent((props: FnPillProps) => () => h('span', { class: 'pill', 'data-off': String(props.off) }, props.name), { props: ['name', 'off'] }),
};

/** The widgets system's client, recording each run it starts. */
function fakeSystem(): { system: SystemClient<WidgetsContract['defs']>; runs: Array<{ fn: string; args: unknown }> } {
  const runs: Array<{ fn: string; args: unknown }> = [];
  const start = (fn: string) => (args: unknown): Promise<RunId> => { runs.push({ fn, args }); return Promise.resolve(mintId('run')); };
  return { system: { online: true, send: {}, run: { make_widget: start('make_widget'), save_widget: start('save_widget') } }, runs };
}

/** A chat host whose runs end with `outcome`, recording what it asked and where it went. */
function fakeChat(outcome: RunOutcome): ChatHost & { asked: Array<[string, boolean]>; paths: string[] } {
  const asked: Array<[string, boolean]> = [];
  const paths: string[] = [];
  return { asked, paths, ask: (text, send) => { asked.push([text, send]); return Promise.resolve(true); }, settled: () => Promise.resolve(outcome), navigate: (path) => { paths.push(path); } };
}

function proposalCard(chat: ChatHost | undefined, result = SAMPLE_PROPOSAL) {
  const fake = fakeSystem();
  const provide: Record<symbol, unknown> = { [RESULT_VIEW]: ResultStub, [APP_COMPONENTS]: components };
  if (chat !== undefined) { provide[CHAT_HOST] = chat; }
  const wrapper = mount(ProposalCard, {
    props: { run: mintId('run'), fn: QualifiedName.parse('widgets/make_widget'), title: 'Make widget', args: { source: 'hub/records_table', request: 'Notes', show: true }, result, system: fake.system },
    global: { provide },
  });
  return { wrapper, runs: fake.runs };
}

describe('the widgets client: its words and args', () => {
  it('saves a proposal as save_widget takes it, under its name or over the widget it changes', () => {
    expect(saveArgs(SAMPLE_PROPOSAL)).toEqual({ name: 'open_notes', description: SAMPLE_PROPOSAL.description, spec: SAMPLE_PROPOSAL.spec });
    expect(savedName(SAMPLE_PROPOSAL)).toBe('widgets/open_notes');
    const change = { ...SAMPLE_PROPOSAL, replaces: QualifiedName.parse('widgets/old_notes') };
    expect(saveArgs(change)).toMatchObject({ replace: 'widgets/old_notes' });
    expect(savedName(change)).toBe('widgets/old_notes');
    expect(changeRequest(SAMPLE_PROPOSAL)).toBe('Change the proposed widget “Open notes” (from hub/records_table): ');
  });

  it('keeps a look by proposing the widget again over its own source, and searches and links the saved widgets', () => {
    expect(lookArgs(QualifiedName.parse('widgets/open_notes'), SAMPLE_WIDGET, { visual: 'Words per note', style: 'Bars' })).toEqual({
      source: SAMPLE_WIDGET.source.fn, request: 'Open it as Words per note (Bars) first, keeping its other visuals and everything else.', widget: 'widgets/open_notes', show: true,
    });
    expect(widgetSearch('  trips ', 50)).toEqual({ kinds: ['widgets/widget'], items: ['fn'], limit: WIDGETS_PAGE_SIZE, offset: 50, text: 'trips' });
    expect(widgetSearch('', 0)).not.toHaveProperty('text');
    expect(widgetsPageHref()).toBe('/s/widgets/saved');
    expect(widgetsPageHref(QualifiedName.parse('widgets/open_notes'))).toBe('/s/widgets/saved?q=widgets%2Fopen_notes');
  });
});

describe('the widgets client module', () => {
  const bridge: ClientBridge = {
    online: () => true, act: () => Promise.resolve(mintId('delivery')), submit: () => Promise.resolve(mintId('delivery')),
    invoke: () => Promise.resolve(mintId('run')), follow: () => Promise.resolve(true),
  };

  it('draws a proposal by its fn and a saved widget by its kind, and declares the saved widgets\' page', () => {
    const runtime = new ClientRuntime(bridge);
    runtime.register(module);
    const proposal = runtime.resultView({ fn: QualifiedName.parse('widgets/make_widget'), kind: undefined, run: mintId('run'), args: { source: 'hub/records_table', request: 'Notes', show: true }, result: Json.parse(SAMPLE_PROPOSAL), title: 'Make widget' });
    expect(proposal?.component).toBe(ProposalCard);
    expect(proposal?.props.result).toMatchObject({ name: 'open_notes', show: true });
    const saved = runtime.resultView({ fn: QualifiedName.parse('widgets/open_notes'), kind: QualifiedName.parse('widgets/widget'), run: mintId('run'), args: {}, result: Json.parse(SAMPLE_WIDGET), title: 'Open notes' });
    expect(saved?.component).toBe(SavedWidget);
    expect(runtime.resultView({ fn: QualifiedName.parse('widgets/save_widget'), kind: undefined, run: mintId('run'), args: {}, result: {}, title: 'Save widget' })).toBeUndefined();
    expect(runtime.pages('widgets').map((page) => [page.segment, page.title, page.nav, page.access])).toEqual([['saved', 'Widgets', 'main', 'everyone']]);
  });
});

describe('the proposal card', () => {
  it('previews with the app\'s result view, saves as the person, waits for the run and links to the saved widget', async () => {
    shown.length = 0;
    const chat = fakeChat({ ok: true, output: { fn: 'widgets/open_notes', version: 1, created: true } });
    const { wrapper, runs } = proposalCard(chat);
    expect(wrapper.get('h3').text()).toBe('Open notes');
    expect(shown.at(-1)).toMatchObject({ title: 'Open notes', value: { title: SAMPLE_WIDGET.title } });
    expect(shown.at(-1)?.fn).toBeUndefined();
    await wrapper.get('[data-testid=widget-proposal-save]').trigger('click');
    await flushPromises();
    expect(runs).toEqual([{ fn: 'save_widget', args: saveArgs(SAMPLE_PROPOSAL) }]);
    const link = wrapper.get('[data-testid=widget-proposal-saved]');
    expect(link.text()).toBe('Saved as widgets/open_notes');
    expect(link.attributes('href')).toBe('/s/widgets/saved?q=widgets%2Fopen_notes');
    expect(wrapper.find('[data-testid=widget-proposal-save]').exists()).toBe(false);
    await link.trigger('click');
    expect(chat.paths).toEqual(['/s/widgets/saved?q=widgets%2Fopen_notes']);
  });

  it('says why a save failed and keeps Save, and Change puts a request in the composer', async () => {
    const chat = fakeChat({ ok: false, problem: 'Declined by Ana: not today' });
    const { wrapper } = proposalCard(chat);
    await wrapper.get('[data-testid=widget-proposal-save]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toBe('Declined by Ana: not today');
    expect(wrapper.find('[data-testid=widget-proposal-save]').exists()).toBe(true);
    await wrapper.get('[data-testid=widget-proposal-change]').trigger('click');
    expect(chat.asked).toEqual([[changeRequest(SAMPLE_PROPOSAL), false]]);
  });

  it('opens collapsed unless the person asked to see it, and offers no Save outside a chat', async () => {
    const { wrapper } = proposalCard(undefined, { ...SAMPLE_PROPOSAL, show: false, replaces: QualifiedName.parse('widgets/old_notes') });
    expect(wrapper.find('[data-testid=result-view]').exists()).toBe(false);
    expect(wrapper.get('[data-testid=widget-proposal-replaces]').text()).toBe('changes widgets/old_notes');
    expect(wrapper.find('[data-testid=widget-proposal-save]').exists()).toBe(false);
    expect(wrapper.find('[data-testid=widget-proposal-change]').exists()).toBe(false);
    await wrapper.get('[data-testid=widget-proposal-show]').trigger('click');
    expect(wrapper.find('[data-testid=result-view]').exists()).toBe(true);
  });
});

describe('a saved widget\'s result', () => {
  it('draws with the app\'s result view, reading its fn again, and keeps a look by running make_widget', async () => {
    shown.length = 0;
    const fake = fakeSystem();
    const fn = QualifiedName.parse('widgets/open_notes');
    mount(SavedWidget, { props: { run: mintId('run'), fn, title: 'Open notes', args: { status: 'open' }, result: Json.parse(SAMPLE_WIDGET), system: fake.system }, global: { provide: { [RESULT_VIEW]: ResultStub } } });
    const props = shown.at(-1);
    expect(props).toMatchObject({ fn, args: { status: 'open' }, title: 'Open notes' });
    expect(await props?.keepLook?.({ visual: 'Words per note', style: 'Bars' })).toBe(true);
    expect(fake.runs).toEqual([{ fn: 'make_widget', args: lookArgs(fn, SAMPLE_WIDGET, { visual: 'Words per note', style: 'Bars' }) }]);
    // a result that isn't a widget's offers no look to keep
    mount(SavedWidget, { props: { run: mintId('run'), fn, title: 'Open notes', args: {}, result: 'not a widget', system: fake.system }, global: { provide: { [RESULT_VIEW]: ResultStub } } });
    expect(shown.at(-1)?.keepLook).toBeUndefined();
  });
});

describe('the saved widgets\' page', () => {
  const hit = (name: string, available = true): FnSearchHit => ({
    item: 'fn', name: QualifiedName.parse(name), system: SystemName.parse('widgets'), description: `${name} shown`, available,
    ...(available ? {} : { blocked: { code: 'disabled' as const, reason: 'Its source is switched off.' } }),
  });


  function page(pages: FnSearchPage[]) {
    const query = reactive<Record<string, string>>({ q: 'notes' });
    const asked: FnSearchQuery[] = [];
    const chats: ChatStart[] = [];
    // the hub as a real web client: its searchFns answered a page at a time, each body checked against the hub's spec
    const hub = client<HubWebSpec>({
      baseUrl: 'http://hub.test/api', manifest: hubWebSpec,
      fetchImpl: async (request) => {
        asked.push(FnSearchQuery.parse(JSON.parse(await request.text())));
        return Response.json(pages[asked.length - 1] ?? { items: [] });
      },
    });
    const host: PageHost = {
      user: { id: ActorId.parse('act_ada'), kind: 'user', name: 'Ada', email: 'ada@example.test', role: 'member' },
      hub,
      query: {
        get values() { return query; }, get: (key: string) => query[key], set: () => undefined,
        bind: (key: string) => ({ get value() { return query[key] ?? ''; }, set value(next: string) { query[key] = next; } }),
      },
      href: () => '', go: () => undefined, components, chatHref: (session) => `/c/${session}`, goChat: () => undefined,
      openChat: (start: ChatStart) => { chats.push(start); return Promise.resolve(); },
      runs: () => { throw new Error('the widgets page starts no runs of its own'); },
      inbox: { byRun: () => undefined, load: () => Promise.resolve(), decide: () => Promise.resolve(false), problem: '' },
      notify: { ok: () => undefined, error: () => undefined },
      format: { cost: (usd) => `$${usd}`, relativeTime: () => 'now', fullTime: () => '' },
      live: () => undefined,
    };
    const wrapper = mount(WidgetsPage, { props: { page: 'saved', path: [], host, system: fakeSystem().system } });
    return { wrapper, asked, chats, query };
  }

  it('searches the hub by the URL\'s words a page at a time, and searches again when they change', async () => {
    const { wrapper, asked, query } = page([
      { items: [hit('widgets/open_notes'), hit('widgets/old', false)], next: 2 },
      { items: [hit('widgets/more_notes')] },
      { items: [] },
    ]);
    await flushPromises();
    expect(asked[0]).toEqual(widgetSearch('notes', 0));
    expect(wrapper.findAll('[data-testid=widget-row]').map((row) => row.attributes('data-widget'))).toEqual(['widgets/open_notes', 'widgets/old']);
    expect(wrapper.text()).toContain('Its source is switched off.');
    expect(wrapper.findAll('[data-testid=widget-open]').map((b) => b.attributes('disabled'))).toEqual([undefined, '']);
    await wrapper.get('[data-testid=widgets-more]').trigger('click');
    await flushPromises();
    expect(asked[1]).toEqual(widgetSearch('notes', 2));
    expect(wrapper.findAll('[data-testid=widget-row]')).toHaveLength(3);
    expect(wrapper.find('[data-testid=widgets-more]').exists()).toBe(false);
    query['q'] = 'trips';
    await flushPromises();
    expect(asked[2]).toEqual(widgetSearch('trips', 0));
  });

  it('opens a widget in a new chat that runs it', async () => {
    const { wrapper, chats } = page([{ items: [hit('widgets/open_notes')] }]);
    await flushPromises();
    await wrapper.get('[data-testid=widget-open]').trigger('click');
    await flushPromises();
    expect(chats).toEqual([{ title: 'Open notes', run: { fn: 'widgets/open_notes', args: {} } }]);
  });
});
