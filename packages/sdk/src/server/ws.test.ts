/**
 * The real link: `WsLinkTransport` (ayepi's `wsTransport` over Node's WebSocket) against the fake hub served on a real
 * socket by `@ayepi/node`, including the hub going away and coming back.
 */
import { serve as listen } from '@ayepi/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { LinkHost, MemoryJournal, MemoryKeyStore, serve, type RunningSystem } from './index.ts';
import { systemLogger } from './log.ts';
import { FakeHub } from './testing.ts';
import { sdkEnv } from './env.ts';

/** A port for this test's hub (above 4300, as the repo asks). */
const PORT = 4386;

const echo = system('echo', { description: 'Echo.' }).with({
  fns: { say: fn({ description: 'Say it back.', args: g.obj({ text: g.text() }), returns: g.text() }) },
});

let running: RunningSystem<'echo'> | undefined;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await running?.stop();
  await close?.();
  running = undefined;
  close = undefined;
});

function start(hub: FakeHub): Promise<void> {
  return new Promise((resolve) => { close = listen(hub.app, { port: PORT, path: '/link', onListen: () => { resolve(); } }); });
}

describe('the WebSocket link', () => {
  it('connects, runs a fn both ways over a real socket, and reconnects when the hub comes back', async () => {
    const hub = new FakeHub();
    await start(hub);
    const keys = new MemoryKeyStore();
    const journal = new MemoryJournal(10);
    const host = new LinkHost({
      keys: () => keys,
      journal: () => journal,
      process: hub.process,
      signals: false,
      env: { ...sdkEnv.parse(), HARNESS_LINK_BACKOFF: 20, HARNESS_LINK_BACKOFF_MAX: 50 },
      logger: (sink) => systemLogger({ level: 'debug', json: false, sink, console: 'none' }),
      folders: () => Promise.resolve(),
    });
    running = await serve(echo, { fns: { say: { async run(args, ctx) { return ctx.done(`you said ${args.text}`); } } } }, { hub: `ws://127.0.0.1:${PORT}/link`, state: 'x', version: '1' }, host);
    await running.ready();
    expect(await hub.run('echo/say', { text: 'hi' })).toEqual({ status: 'done', result: 'you said hi' });

    await close?.();
    await vi.waitFor(() => { expect(running?.status).not.toBe('connected'); });
    await start(hub);
    await vi.waitFor(() => { expect(running?.status).toBe('connected'); }, { timeout: 5_000 });
    await hub.whenConnected();
    expect(await hub.run('echo/say', { text: 'again' })).toEqual({ status: 'done', result: 'you said again' });
    expect(hub.manifests).toHaveLength(1);
  });
});
