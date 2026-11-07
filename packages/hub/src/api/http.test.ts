import { endpoint, implement, server, spec } from '@ayepi/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { signJwt } from '@ayepi/auth/server';
import { accessTokenExpiry } from '../boot/start.ts';
import { ACCESS_TOKEN } from './auth.ts';
import { HttpFront } from './http.ts';
import { quietLog, TEST_KEYS } from './testing/rig.ts';

const ping = spec({ endpoints: { ping: endpoint({ method: 'GET', response: z.object({ pong: z.boolean() }) }) } });
const fronts: HttpFront[] = [];
afterEach(async () => { for (const front of fronts.splice(0)) { await front.close(); } });

async function start(options: { expiry?: number; ready?: boolean } = {}) {
  const web = server(ping, [implement(ping).handlers({ ping: () => ({ pong: true }) })]);
  const front = new HttpFront({
    web, link: server(spec({ endpoints: {} }), []), files: [], heartbeat: 60_000, tokenMargin: 0, clock: Date.now, log: quietLog().log,
    health: { live: () => true, ready: () => options.ready ?? true },
    tokenExpiry: (token) => (token === 'good' && options.expiry !== undefined ? Date.now() + options.expiry : undefined),
  });
  fronts.push(front);
  const port = await front.listen(0, '0.0.0.0');
  return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

describe('HttpFront', () => {
  it('serves the web API under /api only', async () => {
    const { http } = await start();
    await expect((await fetch(`${http}/api/ping`)).json()).resolves.toEqual({ pong: true });
    expect((await fetch(`${http}/ping`)).status).toBe(404);
  });

  it('answers health checks from the lifecycle', async () => {
    const { http } = await start({ ready: false });
    expect((await fetch(`${http}/healthz`)).status).toBe(200);
    expect((await fetch(`${http}/readyz`)).status).toBe(503);
  });

  it('closes a browser socket when its token is about to expire, and leaves one without a token open', async () => {
    const { ws } = await start({ expiry: 50 });
    const closedAfter = await new Promise<number>((resolve, reject) => {
      const opened = Date.now();
      const socket = new WebSocket(`${ws}/ws?access_token=good`);
      socket.onclose = () => { resolve(Date.now() - opened); };
      socket.onerror = () => { reject(new Error('socket failed')); };
    });
    expect(closedAfter).toBeLessThan(5_000);
    const stillOpen = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`${ws}/ws`);
      socket.onopen = () => { setTimeout(() => { resolve(socket.readyState === WebSocket.OPEN); socket.close(); }, 150); };
      socket.onerror = () => { resolve(false); };
    });
    expect(stillOpen).toBe(true);
  });
});

describe('accessTokenExpiry', () => {
  it('reads the expiry of the hub’s own tokens only', () => {
    const { token, payload } = signJwt({ actor: 'a' }, { secret: TEST_KEYS.jwtSecret, expiresIn: 60, ...ACCESS_TOKEN });
    expect(accessTokenExpiry(token, TEST_KEYS.jwtSecret)).toBe((payload.exp ?? 0) * 1000);
    expect(accessTokenExpiry(token, 'another-secret-another-secret-0123456789')).toBeUndefined();
    expect(accessTokenExpiry('not a token', TEST_KEYS.jwtSecret)).toBeUndefined();
  });
});
