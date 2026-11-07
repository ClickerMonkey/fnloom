import { ApiError } from '@ayepi/core/client';
import { ActorId, DeliveryId, MessageId, ResourceUri, RunId, SessionId, SystemName, TurnId, type ChatCapabilities } from '@harness/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { failingCaller, fakeCaller, memoryStore } from '../../test/fakes.ts';
import {
  approval, capabilities, fakeChat, fakeChatApi, fakePreviews, fakeRecorder, fakeSender, fakeSessionEvents, handlerCall, message, session, summary, T0, tree,
} from '../test/fakes.ts';
import { CapabilitiesStore } from './capabilities.ts';
import { COLLAPSE_KEEP, CollapseStore } from './collapse.ts';
import { ComposerStore, draftKey } from './composer.ts';
import { Inspector } from './inspect.ts';
import { MentionCards } from './mentions.ts';
import { RendererHub } from './renderers.ts';
import { sendDraft } from './send.ts';
import { SessionListStore } from './sessions.ts';
import { DraftSuggestions } from './suggest.ts';
import { ThreadStore, undoSummary } from './thread.ts';
import { UploadQueue } from './uploads.ts';
import { VoiceStore } from './voice.ts';

const S1 = SessionId.parse('ses_1');
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) { await Promise.resolve(); } };

function events() {
  const listeners = new Set<(event: Parameters<ReturnType<typeof fakeChat>['pushUser']>[0]) => void>();
  return {
    subscribe: (listener: (event: Parameters<ReturnType<typeof fakeChat>['pushUser']>[0]) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push: (event: Parameters<ReturnType<typeof fakeChat>['pushUser']>[0]) => { for (const l of listeners) { l(event); } },
  };
}

function thread(api = fakeChatApi()) {
  const channel = fakeSessionEvents();
  const changed = vi.fn();
  const store = new ThreadStore(S1, {
    api, events: channel.subscribe, clock: () => T0, client: () => ({ timeZone: 'UTC', locale: 'en', now: T0 }), me: () => session().owner, changed,
  }, { page: 2, runsOnOpen: 10, typingFor: 1_000, presenceEvery: 3_000 });
  return { store, api, channel, changed, push: (event: Parameters<typeof channel.push>[1]) => { channel.push(S1, event); } };
}

afterEach(() => { vi.useRealTimers(); });

describe('SessionListStore', () => {
  it('loads, searches once typing pauses, and keeps rows live from the user channel', async () => {
    vi.useFakeTimers();
    const api = fakeChatApi();
    api.sessions = fakeCaller<'sessions'>((body) => Promise.resolve({ items: body?.search === 'zzz' ? [] : [summary({ id: 'ses_a', updatedAt: T0 }), summary({ id: 'ses_b', updatedAt: T0 - 1 })], cursor: 'next' }));
    const channel = events();
    const list = new SessionListStore(api, channel.subscribe, 100);
    list.start();
    await list.load();
    expect(list.items.value.map((s) => s.id)).toEqual(['ses_a', 'ses_b']);
    expect(list.hasMore.value).toBe(true);

    channel.push({ type: 'session', session: summary({ id: 'ses_b', updatedAt: T0 + 5, status: 'running' }) });
    expect(list.items.value.map((s) => [s.id, s.status])).toEqual([['ses_b', 'running'], ['ses_a', 'idle']]);

    list.setSearch('zz');
    list.setSearch('zzz');
    await vi.advanceTimersByTimeAsync(100);
    expect(api.sessions.calls.at(-1)?.[0]).toMatchObject({ search: 'zzz', archived: false });
    expect(list.items.value).toEqual([]);
    list.stop();
  });

  it('renames at once and puts it back if the hub refuses; archiving leaves the list', async () => {
    const api = fakeChatApi();
    api.sessions = fakeCaller<'sessions'>(() => Promise.resolve({ items: [summary({ id: 'ses_1', title: 'Old' })] }));
    const list = new SessionListStore(api, events().subscribe);
    await list.load();
    api.updateSession = failingCaller<'updateSession'>(new ApiError(500, 'boom', undefined));
    expect(await list.rename(S1, 'New')).toBe(false);
    expect(list.items.value[0]?.title).toBe('Old');
    expect(list.problem.value).not.toBe('');
    api.updateSession = fakeCaller<'updateSession'>(({ session: id, archived }) => Promise.resolve(session({ id, archived })));
    expect(await list.archive(S1, true)).toBe(true);
    expect(list.items.value).toEqual([]);
    const made = await list.create();
    expect(made?.id).toBe('ses_new');
    expect(list.items.value[0]?.id).toBe('ses_new');
  });
});

describe('CapabilitiesStore', () => {
  it('reads again when the hub says they changed, and follows system status', async () => {
    const api = fakeChatApi();
    const channel = events();
    const caps = new CapabilitiesStore(api, channel.subscribe);
    caps.start();
    await caps.load(S1);
    expect(caps.can.value).toEqual({ mention: true, command: true, invoke: true, upload: true, voice: true });
    expect(caps.online('fs')).toBe(true);
    channel.push({ type: 'system', system: SystemName.parse('fs'), status: 'disconnected' });
    expect(caps.online('fs')).toBe(false);
    api.capabilities = fakeCaller<'capabilities'>(() => Promise.resolve(capabilities({ mentions: [] })));
    channel.push({ type: 'capabilities' });
    await flush();
    expect(caps.can.value.mention).toBe(false);
    expect(caps.commandFor('fs/tree')?.name).toBe('tree');
    expect(caps.invocation('fs/edit')?.description).toBe('Edit a file');
  });
});

describe('ThreadStore', () => {
  it('opens: the record, the latest page oldest first, and the runs those messages made', async () => {
    const t = thread();
    const older = message({ runs: ['run_a'] });
    const newer = message({ role: 'assistant', author: 'act_agent' });
    t.api.messages = fakeCaller<'messages'>(() => Promise.resolve({ items: [newer, older], cursor: 'c1' }));
    await t.store.open();
    await flush();
    expect(t.store.status.value).toBe('ready');
    expect(t.store.messages.value.map((m) => m.id)).toEqual([older.id, newer.id]);
    expect(t.store.hasOlder.value).toBe(true);
    expect(t.store.runs.value.get(RunId.parse('run_a'))?.args).toEqual({ path: 'docs/harness.md' });
    expect(t.changed).toHaveBeenCalled();
    expect(t.channel.listeners(S1)).toBe(1);
    t.store.close();
    expect(t.channel.listeners(S1)).toBe(0);
  });

  it('streams tokens, including ones that arrive before their message', async () => {
    const t = thread();
    await t.store.open();
    const id = MessageId.parse('msg_stream');
    t.push({ type: 'token', message: id, text: 'Hel' });
    t.push({ type: 'message', message: message({ id, role: 'assistant', author: 'act_agent', status: 'streaming', parts: [] }) });
    t.push({ type: 'token', message: id, text: 'lo' });
    t.push({ type: 'reasoning', message: id, text: 'thinking' });
    expect(t.store.messages.value.at(-1)?.parts).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(t.store.reasoning.value.get(id)).toBe('thinking');
    t.push({ type: 'message', message: message({ id, role: 'assistant', author: 'act_agent', status: 'done', parts: [{ type: 'text', text: 'Hello!' }] }) });
    expect(t.store.messages.value.at(-1)?.parts).toEqual([{ type: 'text', text: 'Hello!' }]);
  });

  it('follows runs, approvals, handler calls, presence, controls and session state', async () => {
    vi.useFakeTimers();
    const t = thread();
    await t.store.open();
    t.push({ type: 'run', run: RunId.parse('run_live'), fn: 'fs/read_file', update: { type: 'status', status: 'running' } });
    t.push({ type: 'run', run: RunId.parse('run_live'), fn: 'fs/read_file', update: { type: 'cost', cost: 0.02, total: 0.02 } });
    expect(t.store.runs.value.get(RunId.parse('run_live'))?.status).toBe('running');
    expect(t.store.spent.value).toBeCloseTo(0.02);

    const waiting = approval();
    t.push({ type: 'approval', approval: waiting });
    expect(t.store.approvals.value).toHaveLength(1);
    t.push({ type: 'approval', approval: { ...waiting, status: 'approved' } });
    expect(t.store.approvals.value).toHaveLength(0);

    t.push({ type: 'handler', call: handlerCall() });
    t.push({ type: 'handler', call: handlerCall({ answerer: { system: 'fs', run: 'run_1' } }) });
    expect(t.store.handlers.value).toHaveLength(1);

    t.push({ type: 'presence', presence: { session: S1, user: ActorId.parse('act_bea'), focused: true, typing: true, lastActiveAt: T0 } });
    expect(t.store.typing.value).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.store.typing.value).toHaveLength(0);

    t.push({ type: 'controls', controls: { pause: true, cancel: true, uncancellable: [], undoLastTurn: false } });
    expect(t.store.canUndo.value).toBe(false);
    t.push({ type: 'state', system: SystemName.parse('fs'), fields: [{ name: 'cwd', type: 'h', value: '/src' }] });
    expect(t.store.state.value.get('fs/cwd')).toBe('/src');
    t.push({ type: 'session', session: summary({ id: 'ses_1', status: 'running' }) });
    expect(t.store.running.value).toBe(true);
  });

  it('sends once while a send is in flight, and says why when it fails', async () => {
    const t = thread();
    await t.store.open();
    const parts = [{ type: 'text' as const, text: 'hi' }];
    const [first, second] = await Promise.all([t.store.send({ parts }), t.store.send({ parts })]);
    expect([first, second]).toEqual([true, false]);
    expect(t.api.send.calls).toHaveLength(1);
    expect(t.store.awaiting.value).toBeDefined();
    t.api.send = failingCaller<'send'>(new ApiError(500, 'down', undefined));
    expect(await t.store.send({ parts })).toBe(false);
    expect(t.store.problem.value).toContain('hub');
  });

  it('retries an answer, and edits by undoing every later turn first', async () => {
    const t = thread();
    const q1 = message({ turn: 'trn_q1', parts: [{ type: 'text', text: 'first' }] });
    const a1 = message({ turn: 'trn_q1', role: 'assistant', author: 'act_agent' });
    const q2 = message({ turn: 'trn_q2', parts: [{ type: 'text', text: 'second' }] });
    const a2 = message({ turn: 'trn_q2', role: 'assistant', author: 'act_agent' });
    t.api.messages = fakeCaller<'messages'>(() => Promise.resolve({ items: [a2, q2, a1, q1] }));
    await t.store.open();
    expect(t.store.turnsFrom(q1.id)).toEqual(['trn_q2', 'trn_q1']);
    expect(await t.store.retry(TurnId.parse('trn_q2'))).toBe(true);
    expect(t.api.undoTurn.calls.at(-1)?.[0]).toEqual({ turn: 'trn_q2' });
    expect(t.api.send.calls.at(-1)?.[0].parts).toEqual([{ type: 'text', text: 'second' }]);
    const summaryOfEdit = await t.store.editResend(q1.id, [{ type: 'text', text: 'first, edited' }]);
    // the retried turn's new message is newest, so the edit undoes it too, newest first
    expect(summaryOfEdit?.reports.map((r) => r.turn).slice(-2)).toEqual(['trn_q2', 'trn_q1']);
    expect(summaryOfEdit?.reports).toHaveLength(3);
    expect(t.api.send.calls.at(-1)?.[0].parts).toEqual([{ type: 'text', text: 'first, edited' }]);
    expect(undoSummary([]).undone).toBe(0);
  });

  it('approves at once, putting it back if the hub refuses; follows deliveries to their result', async () => {
    const t = thread();
    await t.store.open();
    const waiting = approval();
    t.push({ type: 'approval', approval: waiting });
    expect(await t.store.approve(waiting.id, true, 'session')).toBe(true);
    expect(t.api.approve.calls[0]?.[0]).toEqual({ approval: waiting.id, approve: true, remember: 'session' });
    t.push({ type: 'approval', approval: waiting });
    t.api.approve = failingCaller<'approve'>(new Error('no'));
    expect(await t.store.approve(waiting.id, false, 'once', 'not now')).toBe(false);
    expect(t.store.approvals.value).toHaveLength(1);

    const delivery = DeliveryId.parse('dlv_1');
    const seen: string[] = [];
    const result = t.store.follow(delivery, (status) => { seen.push(status); });
    t.push({ type: 'delivery', delivery: { id: delivery, status: 'delivered' } });
    t.push({ type: 'delivery', delivery: { id: delivery, status: 'done', result: { ok: true } } });
    await expect(result).resolves.toEqual({ ok: true });
    expect(seen).toEqual(['delivered', 'done']);
    const failed = t.store.follow(DeliveryId.parse('dlv_2'), () => undefined);
    t.push({ type: 'delivery', delivery: { id: DeliveryId.parse('dlv_2'), status: 'expired' } });
    await expect(failed).rejects.toThrow('expired');
  });

  it('loads older pages without duplicates, and throttles typing reports', async () => {
    const t = thread();
    const a = message();
    const b = message();
    t.api.messages = fakeCaller<'messages'>(({ cursor }) => Promise.resolve(cursor === undefined ? { items: [b], cursor: 'older' } : { items: [b, a] }));
    await t.store.open();
    await t.store.loadOlder();
    expect(t.store.messages.value.map((m) => m.id)).toEqual([a.id, b.id]);
    expect(t.store.beginning.value).toBe(true);
    t.store.reportPresence({ typing: true, focused: true });
    t.store.reportPresence({ typing: true, focused: true });
    t.store.reportPresence({ typing: false, focused: true });
    expect(t.api.presence.calls.map((c) => c[0].typing)).toEqual([true, false]);
  });
});

describe('ComposerStore', () => {
  const make = (store = memoryStore(), caps: ChatCapabilities | undefined = capabilities()) => {
    const api = fakeChatApi();
    return { api, store, composer: new ComposerStore({ session: S1, store, api, capabilities: () => caps, uploads: new UploadQueue(api, fakeSender(), fakePreviews) }, { delay: 50, perProvider: 6, max: 24 }) };
  };

  it('keeps the draft per session across a reload', async () => {
    const { composer, store } = make();
    composer.input('half a thought', 14);
    composer.setReply(MessageId.parse('msg_9'));
    await nextTick();
    expect(store.data.has(draftKey(S1))).toBe(true);
    const again = make(store).composer;
    expect(again.text.value).toBe('half a thought');
    expect(again.replyTo.value).toBe('msg_9');
    again.clear();
    await nextTick();
    expect(store.data.has(draftKey(S1))).toBe(false);
  });

  it('searches mentions after a pause and inserts a chip; deleting the chip drops it', async () => {
    vi.useFakeTimers();
    const { composer, api } = make();
    composer.input('see @harn', 9);
    await nextTick();
    expect(composer.pickerOpen.value).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(api.mentions.calls[0]?.[0]).toEqual({ session: S1, provider: 'fs/files', query: 'harn' });
    expect(composer.pickerItems.value[0]?.kind).toBe('mention');
    composer.pick();
    expect(composer.text.value).toBe('see @harn.md ');
    expect(composer.mentions.value).toHaveLength(1);
    expect(composer.outgoing()?.parts).toEqual([{ type: 'text', text: 'see ' }, { type: 'mention', provider: 'fs/files', label: 'harn.md', target: { path: 'docs/harn.md' } }]);
    composer.input('see ', 4);
    expect(composer.mentions.value).toEqual([]);
  });

  it('offers commands and fns only when the hub does, and opens the ! form', async () => {
    const { composer } = make();
    composer.input('/tr', 3);
    await nextTick();
    expect(composer.pickerItems.value.map((i) => i.kind)).toEqual(['command']);
    composer.pick();
    expect(composer.text.value).toBe('/tree ');
    expect(composer.hint.value?.command.name).toBe('tree');
    composer.input('!ed', 3);
    await nextTick();
    composer.movePicker(1);
    composer.pick();
    expect(composer.invoking.value?.fn).toBe('fs/edit');
    expect(composer.text.value).toBe('');

    const none = make(memoryStore(), capabilities({ mentions: [], commands: [], invocations: [] })).composer;
    none.input('@x /y', 2);
    expect(none.trigger.value).toBeUndefined();
  });

  it('closes the picker on Escape until the caret leaves the trigger, and edits a message in place', async () => {
    const { composer } = make();
    composer.input('/', 1);
    await nextTick();
    composer.dismissPicker();
    expect(composer.pickerOpen.value).toBe(false);
    composer.startEdit(MessageId.parse('msg_e'), 'old words', []);
    expect([composer.editing.value, composer.text.value, composer.caretRequest.value]).toEqual(['msg_e', 'old words', 9]);
    const snap = composer.snapshot();
    composer.clear('keep');
    composer.restore(snap);
    expect(composer.text.value).toBe('old words');
    composer.cancelEdit();
    expect(composer.editing.value).toBeUndefined();
  });
});

describe('sendDraft', () => {
  it('empties the box at once, keeps files until sent, and puts it all back on failure', async () => {
    const chat = fakeChat();
    const t = chat.chat.thread(S1);
    await t.open();
    const composer = chat.chat.composer(S1);
    composer.input('hello', 5);
    composer.uploads.add([new File(['abc'], 'a.txt', { type: 'text/plain' })]);
    await flush();
    chat.api.send = failingCaller<'send'>(new ApiError(503, 'later', undefined));
    const failed = await sendDraft(t, composer);
    expect(failed.ok).toBe(false);
    expect(composer.text.value).toBe('hello');
    expect(composer.uploads.items.value).toHaveLength(1);
    chat.api.send = fakeChatApi().send;
    const sent = await sendDraft(t, composer);
    expect(sent).toEqual({ ok: true, moved: 0, undone: undefined });
    expect(chat.api.send.calls[0]?.[0].parts.map((p) => p.type)).toEqual(['text', 'file']);
    expect([composer.text.value, composer.uploads.items.value.length]).toEqual(['', 0]);
  });
});

describe('UploadQueue', () => {
  it('uploads with progress, blocks sending while busy, and retries a failure', async () => {
    const api = fakeChatApi();
    const sender = fakeSender(false);
    const queue = new UploadQueue(api, sender, fakePreviews);
    queue.add([new File(['png'], 'shot.png', { type: 'image/png' })]);
    await flush();
    expect(queue.items.value[0]).toMatchObject({ status: 'uploading', progress: 0.5, preview: 'blob:preview' });
    expect(queue.busy.value).toBe(true);
    sender.finish();
    await flush();
    expect(queue.items.value[0]?.status).toBe('ready');
    expect(queue.parts.value).toEqual([{ type: 'file', ref: { hash: 'a'.repeat(64), size: 3, mime: 'text/plain' }, name: 'shot.png' }]);
    api.uploaded = failingCaller<'uploaded'>(new Error('hash failed'));
    queue.add([new File(['x'], 'b.txt')]);
    sender.finish();
    await flush();
    sender.finish();
    await flush();
    const failed = queue.items.value[1];
    expect(failed?.status).toBe('failed');
    api.uploaded = fakeChatApi().uploaded;
    if (failed !== undefined) { queue.retry(failed.id); }
    await flush();
    sender.finish();
    await flush();
    expect(queue.items.value[1]?.status).toBe('ready');
    queue.clear();
    expect(queue.items.value).toEqual([]);
  });
});

describe('VoiceStore', () => {
  it('records, uploads, transcribes; a blocked microphone says how to fix it', async () => {
    const api = fakeChatApi();
    const upload = vi.fn(() => Promise.resolve({ hash: 'b'.repeat(64), size: 3, mime: 'audio/webm' }));
    const voice = new VoiceStore(fakeRecorder(), upload, api, () => T0);
    await voice.start();
    expect(voice.state.value).toBe('recording');
    expect(await voice.stop()).toBe('dictated words');
    expect(upload).toHaveBeenCalledOnce();
    expect(voice.state.value).toBe('idle');
    const denied = new VoiceStore(fakeRecorder(false), upload, api);
    await denied.start();
    expect(denied.state.value).toBe('denied');
    expect(denied.problem.value).toContain('blocked');
    denied.dismiss();
    expect(denied.state.value).toBe('idle');
  });
});

describe('DraftSuggestions', () => {
  it('asks after a pause, best first, and not for short drafts or commands', async () => {
    vi.useFakeTimers();
    const api = fakeChatApi();
    api.suggest = fakeCaller<'suggest'>(() => Promise.resolve([
      { kind: 'fn', name: 'fs/read_file', description: 'Read', score: 0.4 }, { kind: 'context', name: 'fs/readme', description: 'Docs', score: 0.9 },
    ]));
    const suggest = new DraftSuggestions(api, S1, { pause: 100, minLength: 5, limit: 6 });
    suggest.update('hi');
    suggest.update('/tree src please');
    await vi.advanceTimersByTimeAsync(200);
    expect(api.suggest.calls).toHaveLength(0);
    suggest.update('read the docs');
    await vi.advanceTimersByTimeAsync(100);
    expect(suggest.items.value.map((s) => s.name)).toEqual(['fs/readme', 'fs/read_file']);
    suggest.clear();
    expect(suggest.items.value).toEqual([]);
  });
});

describe('Inspector', () => {
  it('loads a run, a resource, and a turn’s tree and LLM calls; the open tree refreshes after changes pause', async () => {
    vi.useFakeTimers();
    const api = fakeChatApi();
    const inspector = new Inspector(api, 100);
    await inspector.openRun(RunId.parse('run_x'));
    expect(inspector.run.value.value?.id).toBe('run_x');
    await inspector.openResource(ResourceUri.parse('file:///docs/harness.md'));
    expect(inspector.resource.value.value?.text).toEqual({ inline: '# Harness' });
    const calls = await inspector.loadTurn(TurnId.parse('trn_1'));
    expect(calls.map((c) => c.id)).toEqual(['llm_1']);
    inspector.refreshTree();
    inspector.refreshTree();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.tree.calls).toHaveLength(2);
    api.tree = failingCaller<'tree'>(new ApiError(404, 'gone', undefined));
    await inspector.openTree(TurnId.parse('trn_2'));
    expect(inspector.tree.problem.value).toBe("That isn't there any more.");
    inspector.closeTree();
    expect(inspector.tree.value.value).toBeUndefined();
    expect(tree().children).toEqual([]);
  });
});

describe('small stores', () => {
  it('remembers collapsed cards, newest kept', () => {
    const store = memoryStore();
    const collapse = new CollapseStore(store);
    const a = RunId.parse('run_a');
    collapse.setAll([a, RunId.parse('run_b')], true);
    collapse.set(RunId.parse('run_b'), false);
    expect(new CollapseStore(store).isCollapsed(a)).toBe(true);
    expect(new CollapseStore(store).isCollapsed(RunId.parse('run_b'))).toBe(false);
    collapse.setAll(Array.from({ length: COLLAPSE_KEEP + 5 }, (_, i) => RunId.parse(`run_${i}`)), true);
    expect(collapse.isCollapsed(a)).toBe(false);
  });

  it('fetches a mention card once, and reads a failure as unavailable', async () => {
    const api = fakeChatApi();
    const cards = new MentionCards(api);
    await cards.load(S1, 'fs/files', { path: 'a' });
    await cards.load(S1, 'fs/files', { path: 'a' });
    expect(api.mentionHover.calls).toHaveLength(1);
    expect(cards.card('fs/files', { path: 'a' }).hover?.title).toBe('harness.md');
    api.mentionHover = failingCaller<'mentionHover'>(new ApiError(0, 'offline', undefined));
    await cards.load(S1, 'fs/files', { path: 'b' });
    expect(cards.card('fs/files', { path: 'b' }).problem).toContain('reach');
  });

  it('loads each system build once per hash and marks failures', async () => {
    const load = vi.fn((_runtime: unknown, url: string) => (url.includes('bad') ? Promise.reject(new Error('404')) : Promise.resolve()));
    const share = vi.fn(() => Promise.resolve());
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hub = new RendererHub({ thread: () => undefined, online: () => true, load, share });
    const clients = capabilities({ clients: [{ system: 'fs', url: '/clients/fs.js', hash: 'h1' }, { system: 'notes', url: '/clients/bad.js', hash: 'h1' }] }).clients;
    await hub.sync(clients);
    await hub.sync(clients);
    expect(load).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenCalledOnce();
    expect([hub.status.value.get('fs'), hub.status.value.get('notes')]).toEqual(['ready', 'failed']);
    expect(hub.fn('fs/bash')).toBeUndefined();
    expect(hub.runtime.systemClient('fs').online).toBe(true);
    error.mockRestore();
  });
});

describe('ChatStore', () => {
  it('keeps a few threads, and stops listening to the one it leaves', async () => {
    const { chat, sessionEvents } = fakeChat();
    await chat.open(S1);
    expect(sessionEvents.listeners(S1)).toBe(1);
    const other = SessionId.parse('ses_2');
    await chat.open(other);
    expect(sessionEvents.listeners(S1)).toBe(0);
    expect(chat.thread(other)).toBe(chat.thread(other));
    expect(chat.composer(S1)).toBe(chat.composer(S1));
    expect(chat.voice()).toBeUndefined();
    expect(fakeChat({ recorder: fakeRecorder() }).chat.voice()).toBeDefined();
    chat.leave();
    expect(chat.current.value).toBeUndefined();
    await chat.refresh();
  });
});

