import { env } from '@ayepi/env';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SYSTEM_ENV, systemFields } from './env.ts';

describe('a system\'s link variables', () => {
  it('reads the hub, state folder and pairing token under the names the hub sets, with defaults by system', () => {
    const slice = env({ ...systemFields('shop'), SHOP_TIMEOUT: z.number().default(5) });
    expect(slice.get('HARNESS_SYSTEM_STATE')).toBe('.harness/systems/shop');
    expect(slice.get('SHOP_TIMEOUT')).toBe(5);
    slice.set({ [SYSTEM_ENV.hub]: 'ws://hub/link', [SYSTEM_ENV.pairingToken]: 'tok' });
    expect(slice.parse()).toMatchObject({ HARNESS_HUB: 'ws://hub/link', HARNESS_PAIRING_TOKEN: 'tok' });
  });
});
