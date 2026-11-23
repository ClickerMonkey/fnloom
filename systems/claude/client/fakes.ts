/**
 * Fakes for the Claude pages' tests: a session record; the hub as a real ayepi web client whose HTTP answers come from
 * the test (the `records` and `readFn` reads, so queries are checked against the hub's own spec); a page's runs and
 * inbox that record what they were asked; and a page host whose shared components are plain stand-ins (the app's own
 * are tested with the app). Each stand-in draws its props as data attributes and its slots.
 */
import { client } from '@ayepi/core/client';
import { ActorId, DataRecord, hubWebSpec, Json, RecordQuery, type Approval, type HubWebSpec, type RecordPage, type RunId } from '@harness/core';
import type { ComposerProps, ConversationProps, HubClient, LoadStateProps, PageHost, PageInbox, PageRuns, PageRunsOptions, RunOutcome, SharedComponents } from '@harness/sdk';
import { h, reactive, shallowReactive, type FunctionalComponent } from 'vue';
import { z } from 'zod';
import { ClaudeSession } from '../shared/session.ts';

export const T0 = 1_762_000_000_000;
export const SESSION = '0b6f3c1e-4a3e-4c55-9d5c-2f1e8a7b9c10';

/** A session as the hub keeps it. */
export function sessionValue(overrides: Partial<ClaudeSession> = {}): ClaudeSession {
  return ClaudeSession.parse({
    instance: 'main', session: SESSION, folder: 'C:/code/shop', title: 'Fix checkout', status: 'waiting', owner: 'act_ada', permissionMode: 'default',
    waiting: ['run_w1'], asking: [], tasks: [], turns: 2, costUsd: 0.12, startedAt: T0, updatedAt: T0, ...overrides,
  });
}

/** A session's record. */
export function sessionRecord(value: unknown, id = 'rec_01JABCDEFGHJKMNPQRSTVWXYZ0'): DataRecord {
  return DataRecord.parse({ id, type: 'claude/Session', value: Json.parse(value), title: 'Fix checkout', version: 1, createdAt: T0, updatedAt: T0 });
}

/** What the fake hub answers. */
export interface HubAnswers {
  records(query: RecordQuery): RecordPage;
  readFn?(input: { readonly fn: string; readonly args: Json }): Json;
}

/** The hub's web API as a real client, its `records` and `readFn` answered by the test; what each was asked is kept. */
export function fakeHub(answers: HubAnswers) {
  const calls: { records: RecordQuery[]; readFn: { fn: string; args: Json }[] } = { records: [], readFn: [] };
  const answer = (name: string, body: unknown): unknown => {
    if (name === 'records') { const query = RecordQuery.parse(body); calls.records.push(query); return answers.records(query); }
    if (name === 'readFn') {
      const input = z.object({ fn: z.string(), args: Json }).parse(body);
      calls.readFn.push(input);
      return answers.readFn?.(input) ?? { items: [], offset: 0, end: 0 };
    }
    throw new Error(`the fake hub has no ${name}`);
  };
  const hub: HubClient = client<HubWebSpec>({
    baseUrl: 'http://hub.test/api', manifest: hubWebSpec,
    fetchImpl: async (request) => {
      const name = new URL(request.url).pathname.split('/').filter((part) => part !== '').at(-1) ?? '';
      const text = await request.text();
      try {
        return Response.json(answer(name, text === '' ? undefined : JSON.parse(text)));
      } catch (error) {
        return Response.json({ error: { code: 'FAILED', message: error instanceof Error ? error.message : String(error) } }, { status: 422 });
      }
    },
  });
  return { hub, calls };
}

/** What a fake page's runs hold: the test sets them. */
export interface FakeRunsState {
  approvals: Approval[];
  args: Map<RunId, Json>;
  problem: string;
}

/** What a fake page's runs were asked. */
export interface FakeRunsCalls {
  runs: { fn: string; args: Json; on?: string | undefined }[];
  attached: string[];
  made: string[];
  closed: number;
  approved: { id: string; approve: boolean; answer: Json | undefined }[];
}

/** A page's runs: each run is recorded and answered by `answer`; its approvals and their runs' args are the test's. */
export function fakeRuns(answer: (fn: string, args: Json) => RunOutcome = () => ({ ok: true, output: null })) {
  const state: FakeRunsState = shallowReactive({ approvals: [], args: new Map(), problem: '' });
  const calls: FakeRunsCalls = { runs: [], attached: [], made: [], closed: 0, approved: [] };
  const make = (options: PageRunsOptions): PageRuns => {
    calls.made.push(options.title());
    return {
      get approvals() { return state.approvals; },
      get problem() { return state.problem; },
      argsOf: (run) => state.args.get(run),
      attach: (session) => { calls.attached.push(session); },
      run: (fn, args, more) => { calls.runs.push({ fn, args, on: more?.on }); more?.waiting?.(); return Promise.resolve(answer(fn, args)); },
      approve: (approval, approve, _remember, _reason, given) => { calls.approved.push({ id: approval.id, approve, answer: given }); return Promise.resolve(true); },
      refresh: () => undefined,
      close: () => { calls.closed++; },
    };
  };
  return { make, state, calls };
}

/** The inbox's approvals, by run. */
export function fakeInbox(approvals: readonly Approval[] = []) {
  const loaded: RunId[][] = [];
  const decided: { id: string; approve: boolean; answer: Json | undefined }[] = [];
  const inbox: PageInbox = {
    byRun: (run) => approvals.find((approval) => approval.run === run),
    load: (runs) => { loaded.push([...runs]); return Promise.resolve(); },
    decide: (approval, approve, _reason, answer) => { decided.push({ id: approval.id, approve, answer }); return Promise.resolve(true); },
    problem: '',
  };
  return { inbox, loaded, decided };
}

/**
 * A stand-in for a shared component: a `div` naming it, its model as `data-value` (with an `input` that edits a text
 * model, so a test types into it), and its slots.
 */
function standIn<P extends object>(name: string): FunctionalComponent<P, { 'update:modelValue': [value: string] }> {
  const part: FunctionalComponent<P, { 'update:modelValue': [value: string] }> = (props, { slots, attrs, emit }) => {
    // a prop no stand-in declares keeps the name the template wrote it with
    const model: unknown = Reflect.get(props, 'modelValue') ?? Reflect.get(props, 'model-value');
    const open: unknown = Reflect.get(props, 'open');
    return h('div', { ...attrs, 'data-part': name, 'data-value': model === undefined ? undefined : JSON.stringify(model) }, [
      typeof model === 'string' ? h('input', { value: model, onInput: (event: Event) => { if (event.target instanceof HTMLInputElement) { emit('update:modelValue', event.target.value); } } }) : undefined,
      slots['crumb']?.(), slots['actions']?.(), open === false ? undefined : slots['default']?.(), open === false ? undefined : slots['footer']?.(),
    ]);
  };
  part.displayName = `Fake${name}`;
  return part;
}

/** The shared components as stand-ins: `LoadState` draws its content once ready (else its empty slot), `Conversation` its entries. */
export function fakeComponents(): SharedComponents {
  const LoadState: FunctionalComponent<LoadStateProps> = (props, { slots }) => h('div', { 'data-part': 'LoadState' },
    props.loading ? 'loading' : props.problem !== '' ? props.problem : props.empty ? slots['empty']?.() : props.ready ? slots['default']?.() : undefined);
  const Conversation: FunctionalComponent<ConversationProps> = (props, { attrs }) => h('div', {
    ...attrs, 'data-part': 'Conversation', 'data-entries': JSON.stringify(props.entries), 'data-streaming': String(props.streaming === true),
  });
  // the composer: a box for the text, Send and Stop, so a test types and presses them as a person would
  const Composer: FunctionalComponent<ComposerProps, { 'update:modelValue': [text: string]; send: []; stop: [] }> = (props, { emit, attrs }) => h('div', { ...attrs, 'data-part': 'Composer' }, [
    h('textarea', { value: props.modelValue, onInput: (event: Event) => { if (event.target instanceof HTMLTextAreaElement) { emit('update:modelValue', event.target.value); } } }),
    h('button', { 'data-action': 'send', onClick: () => { emit('send'); } }, 'Send'),
    h('button', { 'data-action': 'stop', onClick: () => { emit('stop'); } }, 'Stop'),
  ]);
  Composer.props = ['modelValue'];
  Composer.emits = ['update:modelValue', 'send', 'stop'];
  return {
    Frame: standIn('Frame'), Input: standIn('Input'), Markdown: standIn('Markdown'), Icon: standIn('Icon'), Empty: standIn('Empty'), LoadState,
    Reasoning: standIn('Reasoning'), Typing: standIn('Typing'), ResourceViewer: standIn('ResourceViewer'), ValueEditor: standIn('ValueEditor'),
    Button: standIn('Button'), Select: standIn('Select'), Textarea: standIn('Textarea'), Dialog: standIn('Dialog'), Banner: standIn('Banner'), Badge: standIn('Badge'),
    Skeleton: standIn('Skeleton'), FnPill: standIn('FnPill'), Approval: standIn('Approval'), Conversation, Composer,
  };
}

/** A page host over these fakes, at a URL query the test can change (`query`), recording where the page went and what it said. */
export function fakeHost(options: { hub: HubClient; runs?: ReturnType<typeof fakeRuns>; inbox?: PageInbox; query?: Readonly<Record<string, string>> }) {
  const query = reactive<Record<string, string>>({ ...options.query });
  const moves: unknown[] = [];
  const notes: { tone: 'ok' | 'error'; title: string; detail?: string | undefined }[] = [];
  const set = (patch: Readonly<Record<string, string | undefined>>): void => {
    for (const [key, value] of Object.entries(patch)) { if (value === undefined || value === '') { Reflect.deleteProperty(query, key); } else { query[key] = value; } }
  };
  const runs = options.runs ?? fakeRuns();
  const host: PageHost = {
    user: { id: ActorId.parse('act_ada'), kind: 'user', name: 'Ada', role: 'member', email: 'ada@example.test' },
    hub: options.hub,
    query: {
      get values() { return { ...query }; },
      get: (key) => query[key],
      set: (patch) => { set(patch); },
      bind: (key, fallback = '') => ({ get value() { return query[key] ?? fallback; }, set value(next: string) { set({ [key]: next === fallback ? undefined : next }); } }),
    },
    href: (to) => `/s/claude/${to.page ?? 'here'}/${(to.path ?? []).join('/')}`,
    chatHref: (session) => `/c/${session}`,
    goChat: (session) => { moves.push({ chat: session }); },
    runHref: (run) => `/run/${run}`,
    goRun: (run) => { moves.push({ run }); },
    go: (to) => { moves.push(to); },
    openChat: () => Promise.resolve(),
    components: fakeComponents(),
    runs: (made) => runs.make(made),
    inbox: options.inbox ?? fakeInbox().inbox,
    notify: { ok: (title, detail) => { notes.push({ tone: 'ok', title, detail }); }, error: (title, detail) => { notes.push({ tone: 'error', title, detail }); } },
    format: { cost: (usd) => `$${usd.toFixed(2)}`, relativeTime: () => 'just now', fullTime: () => 'today' },
    live: () => undefined,
  };
  return { host, query, moves, notes, runs };
}
