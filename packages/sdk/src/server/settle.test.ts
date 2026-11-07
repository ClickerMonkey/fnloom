/**
 * A run settles exactly once (risk 1): the hub sending the same run again, while it runs, after it settled, after the
 * link dropped mid-run, or to a restarted system, never runs the fn a second time and always gets the one outcome.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutcomeWire, RunRequest } from '@harness/core';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system, type SystemImpl } from '../system.ts';
import { FileJournal, MemoryKeyStore, serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';
import { Deferred } from './wire.ts';

const counter = system('counter', { description: 'Counts its runs.' }).with({
  fns: { tick: fn({ description: 'Count one run, once let go.', args: g.obj({ label: g.text() }), returns: g.text() }) },
});

/** A system whose `tick` waits for `release` and counts how often it really ran. */
function ticking() {
  const state = { runs: 0, release: new Deferred<void>() };
  const impl: SystemImpl<typeof counter['defs']> = {
    fns: {
      tick: {
        async run(args, ctx) {
          state.runs += 1;
          const run = state.runs;
          await state.release.promise;
          return ctx.done(`${args.label} #${run}`);
        },
      },
    },
  };
  return { state, impl };
}

let running: RunningSystem<'counter'> | undefined;
let folder: string | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
  if (folder !== undefined) { await rm(folder, { recursive: true, force: true }); }
  folder = undefined;
});

/** Send one request on the current link. */
function send(hub: FakeHub, request: RunRequest): Promise<OutcomeWire> {
  return hub.peer().call('run', request);
}

describe('a run the hub sends again', () => {
  it('joins the run already going: one execution, one outcome for both', async () => {
    const hub = new FakeHub();
    const { state, impl } = ticking();
    running = await serve(counter, impl, { hub: 'ws://hub.test/link', state: 'x', version: '1' }, hub.host());
    await running.ready();
    const request = hub.request('counter/tick', { label: 'a' });

    const first = send(hub, request);
    const again = send(hub, request);
    await vi.waitFor(() => { expect(state.runs).toBe(1); });
    state.release.resolve();

    const outcomes = await Promise.all([first, again]);
    expect(outcomes).toEqual([{ status: 'done', result: 'a #1' }, { status: 'done', result: 'a #1' }]);
    expect(state.runs).toBe(1);
  });

  it('is answered from the journal once it settled, without running the fn again', async () => {
    const hub = new FakeHub();
    const { state, impl } = ticking();
    state.release.resolve();
    running = await serve(counter, impl, { hub: 'ws://hub.test/link', state: 'x', version: '1' }, hub.host());
    await running.ready();
    const request = hub.request('counter/tick', { label: 'b' });

    expect(await send(hub, request)).toEqual({ status: 'done', result: 'b #1' });
    expect(await send(hub, request)).toEqual({ status: 'done', result: 'b #1' });
    expect(state.runs).toBe(1);
    // a new run of the same fn is a new run
    expect(await hub.run('counter/tick', { label: 'c' })).toEqual({ status: 'done', result: 'c #2' });
  });

  it('settles once across a link that drops mid-run, whether it is sent again while running or after', async () => {
    const hub = new FakeHub();
    const { state, impl } = ticking();
    running = await serve(counter, impl, { hub: 'ws://hub.test/link', state: 'x', version: '1' }, hub.host());
    await running.ready();

    // dropped while running, sent again while it still runs: the second send joins it
    const joined = hub.request('counter/tick', { label: 'j' });
    const lost = send(hub, joined);
    await vi.waitFor(() => { expect(state.runs).toBe(1); });
    hub.drop(5);
    await expect(lost).rejects.toThrow();
    await hub.whenConnected();
    const resent = send(hub, joined);
    state.release.resolve();
    expect(await resent).toEqual({ status: 'done', result: 'j #1' });

    // dropped while running, sent again after it settled: the journal answers
    state.release = new Deferred<void>();
    const journaled = hub.request('counter/tick', { label: 'k' });
    const lostAgain = send(hub, journaled);
    await vi.waitFor(() => { expect(state.runs).toBe(2); });
    hub.drop(5);
    await expect(lostAgain).rejects.toThrow();
    state.release.resolve();
    await vi.waitFor(() => { expect(running?.status).toBe('connected'); });
    await hub.whenConnected();
    expect(await send(hub, journaled)).toEqual({ status: 'done', result: 'k #2' });
    expect(state.runs).toBe(2);
  });

  it('is answered from the journal a restarted system reads back from its state folder', async () => {
    folder = await mkdtemp(join(tmpdir(), 'harness-settle-'));
    const stateFolder = folder;
    const hub = new FakeHub();
    const { state, impl } = ticking();
    state.release.resolve();
    // the restarted system keeps its key and its state folder, as a real one does
    const keys = new MemoryKeyStore();
    const deps = { journal: (dir: string, size: number) => new FileJournal(dir, size), keys: () => keys };
    running = await serve(counter, impl, { hub: 'ws://hub.test/link', state: stateFolder, version: '1' }, hub.host(deps));
    await running.ready();
    const request = hub.request('counter/tick', { label: 'r' });
    expect(await send(hub, request)).toEqual({ status: 'done', result: 'r #1' });
    await running.stop();

    running = await serve(counter, impl, { hub: 'ws://hub.test/link', state: stateFolder, version: '1' }, hub.host(deps));
    await running.ready();
    await hub.whenConnected();
    expect(await send(hub, request)).toEqual({ status: 'done', result: 'r #1' });
    expect(state.runs).toBe(1);
  });
});
