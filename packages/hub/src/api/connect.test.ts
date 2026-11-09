import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SystemName } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallbackAnswer } from '../connections/index.ts';
import { ConnectCallbackRoute } from './connect.ts';

let server: Server | undefined;
afterEach(async () => { await new Promise((done) => { if (server === undefined) { done(undefined); } else { server.close(done); } }); server = undefined; });

/** Serve the route on a free port; each request answers `answer`, and the params the service got are kept. */
async function serving(answer: CallbackAnswer | Error) {
  const seen: Array<Readonly<Record<string, string>>> = [];
  const cookies: Array<Readonly<Record<string, string>>> = [];
  const route = new ConnectCallbackRoute(() => ({
    callback: (params, jar) => { seen.push(params); cookies.push(jar); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer); },
  }));
  server = createServer((req, res) => {
    void route.serve(req, res, new URL(req.url ?? '/', 'http://hub').pathname).then((served) => { if (!served) res.writeHead(404).end(); });
  });
  await new Promise<void>((done) => { server?.listen(0, '0.0.0.0', done); });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? (address satisfies AddressInfo).port : 0;
  const get = (path: string, method = 'GET', cookie?: string) => fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'manual', ...(cookie === undefined ? {} : { headers: { cookie } }) });
  return { seen, cookies, get };
}

describe('the connect callback', () => {
  it('hands the provider\'s params to the connections module and sends the person to the system\'s page', async () => {
    const ok = await serving({ system: SystemName.parse('cal') });
    const done = await ok.get('/connect/callback?state=s1&code=c1');
    expect([done.status, done.headers.get('location')]).toEqual([302, '/connect/cal']);
    expect(ok.seen).toEqual([{ state: 's1', code: 'c1' }]);
    expect((await ok.get('/connect/cal')).status).toBe(404);
    expect((await ok.get('/connect/callback', 'POST')).status).toBe(404);
  });

  it('carries the problem back to the page', async () => {
    const failed = await serving({ system: SystemName.parse('cal'), problem: 'You said no.' });
    expect((await failed.get('/connect/callback?state=s2')).headers.get('location')).toBe('/connect/cal?problem=You+said+no.');
  });

  it('hands over the browser cookies over and clears the used binding', async () => {
    const ok = await serving({ system: SystemName.parse('cal'), clear: 'harness_connect_c1' });
    const done = await ok.get('/connect/callback?state=s3&code=c', 'GET', 'harness_connect_c1=abc%3D; other=x');
    expect(ok.cookies).toEqual([{ harness_connect_c1: 'abc=', other: 'x' }]);
    expect(done.headers.get('set-cookie')).toBe('harness_connect_c1=; Path=/connect/callback; Max-Age=0; HttpOnly; SameSite=Lax');
  });

  it('sends the person home with the problem when finishing throws', async () => {
    const failed = await serving(new Error('The row went.'));
    expect((await failed.get('/connect/callback?state=s4')).headers.get('location')).toBe('/?problem=The+row+went.');
  });
});
