import { describe, expect, it } from 'vitest';
import { recoverAndReconnect } from './client.ts';

/** The refusal retry itself is ayepi's (`client({ unauthorized })`, tested there); this is harness's part of it. */
describe('recoverAndReconnect', () => {
  it('reopens the socket only when the tab signed in again, and passes the answer on', async () => {
    let reconnects = 0;
    const socket = { reconnect: () => { reconnects += 1; } };
    expect(await recoverAndReconnect(() => Promise.resolve(true), socket)).toBe(true);
    expect(reconnects).toBe(1);
    expect(await recoverAndReconnect(() => Promise.resolve(false), socket)).toBe(false);
    expect(reconnects).toBe(1);
  });
});
