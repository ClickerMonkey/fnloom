/**
 * A system's place and its packaged life, against the in-memory hub: the instance it is (as asked, then as the hub's
 * welcome names it), its data and cache folders in every context, the export lifecycle, and what it shows and tells
 * the hub while it waits to be paired.
 */
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceName, MAIN_INSTANCE } from '@harness/core';
import type { SystemCtx } from '../ctx.ts';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { sdkEnv } from './env.ts';
import { serve, type RunningSystem } from './index.ts';
import type { PairingDisplay, PairingShown } from './pairing.ts';
import { FakeHub } from './testing.ts';

const vault = system('vault', { description: 'Keeps things for tests.' }).with({
  config: g.obj({ name: g.text() }),
  fns: { where: fn({ description: 'Where it keeps things.', args: g.obj({}), returns: g.obj({ instance: g.text(), data: g.text(), cache: g.text() }) }) },
});

let running: RunningSystem<'vault'> | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** What the lifecycle events saw. */
interface Seen {
  started: Array<Pick<SystemCtx, 'instance' | 'dataDir' | 'cacheDir'>>;
  exporting: number[];
}

async function start(hub: FakeHub, options: { env?: Partial<ReturnType<typeof sdkEnv.parse>>; exporting?: (seen: Seen) => Promise<void>; display?: PairingDisplay; folders?: string[][] } = {}) {
  const seen: Seen = { started: [], exporting: [] };
  running = await serve(vault, {
    fns: { where: { async run(_args, ctx) { return ctx.done({ instance: ctx.instance, data: ctx.dataDir, cache: ctx.cacheDir }); } } },
    lifecycle: {
      async started(ctx) { seen.started.push({ instance: ctx.instance, dataDir: ctx.dataDir, cacheDir: ctx.cacheDir }); },
      async exporting(ctx) {
        seen.exporting.push(ctx.timeout);
        await options.exporting?.(seen);
      },
    },
  }, { hub: 'ws://hub.test/link', state: 'states/vault', version: '1.0.0' }, hub.host({
    env: { ...sdkEnv.parse(), ...options.env },
    folders: (dirs) => { options.folders?.push([...dirs]); return Promise.resolve(); },
    ...(options.display === undefined ? {} : { pairing: options.display }),
  }));
  return seen;
}

describe('the place a system keeps things', () => {
  it('keeps data and cache in its state folder by default, made before it starts, in every context', async () => {
    const hub = new FakeHub({ config: { name: 'v' } });
    const folders: string[][] = [];
    const seen = await start(hub, { folders });
    await running?.ready();
    const place = { instance: 'main', data: resolve('states/vault/data'), cache: resolve('states/vault/cache') };
    expect(folders).toEqual([[place.data, place.cache]]);
    expect(seen.started).toEqual([{ instance: MAIN_INSTANCE, dataDir: place.data, cacheDir: place.cache }]);
    expect(await hub.run('vault/where', {})).toEqual({ status: 'done', result: place });
  });

  it('uses the folders and instance the hub gives a system it installed', async () => {
    const hub = new FakeHub({ config: { name: 'v' } });
    await start(hub, { env: { HARNESS_SYSTEM_DATA: 'installed/data', HARNESS_SYSTEM_CACHE: 'installed/cache', HARNESS_INSTANCE: InstanceName.parse('laptop') } });
    await running?.ready();
    expect(hub.hellos[0]).toMatchObject({ name: 'vault', instance: 'laptop' });
    expect(await hub.run('vault/where', {})).toEqual({ status: 'done', result: { instance: 'laptop', data: resolve('installed/data'), cache: resolve('installed/cache') } });
  });

  it('takes the instance name the hub welcomes it with, and says it on the next hello', async () => {
    const hub = new FakeHub({ config: { name: 'v' }, instance: InstanceName.parse('desk') });
    const seen = await start(hub);
    await running?.ready();
    expect(hub.hellos[0]?.instance).toBe('main');
    expect(seen.started[0]?.instance).toBe('desk');
    expect(await hub.run('vault/where', {})).toMatchObject({ result: { instance: 'desk' } });
    hub.drop(5);
    await hub.whenConnected();
    expect(hub.hellos.at(-1)?.instance).toBe('desk');
  });
});

describe('exporting data', () => {
  it('runs the exporting lifecycle with the timeout, then says where the data folder is', async () => {
    const hub = new FakeHub({ config: { name: 'v' } });
    const seen = await start(hub);
    await running?.ready();
    expect(await hub.exportData(750)).toEqual({ data: resolve('states/vault/data') });
    expect(seen.exporting).toEqual([750]);
  });

  it('refuses the export when exporting outlasts the timeout, since the folder may still be changing', async () => {
    const hub = new FakeHub({ config: { name: 'v' } });
    await start(hub, { exporting: () => new Promise(() => undefined) });
    await running?.ready();
    await expect(hub.exportData(20)).rejects.toMatchObject({ status: 500, code: 'EXPORT_NOT_READY' });
    expect(hub.logs.some((line) => line.key === 'system.exporting-slow')).toBe(true);
  });

  it('refuses the export when the system cannot get its data ready', async () => {
    const hub = new FakeHub({ config: { name: 'v' } });
    await start(hub, { exporting: () => Promise.reject(new Error('the database is locked')) });
    await running?.ready();
    await expect(hub.exportData()).rejects.toMatchObject({ status: 500, code: 'EXPORT_NOT_READY' });
  });
});

describe('waiting to be paired', () => {
  it('tells the hub what the pairing page shows, and shows the person the link and code', async () => {
    const hub = new FakeHub({ pairing: true, config: { name: 'v' } });
    const shown: PairingShown[] = [];
    await start(hub, { display: { show: (pairing) => { shown.push(pairing); return Promise.resolve(); } } });
    await vi.waitFor(() => { expect(shown).toHaveLength(1); });
    expect(shown[0]).toMatchObject({ system: 'vault', instance: 'main', code: 'ABCD-1234', url: 'http://hub.test/pair' });
    expect(hub.pairingInfos).toHaveLength(1);
    const info = hub.pairingInfos[0];
    expect(info).toMatchObject({ description: 'Keeps things for tests.', instance: 'main' });
    // the config type travels, so the page can ask for config as the admin approves
    expect(JSON.stringify(info?.configType)).toContain('"name"');
    await hub.approve('vault');
    await running?.ready();
    expect(shown).toHaveLength(1);
  });
});
