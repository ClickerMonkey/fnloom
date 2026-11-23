/**
 * The schedule pages over a page host, mounted through the SDK's client runtime as the app mounts them: the calendar
 * reads the person's schedules (`searchFns`, then `hub/fns_get` as quiet reads) and their firing records, draws the
 * past and coming runs on its agenda and opens one's panel with a link to its run page; a schedule's page says when it
 * runs and saves an edit, a pause and a skip as the person's own runs of the schedule fns (`host.runs`); the admins'
 * page lists every schedule fn with its owner and pauses one. The hub is a real web client answered by the test, and
 * the shared components are stand-ins that draw their props and slots.
 */
import { client } from '@ayepi/core/client';
import { ActorId, hubWebSpec, Json, RecordQuery, type HubWebSpec, type RunId } from '@harness/core';
import { PAGE_HOST, type HubClient, type LoadStateProps, type PageHost, type PageRuns, type PageRunsOptions, type RunOutcome, type SharedComponents } from '@harness/sdk';
import { ClientRuntime } from '@harness/sdk/client';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, reactive, type FunctionalComponent } from 'vue';
import { z } from 'zod';
import scheduleClient from './index.ts';
import { SCHEDULE_PAGES } from './logic.ts';

const NOW = Date.parse('2026-11-23T20:00:00Z');
const NY = 'America/New_York';
const SCHEDULE = 'schedule/weekly_orders';
const PAYLOAD = {
  fn: 'database/main.orders_by_week', when: { dayOfWeek: [1], times: ['09:00'] }, zone: NY, notify: 'always', overlap: 'skip', missed: 'latest',
  args: { kind: 'new', type: { name: 'obj' }, value: { limit: { kind: 'new', type: { name: 'num' }, value: 10 } } },
};
const STORED = { fn: SCHEDULE, kind: 'schedule/schedule', description: 'Weekly orders', payload: PAYLOAD, version: 2, owner: 'act_ada', available: true };
const TARGET = { fn: PAYLOAD.fn, kind: 'database/query', version: 1, available: true, args: { name: 'obj', props: { limit: { type: { name: 'num' } } } } };
const RAN = {
  id: 'rec_01JABCDEFGHJKMNPQRSTVWXYZ0', type: 'schedule/Firing', title: 'x', version: 1, createdAt: NOW, updatedAt: NOW,
  value: { schedule: SCHEDULE, version: 2, at: Date.parse('2026-11-23T14:00:00Z'), key: '2026-11-23T09:00', manual: false, status: 'ran', run: 'run_1', summary: '12 rows: Widgets $1,240', notified: true },
};

/** A call's body, and a quiet read's. */
const Body = z.record(z.string(), z.unknown());
const ReadAsked = z.object({ args: z.object({ fn: z.string() }) });

/** The hub as a real web client, its endpoints answered here; what each was asked is kept. */
function fakeHub(answers: Partial<Record<string, (body: Record<string, unknown>) => unknown>> = {}) {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const defaults: Record<string, (body: Record<string, unknown>) => unknown> = {
    searchFns: () => ({ items: [{ item: 'fn', name: SCHEDULE, system: 'schedule', description: 'Weekly orders', kind: 'schedule/schedule', available: true }] }),
    readFn: (body) => (ReadAsked.parse(body).args.fn === SCHEDULE ? STORED : TARGET),
    records: (body) => { RecordQuery.parse(body); return { items: [RAN] }; },
    fns: () => ({ items: [{ name: SCHEDULE, system: 'schedule', addedBy: 'act_bo', available: true, disabled: false, decl: { payload: PAYLOAD } }] }),
    actors: () => [{ id: 'act_bo', kind: 'user', name: 'Bo', email: 'bo@example.test', role: 'member' }],
  };
  const hub: HubClient = client<HubWebSpec>({
    baseUrl: 'http://hub.test/api', manifest: hubWebSpec,
    fetchImpl: async (request) => {
      const name = new URL(request.url).pathname.split('/').filter((part) => part !== '').at(-1) ?? '';
      const text = await request.text();
      const body = Body.parse(text === '' ? {} : JSON.parse(text));
      calls.push({ name, body });
      const answer = answers[name] ?? defaults[name];
      if (answer === undefined) { return Response.json({ error: { code: 'FAILED', message: `no ${name} here` } }, { status: 422 }); }
      return Response.json(Json.parse(answer(body)));
    },
  });
  return { hub, calls };
}

/** A page's runs: each run is recorded and answered by `answer`. */
function fakeRuns(answer: (fn: string, args: Json) => RunOutcome = () => ({ ok: true, output: null })) {
  const calls: { fn: string; args: Json }[] = [];
  const made: string[] = [];
  const make = (options: PageRunsOptions): PageRuns => {
    made.push(options.title());
    return {
      approvals: [], problem: '', argsOf: () => undefined, attach: () => undefined,
      run: (fn, args) => { calls.push({ fn, args }); return Promise.resolve(answer(fn, args)); },
      approve: () => Promise.resolve(true), refresh: () => undefined, close: () => undefined,
    };
  };
  return { make, calls, made };
}

/** A stand-in for a shared component: its model as `data-value` (an `input` edits a text model), its props as attributes, and its slots. */
function standIn<P extends object>(name: string): FunctionalComponent<P, { 'update:modelValue': [value: string] }> {
  const part: FunctionalComponent<P, { 'update:modelValue': [value: string] }> = (props, { slots, attrs, emit }) => {
    const model: unknown = Reflect.get(props, 'modelValue') ?? Reflect.get(props, 'model-value') ?? attrs['modelValue'] ?? attrs['model-value'];
    const open: unknown = attrs['open'];
    return h('div', { ...attrs, 'data-part': name, 'data-value': model === undefined ? undefined : JSON.stringify(model) }, [
      typeof model === 'string' ? h('input', { value: model, onInput: (event: Event) => { if (event.target instanceof HTMLInputElement) { emit('update:modelValue', event.target.value); } } }) : undefined,
      slots['crumb']?.(), slots['actions']?.(), open === false ? undefined : slots['default']?.(), open === false ? undefined : slots['footer']?.(),
    ]);
  };
  return part;
}

function fakeComponents(): SharedComponents {
  const LoadState: FunctionalComponent<LoadStateProps> = (props, { slots }) => h('div', { 'data-part': 'LoadState' },
    props.loading ? 'loading' : props.problem !== '' ? props.problem : props.empty ? slots['empty']?.() : props.ready ? slots['default']?.() : undefined);
  return {
    Frame: standIn('Frame'), Input: standIn('Input'), Markdown: standIn('Markdown'), Icon: standIn('Icon'), Empty: standIn('Empty'), LoadState,
    Reasoning: standIn('Reasoning'), Typing: standIn('Typing'), ResourceViewer: standIn('ResourceViewer'), ValueEditor: standIn('ValueEditor'),
    Button: standIn('Button'), Select: standIn('Select'), Textarea: standIn('Textarea'), Dialog: standIn('Dialog'), Banner: standIn('Banner'), Badge: standIn('Badge'),
    Skeleton: standIn('Skeleton'), FnPill: standIn('FnPill'), Approval: standIn('Approval'), Conversation: standIn('Conversation'), Composer: standIn('Composer'),
  };
}

/** A page host over the fakes, at a URL query the test can read and change. */
function fakeHost(options: { hub: HubClient; runs?: ReturnType<typeof fakeRuns>; query?: Record<string, string>; role?: 'admin' | 'member' }) {
  const query = reactive<Record<string, string>>({ ...options.query });
  const moves: unknown[] = [];
  const notes: { tone: string; title: string; detail?: string | undefined }[] = [];
  const set = (patch: Readonly<Record<string, string | undefined>>): void => {
    for (const [key, value] of Object.entries(patch)) { if (value === undefined || value === '') { Reflect.deleteProperty(query, key); } else { query[key] = value; } }
  };
  const runs = options.runs ?? fakeRuns();
  const host: PageHost = {
    user: { id: ActorId.parse('act_ada'), kind: 'user', name: 'Ada', role: options.role ?? 'member', email: 'ada@example.test', timeZone: NY },
    hub: options.hub,
    query: {
      get values() { return { ...query }; },
      get: (key) => query[key],
      set: (patch) => { set(patch); },
      bind: (key, fallback = '') => ({ get value() { return query[key] ?? fallback; }, set value(next: string) { set({ [key]: next === fallback ? undefined : next }); } }),
    },
    href: (to) => `/s/schedule/${to.page ?? 'here'}/${(to.path ?? []).join('/')}`,
    chatHref: (session) => `/c/${session}`,
    goChat: () => undefined,
    runHref: (run) => `/run/${run}`,
    goRun: (run: RunId) => { moves.push({ run }); },
    go: (to) => { moves.push(to); },
    openChat: () => Promise.resolve(),
    components: fakeComponents(),
    runs: (made) => runs.make(made),
    inbox: { byRun: () => undefined, load: () => Promise.resolve(), decide: () => Promise.resolve(false), problem: '' },
    notify: { ok: (title, detail) => { notes.push({ tone: 'ok', title, detail }); }, error: (title, detail) => { notes.push({ tone: 'error', title, detail }); } },
    format: { cost: (usd) => `$${usd.toFixed(2)}`, relativeTime: () => 'just now', fullTime: () => 'today' },
    live: () => undefined,
  };
  return { host, query, moves, notes, runs };
}

const runtime = new ClientRuntime({
  online: () => true, act: () => Promise.reject(new Error('no actions here')), invoke: () => Promise.reject(new Error('no runs here')),
  submit: () => Promise.reject(new Error('no forms here')), follow: () => Promise.reject(new Error('no deliveries here')),
});
runtime.register(scheduleClient);

function mountPage(page: string, path: readonly string[], made: ReturnType<typeof fakeHost>) {
  const found = runtime.pageView('schedule', page, { path, host: made.host });
  if (found === undefined) { throw new Error(`the schedule build has no page ${page}`); }
  return mount(found.component, { props: found.props, global: { provide: { [PAGE_HOST]: made.host } }, attachTo: document.body });
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('the calendar page', () => {
  it('draws what ran and what comes next on the agenda, and opens a run\'s panel with a link to its run page', async () => {
    const { hub, calls } = fakeHub();
    const made = fakeHost({ hub, query: { view: 'agenda', day: '2026-11-23' } });
    const view = mountPage(SCHEDULE_PAGES.calendar, [], made);
    await flushPromises();
    expect(calls.find((call) => call.name === 'searchFns')?.body).toMatchObject({ kinds: ['schedule/schedule'], visibility: 'mine' });
    expect(calls.find((call) => call.name === 'readFn')?.body).toEqual({ fn: 'hub/fns_get', args: { fn: SCHEDULE } });
    expect(calls.find((call) => call.name === 'records')?.body).toMatchObject({ type: 'schedule/Firing' });
    const rows = view.findAll('[data-testid="agenda-entry"]');
    expect(rows.map((row) => row.attributes('data-status'))).toEqual(['ran', 'coming']);
    expect(rows[0]?.text()).toContain('12 rows: Widgets $1,240');
    expect(view.get('[data-testid="schedule-range"]').text()).toBe('Nov 23 – Dec 6, 2026');
    await rows[0]?.get('button').trigger('click');
    expect(made.query['entry']).toBe(`${SCHEDULE}@2026-11-23T09:00`);
    await flushPromises();
    const open = view.get('[data-testid="entry-open"]');
    expect(open.attributes('href')).toBe('/run/run_1');
    await open.trigger('click', { button: 0 });
    expect(made.moves).toContainEqual({ run: 'run_1' });
  });

  it('shows a month grid and opens a day\'s agenda from it; a filter goes to the hub', async () => {
    const { hub, calls } = fakeHub();
    const made = fakeHost({ hub, query: { view: 'month', day: '2026-11-23' } });
    const view = mountPage(SCHEDULE_PAGES.calendar, [], made);
    await flushPromises();
    expect(view.get('[data-testid="schedule-grid"]').attributes('data-view')).toBe('month');
    expect(view.findAll('[data-testid="grid-entry"]').map((chip) => chip.attributes('data-status'))).toEqual(['ran', 'coming']);
    await view.get('[data-day="2026-11-30"] [data-testid="grid-day"]').trigger('click');
    expect(made.query).toMatchObject({ view: 'agenda', day: '2026-11-30' });
    made.query['status'] = 'failed';
    await flushPromises();
    const last = RecordQuery.parse(calls.filter((call) => call.name === 'records').at(-1)?.body);
    expect(last.query?.filters).toContainEqual({ field: 'status', op: 'is', value: 'failed' });
  });

  it('says so when the person has no schedules', async () => {
    const { hub } = fakeHub({ searchFns: () => ({ items: [] }), records: () => ({ items: [] }) });
    const view = mountPage(SCHEDULE_PAGES.calendar, [], fakeHost({ hub }));
    await flushPromises();
    expect(view.find('[data-part="Empty"]').attributes('title')).toBe('Nothing scheduled yet');
  });
});

describe('a schedule\'s page', () => {
  it('says when it runs and what it runs, and lists its next runs', async () => {
    const { hub } = fakeHub();
    const view = mountPage(SCHEDULE_PAGES.item, ['weekly_orders'], fakeHost({ hub }));
    await flushPromises();
    expect(view.get('[data-testid="schedule-says"]').text()).toBe('Every week on Monday at 9:00 am');
    expect(view.get('[data-testid="schedule-fn"]').attributes('name')).toBe(PAYLOAD.fn);
    expect(view.get('[data-testid="schedule-coming"]').text()).toContain('Mon, Nov 30, 9:00 am');
  });

  it('saves an edit, a pause and a skip as the person\'s runs of the schedule fns', async () => {
    const { hub } = fakeHub();
    const runs = fakeRuns();
    const made = fakeHost({ hub, runs, query: { edit: '1' } });
    const view = mountPage(SCHEDULE_PAGES.item, ['weekly_orders'], made);
    await flushPromises();
    await view.get('[data-testid="form-notify"] input').setValue('failed');
    await view.get('[data-testid="schedule-save"]').trigger('click');
    await flushPromises();
    expect(runs.calls[0]).toEqual({ fn: 'schedule/change', args: { schedule: SCHEDULE, notify: 'failed' } });
    expect(runs.made).toEqual(['Schedule: Weekly orders']);
    expect(made.notes).toContainEqual({ tone: 'ok', title: 'Saved', detail: undefined });
    expect(made.query['edit']).toBeUndefined();
    await view.get('[data-testid="schedule-pause"]').trigger('click');
    await flushPromises();
    expect(runs.calls[1]).toEqual({ fn: 'schedule/pause', args: { schedule: SCHEDULE } });
    await view.get('[data-testid="skip-2026-11-30T09:00"]').trigger('click');
    await flushPromises();
    expect(runs.calls[2]).toEqual({ fn: 'schedule/skip', args: { schedule: SCHEDULE, day: '2026-11-30', time: '09:00' } });
  });

  it('says why a change didn\'t go through, and shows its history with links to the runs', async () => {
    const { hub } = fakeHub();
    const runs = fakeRuns(() => ({ ok: false, problem: 'Declined by Ada' }));
    const made = fakeHost({ hub, runs, query: { tab: 'history' } });
    const view = mountPage(SCHEDULE_PAGES.item, ['weekly_orders'], made);
    await flushPromises();
    const row = view.get('[data-testid="history-row"]');
    expect(row.attributes('data-status')).toBe('ran');
    expect(row.get('[data-testid="history-run"]').attributes('href')).toBe('/run/run_1');
    await view.get('[data-testid="schedule-pause"]').trigger('click');
    await flushPromises();
    expect(made.notes).toContainEqual({ tone: 'error', title: "Couldn't pause it", detail: 'Declined by Ada' });
  });

  it('says when there is no such schedule of the person\'s', async () => {
    const { hub } = fakeHub({ readFn: () => ({ fn: 'code/x', kind: 'code/code', version: 1, available: true }) });
    const view = mountPage(SCHEDULE_PAGES.item, ['gone'], fakeHost({ hub }));
    await flushPromises();
    expect(view.find('[data-part="Empty"]').attributes('title')).toBe('No such schedule of yours');
  });
});

describe('every schedule (admins)', () => {
  it('lists each schedule fn with its owner and pauses one as the admin\'s run', async () => {
    const { hub, calls } = fakeHub();
    const runs = fakeRuns();
    const made = fakeHost({ hub, runs, role: 'admin' });
    const view = mountPage(SCHEDULE_PAGES.all, [], made);
    await flushPromises();
    expect(calls.find((call) => call.name === 'fns')?.body).toMatchObject({ filters: [{ field: 'kind', op: 'is', value: 'schedule/schedule' }] });
    const row = view.get('[data-testid="all-row"]');
    expect(row.text()).toContain('Bo');
    expect(row.text()).toContain('Every week on Monday at 9:00 am');
    await row.get('[data-testid="all-toggle"]').trigger('click');
    await flushPromises();
    expect(runs.calls[0]).toEqual({ fn: 'schedule/pause', args: { schedule: SCHEDULE } });
  });
});
