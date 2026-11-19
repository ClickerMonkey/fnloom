import { ApiError } from '@ayepi/core/client';
import { ApprovalId, MessageId, SessionId, SystemName, TurnId, type ChatMessage, type CompareVariantView } from '@harness/core';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, type Router } from 'vue-router';
import { createAppRouter } from '../app/router.ts';
import { failingCaller } from '../test/fakes.ts';
import { fakeStores } from '../test/fakes.ts';
import {
  addDraft, answerBlocks, choosable, removeDraft, repeatedDraft, setSetting, setSystem, settingsWords, variantSystems, startingDrafts, variantIndex, variantInputs, variantParam, variantStats, variantStatus,
} from './logic/compare.ts';
import { CompareStore, sendCompare } from './state/compare.ts';
import { compareView, fakeChat, fakeChatApi, fakeSessionEvents, message, session } from './test/fakes.ts';
import { useChatUrl } from './url.ts';
import SessionSettings from './components/SessionSettings.vue';
import VariantSettings from './components/VariantSettings.vue';

const S1 = SessionId.parse('ses_1');
const TURN = TurnId.parse('trn_cmp');
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) { await Promise.resolve(); } };

describe('setting up variants', () => {
  it('starts with two, adds a copy of the last up to four, and never goes below two', () => {
    let drafts = startingDrafts();
    expect(drafts).toHaveLength(2);
    drafts = [drafts[0] ?? { label: '', settings: {} }, setSetting(drafts[1] ?? { label: '', settings: {} }, 'fnMode', 'read')];
    drafts = addDraft(drafts);
    expect(drafts[2]?.settings).toEqual({ fnMode: 'read' });
    drafts = addDraft(addDraft(drafts));
    expect(drafts).toHaveLength(4);
    expect(removeDraft(removeDraft(removeDraft(drafts, 3), 2), 1)).toHaveLength(2);
  });

  it('sets a setting, puts it back to the chat\'s with undefined, and sends names only when given', () => {
    const draft = setSetting(setSetting({ label: ' Fast ', settings: {} }, 'model', { model: 'm1' }), 'instructions', 'Be brief.');
    expect(draft.settings).toEqual({ model: { model: 'm1' }, instructions: 'Be brief.' });
    expect(setSetting(draft, 'model', undefined).settings).toEqual({ instructions: 'Be brief.' });
    expect(variantInputs([draft, { label: '', settings: {} }])).toEqual([{ label: 'Fast', settings: draft.settings }, { settings: {} }]);
  });

  it('finds two variants that change the same things, whatever the order', () => {
    expect(repeatedDraft(startingDrafts())).toBe(1);
    const a = { label: '', settings: { fnMode: 'read' as const, instructions: 'x' } };
    const b = { label: 'other', settings: { instructions: 'x', fnMode: 'read' as const } };
    expect(repeatedDraft([{ label: '', settings: {} }, a, b])).toBe(2);
    expect(repeatedDraft([{ label: '', settings: {} }, a])).toBeUndefined();
  });

  it('turns a variant\'s systems on and off, back to the chat\'s when they match it again', () => {
    const fs = SystemName.parse('fs');
    const db = SystemName.parse('db');
    const names = [fs, db];
    const chat = { systems: 'all' as const };
    const none = { label: '', settings: {} };
    expect([...variantSystems(none, chat, names)]).toEqual([fs, db]);
    const off = setSystem(none, chat, names, db, false);
    expect(off.settings).toEqual({ systems: [fs] });
    expect([...variantSystems(off, chat, names)]).toEqual([fs]);
    // on again: every system is the chat's 'all', so the variant takes the chat's
    expect(setSystem(off, chat, names, db, true).settings).toEqual({});
    // a chat with some systems: matching them in another order is still the chat's
    expect(setSystem({ label: '', settings: { systems: [db] } }, { systems: [db, fs] }, names, fs, true).settings).toEqual({});
    expect(setSystem(none, { systems: [fs] }, names, db, true).settings).toEqual({ systems: 'all' });
  });

  it('says what a variant changes in words', () => {
    const models = [{ id: 'm1', provider: 'openrouter' as const, name: 'Model One', contextWindow: 1, pricing: { input: 0, output: 0 }, capabilities: ['chat'] }];
    expect(settingsWords({ model: { model: 'm1' }, fnMode: 'read', instructions: 'x', systems: [SystemName.parse('fs')] }, models)).toEqual(['Model One', expect.any(String), '1 system', 'Own prompt']);
    expect(settingsWords({}, models)).toEqual([]);
  });
});

describe('a compare in the URL', () => {
  async function probe(path: string): Promise<{ router: Router; got: ReturnType<typeof useChatUrl> }> {
    const fakes = fakeStores({ signedIn: true });
    const router = createAppRouter(fakes.stores.session, createMemoryHistory());
    await router.push(path);
    let got: ReturnType<typeof useChatUrl> | undefined;
    mount(defineComponent({ setup() { got = useChatUrl(); return () => h('div'); } }), { global: { plugins: [router] } });
    if (got === undefined) { throw new Error('the probe did not run'); }
    return { router, got };
  }

  it('opens a compared turn at a variant, switches variants in place, and closes back', async () => {
    const { router, got } = await probe(`/chat/${S1}?q=x`);
    got.openCompare(TURN, variantParam(1));
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ q: 'x', compare: TURN, v: '2' });
    expect([got.compare.value, got.variant.value]).toEqual([TURN, '2']);
    got.showVariant('1');
    await flushPromises();
    expect(router.currentRoute.value.query['v']).toBe('1');
    got.closeCompare();
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ q: 'x' });
    expect(got.compare.value).toBeUndefined();
  });

  it('reads a bad compare or variant as nothing open', async () => {
    const { got } = await probe(`/chat/${S1}?compare=nope&v=9`);
    expect([got.compare.value, got.variant.value]).toEqual([undefined, undefined]);
    expect(variantIndex('3')).toBe(2);
  });
});

describe('sending a compare', () => {
  it('empties the box, sends the draft with its variants, and puts it all back when the hub refuses', async () => {
    const chat = fakeChat();
    const t = chat.chat.thread(S1);
    await t.open();
    const composer = chat.chat.composer(S1);
    composer.input('Which is best?', 14);
    const variants = variantInputs([{ label: '', settings: {} }, { label: 'Read only', settings: { fnMode: 'read' } }]);
    chat.api.compare = failingCaller<'compare'>(new ApiError(409, 'nope', undefined));
    const failed = await sendCompare(chat.api, t, composer, variants, { timeZone: 'UTC', locale: 'en', now: 0 });
    expect(failed.ok).toBe(false);
    expect(composer.text.value).toBe('Which is best?');
    chat.api.compare = fakeChatApi().compare;
    const sent = await chat.chat.startCompare(S1, variants);
    expect(sent).toEqual({ ok: true, value: TURN });
    expect(chat.api.compare.calls[0]?.[0]).toMatchObject({ session: S1, variants, parts: [{ type: 'text', text: 'Which is best?' }] });
    expect(composer.text.value).toBe('');
    expect(t.messages.value.at(-1)).toMatchObject({ compared: true, turn: TURN });
  });
});

describe('following a compare', () => {
  function store() {
    const api = fakeChatApi();
    const channel = fakeSessionEvents();
    const compare = new CompareStore({ api, events: channel.subscribe, later: (run) => { run(); return () => undefined; } }, S1, TURN);
    return { api, channel, compare };
  }

  it('reads the compare and follows the chat and every fork, streaming answers and reading again on changes', async () => {
    const { api, channel, compare } = store();
    await compare.open();
    expect(compare.view.value.value?.variants).toHaveLength(2);
    expect([channel.listeners(S1), channel.listeners(SessionId.parse('ses_fork0')), channel.listeners(SessionId.parse('ses_fork1'))]).toEqual([1, 1, 1]);
    const msg = MessageId.parse('msg_a');
    channel.push(SessionId.parse('ses_fork0'), { type: 'token', message: msg, text: 'Hel' });
    channel.push(SessionId.parse('ses_fork0'), { type: 'token', message: msg, text: 'lo' });
    channel.push(SessionId.parse('ses_fork0'), { type: 'reasoning', message: msg, text: 'hmm' });
    expect(compare.streamed.value.get(msg)).toEqual({ text: 'Hello', reasoning: 'hmm' });
    // the chat's own tokens are not a variant's
    channel.push(S1, { type: 'token', message: msg, text: '!' });
    expect(compare.streamed.value.get(msg)?.text).toBe('Hello');
    channel.push(S1, { type: 'compare', turn: TURN });
    await flush();
    expect(api.compareView.calls).toHaveLength(2);
    expect(compare.streamed.value.size).toBe(0);
    channel.push(S1, { type: 'compare', turn: TurnId.parse('trn_other') });
    await flush();
    expect(api.compareView.calls).toHaveLength(2);
    compare.close();
    expect(channel.listeners(S1)).toBe(0);
  });

  it('chooses a variant with or without its settings, and answers a variant\'s approval', async () => {
    const { api, compare } = store();
    await compare.open();
    const chosen = await compare.choose(1, true);
    expect(chosen.ok).toBe(true);
    expect(api.chooseVariant.calls[0]?.[0]).toEqual({ turn: TURN, variant: 1, adopt: true });
    expect(compare.view.value.value?.chosen).toBe(1);
    expect(await compare.decide(ApprovalId.parse('apr_1'), true, 'once', '', undefined)).toBe(true);
    expect(api.approve.calls[0]?.[0]).toEqual({ approval: 'apr_1', approve: true, remember: 'once' });
  });
});

describe('a variant as its column shows it', () => {
  const variant = (overrides: Partial<CompareVariantView> = {}): CompareVariantView => {
    const [first] = compareView().variants;
    if (first === undefined) { throw new Error('the view has no variants'); }
    return { ...first, ...overrides };
  };

  it('reads its answer in the model\'s order, joining pieces and adding what streamed', () => {
    const answer: ChatMessage = message({
      id: 'msg_a', role: 'assistant', status: 'streaming',
      parts: [{ type: 'reasoning', text: 'Think' }, { type: 'text', text: 'Let me ' }, { type: 'text', text: 'look.' }, { type: 'call', run: 'run_1', fn: 'fs/read' }, { type: 'text', text: 'Found' }],
    });
    expect(answerBlocks([answer], new Map([[answer.id, { text: ' it.', reasoning: '' }]]))).toEqual([
      { kind: 'reasoning', text: 'Think' }, { kind: 'text', text: 'Let me look.' }, { kind: 'call', fn: 'fs/read', run: 'run_1' }, { kind: 'text', text: 'Found it.' },
    ]);
  });

  it('shows how it stands, what it spent of its share, and whether it can be chosen', () => {
    expect(variantStatus(variant(), undefined, 0)).toMatchObject({ label: 'Answering', live: true });
    expect(variantStatus(variant({ status: 'done' }), 0, 0).label).toBe('Chosen');
    expect(variantStatus(variant({ status: 'done' }), 1, 0).label).toBe('Discarded');
    expect(variantStats(variant({ spent: 0.2 }), 0.25)).toMatchObject({ share: 0.8, tokens: '120 tokens' });
    expect(choosable({ chosen: undefined }, variant())).toBe(false);
    expect(choosable({ chosen: undefined }, variant({ status: 'failed' }))).toBe(true);
    expect(choosable({ chosen: 0 }, variant({ status: 'done' }))).toBe(false);
  });
});

describe('the settings a compare varies, in the components', () => {
  const systems = [{ name: SystemName.parse('fs'), status: 'connected' as const, enabled: true }, { name: SystemName.parse('db'), status: 'connected' as const, enabled: true }];

  it('VariantSettings switches a system off for the variant only', async () => {
    const wrapper = mount(VariantSettings, {
      props: { index: 1, draft: { label: '', settings: {} }, session: session(), models: [], agents: [], systems, removable: false, repeated: false },
    });
    await wrapper.get('[data-testid=variant-system-1-db] button').trigger('click');
    expect(wrapper.emitted('update')?.[0]).toEqual([{ label: '', settings: { systems: ['fs'] } }]);
  });

  it('SessionSettings saves the chat\'s own system prompt and can go back to the agent\'s', async () => {
    const props = { session: session(), systems: [], notify: 'all' as const, agent: 'Chat', nameOf: () => 'Ada' };
    const wrapper = mount(SessionSettings, { props });
    expect(wrapper.find('[data-testid=session-instructions-save]').exists()).toBe(false);
    await wrapper.get('[data-testid=session-instructions] textarea').setValue('Answer like a pirate.');
    await wrapper.get('[data-testid=session-instructions-save]').trigger('click');
    expect(wrapper.emitted('instructions')?.[0]).toEqual(['Answer like a pirate.']);
    await wrapper.setProps({ session: session({ instructions: 'Answer like a pirate.' }) });
    expect(wrapper.find('[data-testid=session-instructions-save]').exists()).toBe(false);
    await wrapper.get('[data-testid=session-instructions-clear]').trigger('click');
    expect(wrapper.emitted('instructions')?.[1]).toEqual([null]);
  });
});
