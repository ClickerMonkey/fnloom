/**
 * M8: `/link` before the handshake, on the hub's real HTTP front. A message over the frame limit closes the socket
 * (the browser socket's too), an address can hold only so many sockets that haven't finished the handshake (and all
 * addresses together only so many), and a socket that never says hello is closed and stops counting.
 */
import { peers, server, spec, type Peer, type WsConn } from '@ayepi/core';
import { remoteAddress } from '@ayepi/node';
import { systemLinkSpec, type SystemLinkSpec } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpFront } from '../api/http.ts';
import { memoryLog } from '../testing.ts';
import { HANDSHAKE_TIMEOUT_CODE, LinkGate, type LinkGateOptions } from './gate.ts';

const fronts: HttpFront[] = [];
afterEach(async () => { for (const front of fronts.splice(0)) { await front.close(); } });

/** The front with a link server whose sockets the gate counts; every socket comes from 127.0.0.1. */
async function start(limits: Partial<Pick<LinkGateOptions, 'perAddress' | 'total' | 'helloTimeout' | 'linkTimeout'>> = {}) {
  const registry = peers(systemLinkSpec);
  const gate = new LinkGate({
    log: memoryLog().log, peers: registry, address: (req) => Promise.resolve(remoteAddress(req) ?? 'unknown'),
    perAddress: 2, total: 10, helloTimeout: 60_000, linkTimeout: 60_000, ...limits,
  });
  const front = new HttpFront({
    web: server(spec({ endpoints: {} }), []), link: server(spec({ endpoints: {} }), [], { peers: registry }), files: [], heartbeat: 60_000,
    mcp: { fetch: () => Promise.resolve(new Response(null, { status: 404 })) }, tokenMargin: 0, clock: Date.now, log: memoryLog().log,
    health: { live: () => true, ready: () => true }, tokenExpiry: () => undefined,
    maxMessage: { browser: 1_024, link: 2_048 }, linkGate: gate,
  });
  fronts.push(front);
  const port = await front.listen(0, '127.0.0.1');
  return { gate, url: `ws://127.0.0.1:${port}` };
}

/** Open a socket; resolves once it is open, or with the HTTP status it was refused with. */
function open(url: string): Promise<WebSocket | number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.onopen = () => { resolve(socket); };
    // the WHATWG socket hides the status: a refused upgrade is an error before it opens
    socket.onerror = () => { resolve(429); };
  });
}

/** Resolve with the code a socket closes with. */
function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => { socket.onclose = (event) => { resolve(event.code); }; });
}

describe('the link door', () => {
  it('closes a socket that sends more than the frame limit, on /link and on /ws', async () => {
    const { url } = await start();
    for (const [path, size] of [['/link', 3_000], ['/ws', 2_000]] as const) {
      const socket = await open(`${url}${path}`);
      if (typeof socket === 'number') { throw new Error(`${path} refused`); }
      const code = closed(socket);
      socket.send('x'.repeat(size));
      expect(await code).toBe(1009);
    }
  });

  it('refuses a third socket from one address until one of the first two closes', async () => {
    const { url, gate } = await start({ perAddress: 2 });
    const first = await open(`${url}/link`);
    const second = await open(`${url}/link`);
    expect(typeof first).not.toBe('number');
    expect(typeof second).not.toBe('number');
    expect(await open(`${url}/link`)).toBe(429);
    expect(gate.waiting('127.0.0.1')).toBe(2);
    if (typeof first === 'number') { throw new Error('refused'); }
    const gone = closed(first);
    first.close();
    await gone;
    await until(() => gate.waiting() === 1);
    expect(typeof await open(`${url}/link`)).not.toBe('number');
  });

  it('refuses past the total, whatever the address', async () => {
    const { url } = await start({ perAddress: 5, total: 1 });
    expect(typeof await open(`${url}/link`)).not.toBe('number');
    expect(await open(`${url}/link`)).toBe(429);
  });

  it('counts every address of one IPv6 /64 as one address, so changing address gets no more sockets', async () => {
    const from: string[] = ['2001:db8:1:2::a', '2001:DB8:1:2:0:0:0:b', '2001:db8:1:2:ffff::c', '2001:db8:1:3::1'];
    const gate = new LinkGate({
      log: memoryLog().log, peers: peers(systemLinkSpec), address: () => Promise.resolve(from.shift() ?? 'unknown'),
      perAddress: 2, total: 10, helloTimeout: 60_000, linkTimeout: 60_000,
    });
    expect(await gate.admit(new Request('http://hub/link'))).toBe(true);
    expect(await gate.admit(new Request('http://hub/link'))).toBe(true);
    // a third address in the same /64 is the same home
    expect(await gate.admit(new Request('http://hub/link'))).toBe(false);
    // the next /64 is someone else
    expect(await gate.admit(new Request('http://hub/link'))).toBe(true);
  });

  it('closes a socket that never says hello, which then stops counting', async () => {
    const { url, gate } = await start({ helloTimeout: 1_000 });
    const silent = await open(`${url}/link`);
    if (typeof silent === 'number') { throw new Error('refused'); }
    expect(await closed(silent)).toBe(HANDSHAKE_TIMEOUT_CODE);
    await until(() => gate.waiting() === 0);
  });
});

describe('the gate', () => {
  /** A gate over a fake registry, with sockets made by hand. */
  function fakeGate() {
    const opened = new Set<(peer: Peer<SystemLinkSpec>) => void>();
    const shut = new Set<(peer: Peer<SystemLinkSpec>) => void>();
    const gate = new LinkGate({
      log: memoryLog().log, peers: { onOpen: (l) => { opened.add(l); return () => undefined; }, onClose: (l) => { shut.add(l); return () => undefined; } },
      address: () => Promise.resolve('10.0.0.9'), perAddress: 5, total: 5, helloTimeout: 30, linkTimeout: 200,
    });
    const closes: number[] = [];
    gate.bind((_conn, code) => { closes.push(code); });
    const socket = async (): Promise<WsConn> => {
      const req = new Request('http://hub/link');
      expect(await gate.admit(req)).toBe(true);
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the gate reads only conn.req
      const conn = { req } as WsConn;
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the gate reads only peer.conn
      for (const listener of opened) { listener({ conn } as Peer<SystemLinkSpec>); }
      return conn;
    };
    return { gate, closes, socket };
  }

  it('gives a socket that said hello until the link timeout, and stops counting one that is linked', async () => {
    const { gate, closes, socket } = fakeGate();
    const helloed = await socket();
    gate.helloed(helloed);
    const linked = await socket();
    gate.helloed(linked);
    gate.linked(linked);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // past the hello timeout: the one that said hello still waits, the linked one doesn't count
    expect(closes).toEqual([]);
    expect(gate.waiting()).toBe(1);
    await until(() => closes.length === 1);
    expect(closes).toEqual([HANDSHAKE_TIMEOUT_CODE]);
    expect(gate.waiting()).toBe(0);
  });

  it('gives no more time to a socket that keeps saying hello without being linked', async () => {
    const { gate, closes, socket } = fakeGate();
    const conn = await socket();
    const started = Date.now();
    gate.helloed(conn);
    // the attack: a socket holds its slot for good by saying hello again before each deadline
    const again = setInterval(() => { gate.helloed(conn); }, 50);
    try {
      await until(() => closes.length === 1);
    } finally {
      clearInterval(again);
    }
    expect(closes).toEqual([HANDSHAKE_TIMEOUT_CODE]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(gate.waiting()).toBe(0);
  });
});

/** Wait until a check holds (a socket's close reaches the server a moment after the client's). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) { await new Promise((resolve) => setTimeout(resolve, 10)); }
  expect(check()).toBe(true);
}
