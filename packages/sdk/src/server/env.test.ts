import { env } from '@ayepi/env';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolve } from 'node:path';
import { defaultStateFolder, placeFolders, SYSTEM_ENV, sdkEnv, systemFields, systemState } from './env.ts';

describe('a system\'s link variables', () => {
  it('reads the hub, state folder and pairing token under the names the hub sets, with defaults by system', () => {
    const slice = env({ ...systemFields(), SHOP_TIMEOUT: z.number().default(5) }).add(systemState('shop'));
    expect(slice.get('HARNESS_SYSTEM_STATE')).toBe('.harness/systems/shop');
    expect(slice.get('SHOP_TIMEOUT')).toBe(5);
    slice.set({ [SYSTEM_ENV.hub]: 'ws://hub/link', [SYSTEM_ENV.pairingToken]: 'tok' });
    expect(slice.parse()).toMatchObject({ HARNESS_HUB: 'ws://hub/link', HARNESS_PAIRING_TOKEN: 'tok' });
  });
});

describe('a hand-started instance\'s state folder', () => {
  it('is its own for each instance unless one is named, so a fleet on one machine never shares a key pair', () => {
    const slice = env({ ...systemFields() }).add(systemState('shop'));
    slice.set({ [SYSTEM_ENV.instance]: 'desk' });
    expect(slice.parse().HARNESS_SYSTEM_STATE).toBe('.harness/systems/shop/desk');
    slice.set({ [SYSTEM_ENV.instance]: 'desk', [SYSTEM_ENV.state]: 'elsewhere' });
    expect(slice.parse().HARNESS_SYSTEM_STATE).toBe('elsewhere');
    expect(defaultStateFolder('shop', sdkEnv.get(SYSTEM_ENV.instance))).toBe('.harness/systems/shop');
  });
});

describe('an instance\'s folders', () => {
  it('are the ones the hub names, else data and cache in the state folder, always absolute', () => {
    const slice = env({ ...systemFields() }).add(systemState('shop'));
    const defaults = slice.parse();
    expect(placeFolders(defaults.HARNESS_SYSTEM_STATE, defaults)).toEqual({ dataDir: resolve('.harness/systems/shop/data'), cacheDir: resolve('.harness/systems/shop/cache') });
    slice.set({ [SYSTEM_ENV.data]: 'hub/shop/laptop/data', [SYSTEM_ENV.cache]: 'hub/shop/laptop/cache' });
    const named = slice.parse();
    expect(placeFolders(named.HARNESS_SYSTEM_STATE, named)).toEqual({ dataDir: resolve('hub/shop/laptop/data'), cacheDir: resolve('hub/shop/laptop/cache') });
  });

  it('are read under the same names, with the same checks, by the SDK and by each system', () => {
    const slice = env({ ...systemFields() });
    slice.set({ [SYSTEM_ENV.data]: '' });
    expect(() => slice.parse()).toThrow();
    expect(sdkEnv.get(SYSTEM_ENV.instance)).toBe('main');
  });
});
