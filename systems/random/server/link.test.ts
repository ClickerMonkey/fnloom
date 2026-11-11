/**
 * The random system with the SDK test kit (`@harness/sdk/testing`): served to a fake hub in one line, named as
 * `system.json` says, and its fn called with typed args, its typed result checked and nothing asked of the hub.
 */
import { readFileSync } from 'node:fs';
import { SystemPackageManifest } from '@harness/core';
import { testHub, type TestSystem } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { random } from '../shared/index.ts';
import { randomEnv } from './env.ts';
import { createImpl } from './impl.ts';

const packageManifest = SystemPackageManifest.parse(JSON.parse(readFileSync(new URL('../system.json', import.meta.url), 'utf8')));

describe('random', () => {
  let kit: TestSystem<'random', (typeof random)['defs']> | undefined;
  afterEach(async () => {
    await kit?.stop();
    kit = undefined;
  });

  it('is named as system.json says, and sends its manifest', async () => {
    kit = await testHub(random, createImpl({ settings: randomEnv.parse() }), { config: {} });
    expect(random.name).toBe(packageManifest.name);
    expect(kit.hub.manifests[0]?.fns.map((fn) => fn.name)).toEqual(['random']);
  });

  it('gives a whole number within the bounds, asking nothing of the hub', async () => {
    kit = await testHub(random, createImpl({ settings: randomEnv.parse() }), { config: {} });
    const { result, hubCalls } = await kit.call('random', { min: 1, max: 6 });
    expect(Number.isInteger(result) && result >= 1 && result <= 6).toBe(true);
    expect(hubCalls.calls).toEqual([]);
    expect((await kit.call('random', { min: 3, max: 3 })).result).toBe(3);
  });
});
