/** Child calls across the link: handler relay, child notices, watching, controlling children, and dropped links. */
import { mintId, type RunUpdate } from '@harness/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallFailed } from '../ctx.ts';
import { fn, handler } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { serve, type RunningSystem } from './index.ts';
import { FakeHub } from './testing.ts';

const store = system('store', { description: 'Files to copy.' }).with({
  fns: {
    put: fn({
      description: 'Store a file.',
      args: g.obj({ path: g.text() }),
      returns: g.obj({ bytes: g.num() }),
      handlers: { overwrite: handler({ description: 'Overwrite?', args: g.obj({ path: g.text() }), returns: g.bool(), required: true }) },
    }),
  },
});

const backup = system('backup', { description: 'Backups.' }).with({
  fns: {
    save: fn({ description: 'Save a copy.', args: g.obj({ path: g.text() }), returns: g.text(), deps: { put: store.fns.put } }),
    watchSave: fn({ description: 'Save and watch.', args: g.obj({}), returns: g.text(), deps: { put: store.fns.put } }),
    stopSave: fn({ description: 'Save, then cancel it.', args: g.obj({}), returns: g.text(), deps: { put: store.fns.put } }),
    probe: fn({ description: 'One child call shaped by the test, reporting how it settled.', args: g.obj({ how: g.enum(['same-key', 'bad-args', 'early-cancel', 'throwing-handler']) }), returns: g.text(), deps: { put: store.fns.put } }),
  },
});

let running: RunningSystem<'backup'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const answers: string[] = [];
const updates: RunUpdate[] = [];

async function start(hub: FakeHub): Promise<void> {
  running = await serve(backup, {
    fns: {
      save: {
        async run(args, ctx) {
          const put = await ctx.fns.put({ path: args.path }, { handlers: { overwrite: async (q) => { answers.push(q.path); return true; } } });
          return ctx.done(`${put.bytes}`);
        },
      },
      watchSave: {
        async run(_a, ctx) {
          const call = ctx.fns.put({ path: 'w' }, { key: 'the-put', handlers: { overwrite: async () => true } });
          call.watch((update) => updates.push(update));
          const child = await call.run;
          const put = await call;
          return ctx.done(`${child}:${put.bytes}`);
        },
      },
      stopSave: {
        async run(_a, ctx) {
          const call = ctx.fns.put({ path: 's' }, { handlers: { overwrite: async () => true } });
          await call.run;
          await call.pause();
          await call.cancel();
          const settled = await call.settled;
          return ctx.done(settled.status);
        },
      },
      probe: {
        async run(args, ctx) {
          const settledAs = async (call: PromiseLike<unknown>): Promise<string> => {
            try {
              await call;
              return 'done';
            } catch (error) {
              return error instanceof CallFailed ? error.error.class : 'other';
            }
          };
          const overwrite = { overwrite: async () => true };
          switch (args.how) {
            case 'same-key': {
              const first = ctx.fns.put({ path: 'a' }, { key: 'k', handlers: overwrite });
              const second = ctx.fns.put({ path: 'b' }, { key: 'k', handlers: overwrite });
              return ctx.done(`${await settledAs(second)},${await settledAs(first)}`);
            }
            case 'bad-args':
              // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately wrong at runtime
              return ctx.done(await settledAs(ctx.fns.put({ path: 3 } as unknown as { path: string }, { handlers: overwrite })));
            case 'early-cancel': {
              const call = ctx.fns.put({ path: 'c' }, { handlers: overwrite });
              await call.cancel();
              return ctx.done((await call.settled).status);
            }
            case 'throwing-handler':
              return ctx.done(await settledAs(ctx.fns.put({ path: 't' }, { handlers: { overwrite: async () => { throw new Error('no disk'); } } })));
          }
        },
      },
    },
  }, { hub: 'ws://hub.test/link', state: 'x', version: '1' }, hub.host());
  await running.ready();
}

describe('child calls', () => {
  it('relays the child\'s handler calls back to the handler this call supplied', async () => {
    const hub = new FakeHub();
    await start(hub);
    answers.length = 0;
    hub.onCall = async (call) => {
      const answer = await hub.peer().call('handler', { call: mintId('handlerCall'), run: call.parent, key: call.key, handler: 'overwrite', args: { path: '/a' } });
      return { status: 'done', result: { bytes: answer.ok && answer.value === true ? 7 : 0 } };
    };
    expect(await hub.run('backup/save', { path: '/a' })).toEqual({ status: 'done', result: '7' });
    expect(answers).toEqual(['/a']);
    expect(hub.calls[0]?.handlers).toEqual(['overwrite']);
  });

  it('refuses a relayed handler call for a key or handler it never supplied', async () => {
    const hub = new FakeHub();
    await start(hub);
    hub.onCall = async (call) => {
      const wrongKey = await hub.peer().call('handler', { call: mintId('handlerCall'), run: call.parent, key: 'nope', handler: 'overwrite', args: { path: '/a' } });
      const badArgs = await hub.peer().call('handler', { call: mintId('handlerCall'), run: call.parent, key: call.key, handler: 'overwrite', args: { path: 1 } });
      return { status: 'done', result: { bytes: wrongKey.ok || badArgs.ok ? 1 : 0 } };
    };
    expect(await hub.run('backup/save', { path: '/a' })).toEqual({ status: 'done', result: '0' });
  });

  it('resolves the child run as soon as the hub reports it, and passes its updates to watchers', async () => {
    const hub = new FakeHub();
    await start(hub);
    updates.length = 0;
    const child = mintId('run');
    hub.onCall = async (call) => {
      await hub.peer().call('child', { parent: call.parent, key: call.key, run: child });
      await hub.peer().call('child', { parent: call.parent, key: call.key, run: child, update: { type: 'progress', progress: { fraction: 0.5 } } });
      return { status: 'done', result: { bytes: 3 } };
    };
    expect(await hub.run('backup/watchSave', {})).toEqual({ status: 'done', result: `${child}:3` });
    expect(updates).toEqual([{ type: 'progress', progress: { fraction: 0.5 } }]);
  });

  it('pauses and cancels a child through the hub', async () => {
    const hub = new FakeHub();
    await start(hub);
    const child = mintId('run');
    let settle: (() => void) | undefined;
    hub.onCall = async (call) => {
      await hub.peer().call('child', { parent: call.parent, key: call.key, run: child });
      await new Promise<void>((resolve) => { settle = resolve; });
      return { status: 'cancelled' };
    };
    hub.onControl = async (control) => {
      if (control.action === 'cancel') { settle?.(); }
      return { accepted: true };
    };
    expect(await hub.run('backup/stopSave', {})).toEqual({ status: 'done', result: 'cancelled' });
    expect(hub.controls).toEqual([{ run: child, action: 'pause' }, { run: child, action: 'cancel' }]);
  });

  it('sends a call cut off by a dropped link again on the next connection, with the same key', async () => {
    const hub = new FakeHub();
    await start(hub);
    let first = true;
    hub.onCall = async () => {
      if (first) {
        first = false;
        hub.drop(5);
        return new Promise(() => undefined);
      }
      return { status: 'done', result: { bytes: 9 } };
    };
    const run = hub.runInfo('backup/save');
    // the run's own reply is lost with the link; the hub asks again on the new connection and gets the outcome
    void hub.run('backup/save', { path: '/d' }, { run }).catch(() => undefined);
    await vi.waitFor(() => { expect(hub.calls).toHaveLength(2); }, { timeout: 2_000 });
    expect(hub.calls[0]?.key).toBe(hub.calls[1]?.key);
    await hub.whenConnected();
    expect(await hub.run('backup/save', { path: '/d' }, { run })).toEqual({ status: 'done', result: '9' });
  });

  it('refuses a second open call with the same key, and keeps the first', async () => {
    const hub = new FakeHub();
    await start(hub);
    hub.onCall = async () => ({ status: 'done', result: { bytes: 1 } });
    expect(await hub.run('backup/probe', { how: 'same-key' })).toEqual({ status: 'done', result: 'other,done' });
    expect(hub.calls).toHaveLength(1);
  });

  it('fails a call whose args do not fit as the caller\'s error, without asking the hub', async () => {
    const hub = new FakeHub();
    await start(hub);
    expect(await hub.run('backup/probe', { how: 'bad-args' })).toEqual({ status: 'done', result: 'fatal' });
    expect(hub.calls).toHaveLength(0);
  });

  it('cancels a call before the hub reports its child, locally', async () => {
    const hub = new FakeHub();
    await start(hub);
    hub.onCall = () => new Promise(() => undefined);
    expect(await hub.run('backup/probe', { how: 'early-cancel' })).toEqual({ status: 'done', result: 'cancelled' });
    expect(hub.controls).toEqual([]);
  });

  it('turns a hub that refuses the call into a retryable link failure', async () => {
    const hub = new FakeHub();
    await start(hub);
    hub.onCall = () => Promise.reject(new Error('queue full'));
    expect(await hub.run('backup/save', { path: '/r' })).toMatchObject({ status: 'failed', error: { class: 'retry' } });
  });

  it('answers a relayed handler call whose handler throws with a failure, not a crash', async () => {
    const hub = new FakeHub();
    await start(hub);
    let answered: unknown;
    hub.onCall = async (call) => {
      answered = await hub.peer().call('handler', { call: mintId('handlerCall'), run: call.parent, key: call.key, handler: 'overwrite', args: { path: '/t' } });
      return { status: 'done', result: { bytes: 2 } };
    };
    expect(await hub.run('backup/probe', { how: 'throwing-handler' })).toEqual({ status: 'done', result: 'done' });
    expect(answered).toMatchObject({ ok: false });
    expect(JSON.stringify(answered)).toContain('no disk');
  });
});
