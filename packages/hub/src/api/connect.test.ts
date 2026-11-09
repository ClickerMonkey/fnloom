import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SystemName } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallbackAnswer } from '../connections/index.ts';
import { ConnectCallbackRoute } from './connect.ts';

let server: Server | undefined;
afterEach(async () => { await new Promise((done) => { if (server === undefined) { done(undefined); } else { server.close(done); } }); server = undefined; });

/** Serve the route on a free port; each request answers `answer`, and the params the service got are kept. */
async function serving(answer: CallbackAnswer) {
  const seen: Array<Readonly<Record<string, string>>> = [];
  const route = new ConnectCallbackRoute(() => ({ callback: (params) => { seen.push(params); return Promise.resolve(answer); } }));
  server = createServer((req, res) => {
    void route.serve(req, res, new URL(req.url ?? '/', 'http://hub').pathname).then((served) => { if (!served) res.writeHead(404).end(); });
  });
  await new Promise<void>((done) => { server?.listen(0, '0.0.0.0', done); });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? (address satisfies AddressInfo).port : 0;
  const get = (path: string, method = 'GET') => fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'manual' });
  return { seen, get };
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
});
