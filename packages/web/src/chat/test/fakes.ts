/**
 * Test doubles for the chat: records parsed through the hub's own schemas (so ids are the real branded types and a
 * schema change breaks the fixtures), a full set of fake chat callers answering from an in-memory session, a session
 * event channel a test pushes into, a file sender, a recorder, and the chat store built on them.
 */
import {
  ActorId, Approval, ChatCapabilities, SelectionReport, ChatMessage, DeliveryId, HandlerCall, LlmInteraction, Run, RunId, Session, SessionSummary, SystemName, TreeNode, TurnId, UndoReport,
  type SessionEvent, type SessionId,
} from '@harness/core';
import { fakeCaller, memoryStore } from '../../test/fakes.ts';
import type { FileSender, SessionEvents } from '../api.ts';
import { ChatStore, type ChatDeps } from '../state/chat.ts';
import type { Previews } from '../state/uploads.ts';
import type { Recorder } from '../state/voice.ts';

/** The clock every fixture is stamped from: 7 Nov 2026, noon UTC. */
export const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);
/** The signed-in person in chat tests. */
export const ME = 'act_ada';
export const AGENT = 'act_agent';

type Loose<T> = Partial<Record<keyof T, unknown>>;

let counter = 1;
const next = (): number => counter++;

/** What the graph contextor chose for a small model's prompt: a 4,096 window, two context items and three fns. */
export function selectionReport(overrides: Loose<SelectionReport> = {}): SelectionReport {
  return SelectionReport.parse({
    contextor: 'graph', mode: 'static', linear: 3, earlier: [0, 2],
    context: [
      { name: 'fs/docs', detail: 'full', activation: 0.82 },
      { name: 'memory/likes-short-answers', detail: 'signature', activation: 0.41 },
    ],
    fns: [
      { name: 'fs/read', detail: 'full', activation: 0.9 },
      { name: 'fs/bash', detail: 'signature', activation: 0.55 },
      { name: 'fs/search', detail: 'listed', activation: 0.2 },
    ],
    budget: {
      window: 4_096, output: 512, reasoning: 0, margin: 246, fixed: 612,
      pools: { history: { asked: 1_900, got: 1_230 }, context: { asked: 640, got: 640 }, fns: { asked: 344, got: 344 } },
      estimate: 2_826, cut: [{ what: '2 older exchanges', why: 'History asked 1,900 tokens; 1,230 were left.' }],
    },
    ...overrides,
  });
}

/** A session. */
export function session(overrides: Loose<Session> = {}): Session {
  return Session.parse({
    id: 'ses_1', title: 'Refactor the router', owner: ME, agent: 'hub/chat',
    participants: [{ actor: ME, role: 'owner', notify: 'all', joinedAt: T0 }, { actor: AGENT, role: 'agent', notify: 'none', joinedAt: T0 }],
    systems: 'all', tools: [], context: [], status: 'idle', transcript: [], createdAt: T0 - 3_600_000, updatedAt: T0, archived: false, ...overrides,
  });
}

/** A session's summary. */
export function summary(overrides: Loose<SessionSummary> = {}): SessionSummary {
  const n = next();
  return SessionSummary.parse({ id: `ses_${n}`, title: `Chat ${n}`, owner: ME, agent: 'hub/chat', status: 'idle', createdAt: T0 - n * 60_000 - 1_000, updatedAt: T0 - n * 60_000, archived: false, ...overrides });
}

/** A message. */
export function message(overrides: Loose<ChatMessage> = {}): ChatMessage {
  const n = next();
  return ChatMessage.parse({
    id: `msg_${n}`, session: 'ses_1', turn: `trn_${n}`, author: ME, role: 'user', parts: [{ type: 'text', text: `Message ${n}` }], runs: [],
    status: 'done', replyAll: false, answerers: [], createdAt: T0 + n * 1_000, ...overrides,
  });
}

/** A run. */
export function run(overrides: Loose<Run> = {}): Run {
  const n = next();
  return Run.parse({
    id: `run_${n}`, fn: 'fs/read_file', fnVersion: '1', kind: 'native', system: 'fs', root: `run_${n}`, turn: 'trn_1', key: `k${n}`, actor: ME, caller: AGENT,
    args: { path: 'docs/harness.md' }, status: 'running', allowed: { cancel: true, pause: false, background: true }, cost: 0, totalCost: 0, priority: 'interactive',
    background: false, attempt: 1, errors: [], stateChanges: [], createdAt: T0, startedAt: T0, ...overrides,
  });
}

/** An approval waiting on the person. */
export function approval(overrides: Loose<Approval> = {}): Approval {
  const n = next();
  return Approval.parse({ id: `apr_${n}`, run: `run_${n}`, fn: 'fs/write_file', approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: T0 + n, ...overrides });
}

/** A handler call the person answers. */
export function handlerCall(overrides: Loose<HandlerCall> = {}): HandlerCall {
  const n = next();
  return HandlerCall.parse({
    id: `hcl_${n}`, run: 'run_1', handler: 'confirm', args: { question: 'Overwrite README.md?' },
    decl: { description: 'Confirm overwriting a file.', args: { name: 'obj', props: { question: { type: { name: 'text' } } } }, returns: { name: 'bool' } },
    answerer: { user: ME }, status: 'pending', createdAt: T0 + n, ...overrides,
  });
}

/** An LLM call. */
export function llmCall(overrides: Loose<LlmInteraction> = {}): LlmInteraction {
  const n = next();
  return LlmInteraction.parse({
    id: `llm_${n}`, turn: 'trn_1', run: 'run_1', iteration: 0, provider: 'openrouter', model: 'meta/llama-free',
    request: { messages: [{ role: 'system', content: 'You are the chat agent.' }, { role: 'user', content: 'Hi <local-time>9:30</local-time>' }], tools: [{ name: 'fs_read_file', parameters: {} }] },
    response: { content: 'Hello!', finishReason: 'stop' }, usage: { input: 1200, output: 80 }, cost: 0.002, status: 'done', priority: 'interactive',
    queuedAt: T0, startedAt: T0 + 100, firstTokenAt: T0 + 400, endedAt: T0 + 1_400, ...overrides,
  });
}

/** Capabilities with every power on. */
export function capabilities(overrides: Loose<ChatCapabilities> = {}): ChatCapabilities {
  return ChatCapabilities.parse({
    voiceInput: true, voiceOutput: false, uploads: true,
    mentions: [{ provider: 'fs/files', title: 'Files', of: 'fs/Entry' }],
    methods: [
      { type: 'fs/Entry', method: 'reveal', fn: 'fs/Entry.reveal', description: 'Show it in the file manager', args: { name: 'obj', props: { self: { type: { name: 'fs/Entry' } } } } },
      {
        type: 'fs/Entry', method: 'rename', fn: 'fs/Entry.rename', description: 'Rename it',
        args: { name: 'obj', props: { self: { type: { name: 'fs/Entry' } }, to: { type: { name: 'text' } } } },
      },
    ],
    commands: [{ name: 'tree', context: 'fs/tree', args: [{ name: 'root', hint: 'Folder to start from', required: false }], description: 'Show the file tree' }],
    agents: [{ fn: 'hub/chat', description: 'The chat agent.' }, { fn: 'fs/explore', description: 'Explores the files.' }],
    invocations: [{
      fn: 'fs/edit', description: 'Edit a file',
      args: { name: 'obj', props: { path: { type: { name: 'text', options: { minLength: 1 } } }, find: { type: { name: 'text' } }, replace: { type: { name: 'text' } } } },
    }],
    display: {}, clients: [], systems: [{ name: 'fs', status: 'connected', enabled: true }], models: [{ id: 'meta/llama-free', provider: 'openrouter', name: 'Llama (free)', contextWindow: 131_072, pricing: { input: 0, output: 0 }, capabilities: ['chat', 'tools'] }], ...overrides,
  });
}

/** A one-node tree. */
export function tree(overrides: Partial<TreeNode> = {}): TreeNode {
  return TreeNode.parse({ run: { id: 'run_1', fn: 'hub/chat', status: 'done', cost: 0.01, totalCost: 0.02 }, llmCalls: [{ id: 'llm_1', model: 'meta/llama-free', cost: 0.002, status: 'done' }], children: [], ...overrides });
}

/** The chat callers, answering from one session. */
export function fakeChatApi() {
  const current = session();
  return {
    capabilities: fakeCaller<'capabilities'>(() => Promise.resolve(capabilities())),
    types: fakeCaller<'types'>(({ names }) => Promise.resolve({ types: [], missing: names })),
    sessions: fakeCaller<'sessions'>(() => Promise.resolve(({ items: [summary({ id: 'ses_1', title: current.title })] }))),
    searchSessions: fakeCaller<'sessions'>(() => Promise.resolve(({ items: [summary({ id: 'ses_1', title: current.title })] }))),
    session: fakeCaller<'session'>(({ session: id }) => Promise.resolve(session({ id }))),
    createSession: fakeCaller<'createSession'>(() => Promise.resolve(session({ id: 'ses_new', title: 'New chat' }))),
    updateSession: fakeCaller<'updateSession'>(({ session: id, ...change }) => Promise.resolve(session({ id, ...change }))),
    limits: fakeCaller<'limits'>(() => Promise.resolve(({ priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 600_000 }, budgets: [] }))),
    messages: fakeCaller<'messages'>(() => Promise.resolve(({ items: [] }))),
    send: fakeCaller<'send'>(({ session: id, parts }) => {
      const sent = message({ session: id, parts: parts.map((p) => (p.type === 'mention' ? { ...p, text: p.label } : p)) });
      return Promise.resolve({ turn: sent.turn, message: sent });
    }),
    invoke: fakeCaller<'invoke'>(() => Promise.resolve(({ turn: TurnId.parse('trn_inv'), run: RunId.parse('run_inv') }))),
    control: fakeCaller<'control'>(() => Promise.resolve(({ pause: false, cancel: false, uncancellable: [], undoLastTurn: true }))),
    background: fakeCaller<'background'>(() => Promise.resolve(({ accepted: true }))),
    undoTurn: fakeCaller<'undoTurn'>(({ turn }) => Promise.resolve(UndoReport.parse({ turn, undone: [], failed: [], notUndoable: [] }))),
    tree: fakeCaller<'tree'>(() => Promise.resolve(tree())),
    treeRefresh: fakeCaller<'tree'>(() => Promise.resolve(tree())),
    run: fakeCaller<'run'>(({ run: id }) => Promise.resolve(run({ id }))),
    llmCall: fakeCaller<'llmCall'>(({ id }) => Promise.resolve(llmCall({ id }))),
    suggest: fakeCaller<'suggest'>(() => Promise.resolve([])),
    mentions: fakeCaller<'mentions'>(({ query }) => Promise.resolve([{ label: `${query || 'harness'}.md`, hint: 'docs/', target: { path: `docs/${query}.md` } }])),
    mentionHover: fakeCaller<'mentionHover'>(() => Promise.resolve(({ hover: { title: 'harness.md', subtitle: 'docs/', fields: [{ label: 'Size', value: '12 KB' }] } }))),
    waiting: fakeCaller<'waiting'>(() => Promise.resolve({ approvals: [], handlers: [] })),
    approve: fakeCaller<'approve'>(({ approval: id, approve }) => Promise.resolve(approval({ id, status: approve ? 'approved' : 'denied' }))),
    answer: fakeCaller<'answer'>(() => Promise.resolve(undefined)),
    setBudget: fakeCaller<'setBudget'>(({ id }) => Promise.resolve({ id: id ?? 'bgt_new' })),
    presence: fakeCaller<'presence'>(() => Promise.resolve(undefined)),
    resource: fakeCaller<'resource'>(({ uri }) => Promise.resolve(({ stat: { uri, name: 'harness.md', type: 'file', format: 'markdown', version: '1' }, text: { inline: '# Harness' } }))),
    upload: fakeCaller<'upload'>(({ name }) => Promise.resolve(({ url: `/_files?put=${name}`, upload: `up_${name}` }))),
    uploaded: fakeCaller<'uploaded'>(() => Promise.resolve(({ hash: 'a'.repeat(64), size: 3, mime: 'text/plain' }))),
    transcribe: fakeCaller<'transcribe'>(() => Promise.resolve(({ text: 'dictated words' }))),
    act: fakeCaller<'act'>(() => Promise.resolve(({ delivery: DeliveryId.parse('dlv_act') }))),
    submit: fakeCaller<'submit'>(() => Promise.resolve(({ delivery: DeliveryId.parse('dlv_form') }))),
    deleteSession: fakeCaller<'deleteSession'>(() => Promise.resolve({ deleted: true })),
    state: fakeCaller<'state'>(() => Promise.resolve({ system: SystemName.parse('fs'), fields: [] })),
    previewSelection: fakeCaller<'previewSelection'>(() => Promise.resolve(selectionReport())),
  };
}

/** The fake chat callers. */
export type FakeChatApi = ReturnType<typeof fakeChatApi>;

/** A session channel a test pushes events into. */
export function fakeSessionEvents(): { subscribe: SessionEvents; push(session: SessionId, event: SessionEvent): void; listeners(session: SessionId): number } {
  const listeners = new Map<SessionId, Set<(event: SessionEvent) => void>>();
  return {
    subscribe: (id, listener) => {
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => { set.delete(listener); };
    },
    push: (id, event) => { for (const listener of listeners.get(id) ?? []) { listener(event); } },
    listeners: (id) => listeners.get(id)?.size ?? 0,
  };
}

/** A file sender that reports halfway, then finishes when `finish` is called (or at once with `instant`). */
export function fakeSender(instant = true): FileSender & { finish(): void; readonly sent: string[] } {
  const waiting: (() => void)[] = [];
  const sent: string[] = [];
  return {
    sent,
    put: (url, _file, progress) => {
      sent.push(url);
      progress(0.5);
      if (instant) { progress(1); return Promise.resolve(); }
      return new Promise((resolve) => { waiting.push(() => { progress(1); resolve(); }); });
    },
    finish: () => { for (const done of waiting.splice(0)) { done(); } },
  };
}

/** Previews that name the file. */
export const fakePreviews: Previews = { make: (file) => (file.type.startsWith('image/') ? 'blob:preview' : undefined), revoke: () => undefined };

/** A recorder whose permission a test decides. */
export function fakeRecorder(allow = true): Recorder & { readonly started: number } {
  let started = 0;
  return {
    get started() { return started; },
    start: () => { started++; return allow ? Promise.resolve() : Promise.reject(new DOMException('denied', 'NotAllowedError')); },
    stop: () => Promise.resolve(new Blob(['abc'], { type: 'audio/webm' })),
    cancel: () => undefined,
  };
}

/** The chat store on fakes. */
export function fakeChat(options: { api?: FakeChatApi; recorder?: Recorder | undefined } = {}) {
  const api = options.api ?? fakeChatApi();
  const sessionEvents = fakeSessionEvents();
  const userListeners = new Set<Parameters<ChatDeps['userEvents']>[0]>();
  const store = memoryStore();
  const sender = fakeSender();
  const deps: ChatDeps = {
    api, sessionEvents: sessionEvents.subscribe, store, sender,
    userEvents: (listener) => { userListeners.add(listener); return () => { userListeners.delete(listener); }; },
    clock: () => T0, client: () => ({ timeZone: 'UTC', locale: 'en', now: T0 }), me: (): ActorId | undefined => ActorId.parse(ME),
    recorder: () => options.recorder, previews: fakePreviews,
    // a catch-up that fails tries again on the next task, so a test can change what the hub answers meanwhile
    retry: { delays: [0], sleep: () => new Promise((resolve) => { setTimeout(resolve, 0); }) },
    renderers: { load: () => Promise.resolve(), share: () => Promise.resolve() },
  };
  const chat = new ChatStore(deps);
  return {
    chat, api, sessionEvents, store, sender,
    pushUser: (event: Parameters<Parameters<ChatDeps['userEvents']>[0]>[0]) => { for (const listener of userListeners) { listener(event); } },
  };
}
