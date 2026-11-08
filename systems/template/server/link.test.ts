/**
 * The template system end to end over the SDK's real link runtime: `serve` connects to an in-memory hub (`FakeHub`),
 * says hello under the name in `system.json` and sends its manifest. Keep these passing as the system grows, and add
 * a test per fn, hook, mention and action beside this one (`hub.run('template/<fn>', args)` runs a fn).
 */
import { readFileSync } from 'node:fs';
import { SystemPackageManifest } from '@harness/core';
import { serve, type RunningSystem } from '@harness/sdk/server';
import { FakeHub } from '@harness/sdk/server/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { template } from '../shared/index.ts';
import { templateEnv } from './env.ts';
import { createImpl } from './impl.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));

describe('template over the link', () => {
  let running: RunningSystem<'template'> | undefined;
  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  it('is named as system.json says', () => {
    expect(template.name).toBe(packageManifest.name);
  });

  it('connects, says hello and sends its manifest', async () => {
    // TODO: once the contract declares config, give the fake hub a valid value here
    const hub = new FakeHub({ config: {} });
    const impl = createImpl({ settings: templateEnv.parse() });
    running = await serve(template, impl, { hub: 'ws://hub.test/link', state: 'unused', version: packageManifest.version }, hub.host());
    await running.ready();

    expect(hub.hellos.map((hello) => hello.name)).toEqual([packageManifest.name]);
    expect(hub.manifests).toHaveLength(1);
  });
});
