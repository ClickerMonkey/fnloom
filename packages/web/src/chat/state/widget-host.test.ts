/**
 * Waiting on a run in the thread (`settledRun`, used by widget actions, the Data pages and the Claude pages): the hub's
 * `done` status event lands before the run's record brings its outcome, so a waiter must wait for the outcome instead
 * of calling the run a failure ("It ended done.").
 */
import { QualifiedName, RunId, SessionId, type Run } from '@harness/core';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyRun, runEnding, UNREAD_OUTCOME } from '../logic/runs.ts';
import { fakeChatApi, fakeSessionEvents, run, session, T0 } from '../test/fakes.ts';
import { fakeCaller } from '../../test/fakes.ts';
import { ThreadStore } from './thread.ts';
import { OUTCOME_READS, threadChatHost, threadWidgetHost } from './widget-host.ts';
import type { DataStore } from '../../data/state/data.ts';

const S1 = SessionId.parse('ses_1');
const RUN = RunId.parse('run_inv');
const FN = QualifiedName.parse('shop/mark_paid');

afterEach(() => { vi.useRealTimers(); });

/** A thread whose run reads answer `record()` (changed by the test), and a widget host over it. */
async function host(record: () => Run) {
  const api = fakeChatApi();
  api.run = fakeCaller<'run'>(() => Promise.resolve(record()));
  const channel = fakeSessionEvents();
  const thread = new ThreadStore(S1, {
    api, events: channel.subscribe, clock: () => T0, client: () => ({ timeZone: 'UTC', locale: 'en', now: T0 }), me: () => session().owner, changed: () => undefined,
  }, { page: 2, runsOnOpen: 10, typingFor: 1_000, presenceEvery: 3_000 });
  await thread.open();
  const data: Pick<DataStore, 'rowActions' | 'readFn' | 'exportCsv'> = { rowActions: () => Promise.resolve([]), readFn: () => Promise.resolve(null), exportCsv: () => Promise.resolve(new Blob()) };
  const widgets = threadWidgetHost({ thread, data, levels: { get: () => '', set: () => undefined }, ask: () => Promise.resolve(true) });
  return { api, thread, widgets, push: (status: Run['status']) => { channel.push(S1, { type: 'run', run: RUN, fn: FN, update: { type: 'status', status } }); } };
}

describe('how a run ended (runEnding)', () => {
  it('is unknown while it runs, and while any settled run has no outcome yet', () => {
    expect(runEnding(emptyRun(RUN, FN, 'running'))).toBeUndefined();
    for (const status of ['done', 'failed', 'cancelled', 'invalid-input', 'undone'] as const) {
      expect(runEnding(emptyRun(RUN, FN, status))).toBeUndefined();
    }
    // a failed attempt's error before the run's own outcome is not its ending
    const retried = { ...emptyRun(RUN, FN, 'failed'), errors: [{ attempt: 1, at: T0, error: { class: 'retry' as const, code: 'x', message: 'Try again.' }, cost: 0 }] };
    expect(runEnding(retried)).toBeUndefined();
  });

  it('says what is known once the record has been read as often as it will be', () => {
    expect(runEnding(emptyRun(RUN, FN, 'running'), true)).toBeUndefined();
    expect(runEnding(emptyRun(RUN, FN, 'done'), true)).toEqual({ ok: false, problem: UNREAD_OUTCOME });
    expect(runEnding(emptyRun(RUN, FN, 'failed'), true)).toEqual({ ok: false, problem: 'It ended failed.' });
    expect(runEnding(emptyRun(RUN, FN, 'cancelled'), true)).toEqual({ ok: false, problem: 'It ended cancelled.' });
  });

  it('is its result once the outcome is read', () => {
    expect(runEnding({ ...emptyRun(RUN, FN, 'done'), outcome: { status: 'done', result: { paid: true } } })).toEqual({ ok: true, output: { paid: true } });
    // a null result is still a result
    expect(runEnding({ ...emptyRun(RUN, FN, 'done'), outcome: { status: 'done', result: null } })).toEqual({ ok: true, output: null });
  });

  it('says why any other settled run ended, from its outcome or errors, else its status', () => {
    const error = { class: 'fatal' as const, code: 'boom', message: 'The till is offline.' };
    expect(runEnding({ ...emptyRun(RUN, FN, 'failed'), outcome: { status: 'failed', error } })).toEqual({ ok: false, problem: 'The till is offline.' });
    const declined = { class: 'caller' as const, code: 'denied', message: 'Declined by Ana: not today' };
    expect(runEnding({ ...emptyRun(RUN, FN, 'cancelled'), outcome: { status: 'cancelled', error: declined }, errors: [{ attempt: 1, at: T0, error: declined, cost: 0 }] }))
      .toEqual({ ok: false, problem: 'Declined by Ana: not today' });
    expect(runEnding({ ...emptyRun(RUN, FN, 'cancelled'), outcome: { status: 'cancelled' } })).toEqual({ ok: false, problem: 'It ended cancelled.' });
    expect(runEnding({ ...emptyRun(RUN, FN, 'invalid-input'), outcome: { status: 'invalid-input', invalid: { source: 'unavailable', problems: [] } } }))
      .toEqual({ ok: false, problem: 'Not available now' });
    // an undone run keeps the outcome it was done with
    expect(runEnding({ ...emptyRun(RUN, FN, 'undone'), outcome: { status: 'done', result: 1 } })).toEqual({ ok: false, problem: 'It ended undone.' });
  });
});

describe('the chat host system renderers get (CHAT_HOST)', () => {
  it('waits on a run a renderer started until its outcome comes, asks the agent and moves the app', async () => {
    let record = run({ id: RUN, fn: FN, status: 'running' });
    const { thread, push } = await host(() => record);
    const asked: Array<[string, boolean]> = [];
    const paths: string[] = [];
    const chat = threadChatHost({ thread, ask: (text, send) => { asked.push([text, send]); return Promise.resolve(true); }, navigate: (path) => { paths.push(path); } });
    const started = await thread.invoke(FN, { order: 'o1' });
    expect(started).toBe(RUN);
    let outcome: unknown;
    void chat.settled(RUN).then((o) => { outcome = o; });
    await flushPromises();
    // the done event comes before the record brings the outcome: not over yet
    record = run({ id: RUN, fn: FN, status: 'done', outcome: { status: 'done', result: { saved: true } } });
    push('done');
    expect(outcome).toBeUndefined();
    await flushPromises();
    expect(outcome).toEqual({ ok: true, output: { saved: true } });
    expect(await chat.ask('Change it: ', false)).toBe(true);
    expect(asked).toEqual([['Change it: ', false]]);
    chat.navigate('/s/widgets/saved?q=widgets%2Fx');
    expect(paths).toEqual(['/s/widgets/saved?q=widgets%2Fx']);
  });
});

describe('a widget action waiting on its run', () => {
  it('resolves with the result when the done event comes before the outcome', async () => {
    let record = run({ id: RUN, fn: FN, status: 'running' });
    const { widgets, push, api } = await host(() => record);
    let outcome: unknown;
    void widgets.run(FN, { order: 'o1' }).then((o) => { outcome = o; });
    await flushPromises();
    expect(api.invoke.calls[0]?.[0]).toMatchObject({ fn: FN, args: { order: 'o1' } });
    // the status event lands first: no outcome yet, so it isn't over for the waiter
    record = run({ id: RUN, fn: FN, status: 'done', outcome: { status: 'done', result: { paid: true } } });
    push('done');
    expect(outcome).toBeUndefined();
    await flushPromises();
    expect(outcome).toEqual({ ok: true, output: { paid: true } });
  });

  it('reads the record again when the first read came back before the hub stored the outcome', async () => {
    vi.useFakeTimers();
    let record = run({ id: RUN, fn: FN, status: 'running' });
    const { widgets, push, api } = await host(() => record);
    let outcome: unknown;
    void widgets.run(FN, {}).then((o) => { outcome = o; });
    await vi.advanceTimersByTimeAsync(0);
    push('done');
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBeUndefined();
    const reads = api.run.calls.length;
    record = run({ id: RUN, fn: FN, status: 'done', outcome: { status: 'done', result: 'ok' } });
    await vi.advanceTimersByTimeAsync(OUTCOME_READS[1] ?? 0);
    expect(api.run.calls.length).toBeGreaterThan(reads);
    expect(outcome).toEqual({ ok: true, output: 'ok' });
  });

  it('says the result could not be read when no record ever brings it', async () => {
    vi.useFakeTimers();
    const { widgets, push } = await host(() => run({ id: RUN, fn: FN, status: 'running' }));
    let outcome: unknown;
    void widgets.run(FN, {}).then((o) => { outcome = o; });
    await vi.advanceTimersByTimeAsync(0);
    push('done');
    await vi.advanceTimersByTimeAsync(OUTCOME_READS.reduce((a, b) => a + b, 0) + 10);
    expect(outcome).toEqual({ ok: false, problem: UNREAD_OUTCOME });
  });

  it('ends a declined run with who declined it and why, read after the cancelled event', async () => {
    let record = run({ id: RUN, fn: FN, status: 'running' });
    const { widgets, push } = await host(() => record);
    let outcome: unknown;
    void widgets.run(FN, {}).then((o) => { outcome = o; });
    await flushPromises();
    const declined = { class: 'caller' as const, code: 'denied', message: 'Declined by Ana: not today' };
    record = run({ id: RUN, fn: FN, status: 'cancelled', outcome: { status: 'cancelled', error: declined }, errors: [{ attempt: 1, at: T0, error: declined, cost: 0 }] });
    push('cancelled');
    expect(outcome).toBeUndefined();
    await flushPromises();
    expect(outcome).toEqual({ ok: false, problem: 'Declined by Ana: not today' });
  });

  it('ends a failed run with its error, read after the failed event', async () => {
    let record = run({ id: RUN, fn: FN, status: 'running' });
    const { widgets, push } = await host(() => record);
    let outcome: unknown;
    void widgets.run(FN, {}).then((o) => { outcome = o; });
    await flushPromises();
    record = run({ id: RUN, fn: FN, status: 'failed', outcome: { status: 'failed', error: { class: 'fatal', code: 'x', message: 'No till.' } } });
    push('failed');
    expect(outcome).toBeUndefined();
    await flushPromises();
    expect(outcome).toEqual({ ok: false, problem: 'No till.' });
  });
});
