/**
 * fs restarting itself under the hub's supervisor, end to end. This file starts a hub of its own, which installs the
 * real fs from its folder, so the supervisor runs it as a child process with the hub's Node flags (its `tsx` loader).
 * Then: the `restart` run settles, fs exits with the restart code, the supervisor starts it again at once without
 * counting a crash, and fs reconnects with its key, its contract and its renderers, and works. The run settles
 * exactly once.
 */
import { appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { QualifiedName, SystemName, type SystemView } from '@harness/core';
import { encodeValue } from '@harness/sdk';
import { RESTART_CODE } from '@harness/sdk/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from '../scripts/hub-client.ts';
import { fsConfig, ROOT, startStack, type Stack } from '../scripts/stack.ts';
import { fs } from '../systems/fs/shared/index.ts';
import { Approver, clientInfo, finished, SessionWatch, settings } from './kit.ts';
import { goLive } from './review.ts';

const FS = SystemName.parse('fs');
const RESTART = QualifiedName.parse('fs/restart');
const LIST = QualifiedName.parse('fs/list');
/** fs builds its renderers on every start, so starting can take a while. */
const START = 120_000;

let stack: Stack;
let watch: SessionWatch;
let approver: Approver;

/** fs as the hub sees it. */
async function fsView(): Promise<SystemView | undefined> {
  return (await stack.admin.hub.call('systems')).find((s) => s.name === FS);
}

/** Invoke a fn in the session, approve what it asks, and wait until it has finished. */
async function invoke(fn: QualifiedName, args: Record<string, string>) {
  const { result } = await approver.during((async () => {
    const started = await stack.admin.hub.call('invoke', { session: watch.session, fn, args, client: clientInfo() });
    await watch.next('run', (e) => e.run === started.run && finished(e.update), START);
    return started;
  })());
  return stack.admin.hub.call('run', { run: result.run });
}

beforeAll(async () => {
  const data = resolve(ROOT, `${settings.HARNESS_E2E_DATA}-restart`);
  rmSync(data, { recursive: true, force: true });
  stack = await startStack({
    port: settings.HARNESS_E2E_RESTART_PORT, data, admin: { email: settings.HARNESS_E2E_EMAIL, password: settings.HARNESS_E2E_PASSWORD },
    build: false, watch: false, only: new Set(['hub']), systems: { fs: fsConfig(ROOT), embedder: {} },
    hubEnv: { HARNESS_LOG_FILES: 'false', HARNESS_RESTART_BACKOFF: '60000' },
    output: (component, line) => { appendFileSync(join(data, 'stack.log'), `${component.padEnd(9)} ${line}\n`); },
  });
  await stack.admin.hub.call('installSystem', { source: { path: join(ROOT, 'systems', 'fs') }, config: encodeValue(fs.defs.config, fsConfig(ROOT)) });
  await waitFor('fs to start under the supervisor', async () => {
    const view = await fsView();
    return view?.status === 'connected' && !view.needsConfig && view.installed?.status === 'running' ? view : undefined;
  }, { timeout: START, every: 500 });
  // a newly installed system offers nothing until the admin goes live with it
  await goLive(stack.admin, FS);
  const session = await stack.admin.hub.call('createSession', { title: 'restart' });
  watch = new SessionWatch(stack.admin, session.id);
  approver = new Approver(stack.admin, watch);
});

afterAll(async () => {
  watch.stop();
  await stack.stop();
});

describe('fs restarting itself under the supervisor', () => {
  it('settles its restart run once, exits with the restart code, and comes back at once', async () => {
    const before = await fsView();
    const clientsBefore = (await stack.admin.hub.call('capabilities', {})).clients.filter((c) => c.system === FS);
    expect(clientsBefore).toHaveLength(1);

    const run = await invoke(RESTART, { reason: 'e2e restart' });
    expect(run.status).toBe('done');
    expect(run.outcome).toMatchObject({ status: 'done', result: { restarting: true } });

    const after = await waitFor('fs to restart and reconnect', async () => {
      const view = await fsView();
      return view?.installed?.lastExit?.code === RESTART_CODE && view.installed.pid !== before?.installed?.pid
        && view.status === 'connected' && view.installed.status === 'running' ? view : undefined;
    }, { timeout: START, every: 500 });
    // a restart it asked for is not a crash: no backoff (set to a minute here), still the same version and key
    expect(after.installed?.version).toBe(before?.installed?.version);
    expect(after.needsConfig).toBe(false);

    // the run settled once, before the process went away, and nothing settled it again after the reconnect
    const settledEvents = watch.of('run').filter((e) => e.run === run.id && finished(e.update));
    expect(settledEvents).toHaveLength(1);
    expect((await stack.admin.hub.call('run', { run: run.id })).status).toBe('done');

    // its contract and its rebuilt renderers are there after the restart
    const fns = await stack.admin.hub.call('systemFns', { system: FS });
    expect(fns.map((f) => f.name)).toEqual(expect.arrayContaining([RESTART, LIST]));
    const clientsAfter = (await stack.admin.hub.call('capabilities', {})).clients.filter((c) => c.system === FS);
    expect(clientsAfter.map((c) => c.hash)).toEqual(clientsBefore.map((c) => c.hash));
    const bundle = clientsAfter[0];
    if (bundle === undefined) { throw new Error('fs has no client bundle after the restart'); }
    const served = await fetch(new URL(bundle.url, stack.url));
    expect(served.ok).toBe(true);
  });

  it('works after the restart', async () => {
    const listed = await invoke(LIST, { path: 'systems' });
    expect(listed.status).toBe('done');
    expect(JSON.stringify(listed.outcome)).toContain('embedder');
  });
});
