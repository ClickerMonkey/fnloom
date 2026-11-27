/**
 * One port, both protocols: plain http and https answered on the same port by the first byte, https switched on and
 * off with no restart, and a new certificate picked up on refresh.
 */
import { X509Certificate } from 'node:crypto';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { connect, type PeerCertificate } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { dualServer, type DualServer } from './dual.ts';
import { makeAuthority, makeHubCertificate, wantedAddresses, type KeyPair } from './tls.ts';

const ca = makeAuthority('testhost');
const leaf = (): KeyPair => makeHubCertificate(ca, wantedAddresses('testhost', []));

let open: DualServer | undefined;
afterEach(async () => {
  const dual = open;
  open = undefined;
  if (dual === undefined) { return; }
  dual.closeAllConnections();
  await new Promise<void>((resolve) => { dual.server.close(() => { resolve(); }); });
});

async function serve(tls: { on: boolean; material: KeyPair }): Promise<number> {
  const dual = dualServer((req, res) => {
    const secure = 'encrypted' in req.socket && req.socket.encrypted;
    res.end(`${secure ? 'https' : 'http'} ${req.url ?? ''}`);
  }, { enabled: () => tls.on, material: () => tls.material });
  open = dual;
  await new Promise<void>((resolve) => { dual.server.listen(0, '127.0.0.1', () => { resolve(); }); });
  const address = dual.server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

const read = (port: number, secure: boolean, path = '/'): Promise<string> => new Promise((resolve, reject) => {
  const done = (res: IncomingMessage): void => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => { body += chunk; });
    res.on('end', () => { resolve(body); });
  };
  const req = secure ? httpsGet({ host: '127.0.0.1', port, path, ca: ca.cert, servername: 'localhost', agent: false }, done) : httpGet({ host: '127.0.0.1', port, path, agent: false }, done);
  req.on('error', reject);
});

/** The certificate the port presents to a TLS client. */
const presented = (port: number): Promise<PeerCertificate> => new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port, ca: ca.cert, servername: 'localhost' }, () => { resolve(socket.getPeerCertificate()); socket.end(); });
  socket.on('error', reject);
});

describe('the dual server', () => {
  it('answers http and https on one port, trusted through the authority', async () => {
    const port = await serve({ on: true, material: leaf() });
    expect(await read(port, false, '/plain')).toBe('http /plain');
    expect(await read(port, true, '/secure')).toBe('https /secure');
  });

  it('drops TLS while https is off and answers it once on, with no restart', async () => {
    const tls = { on: false, material: leaf() };
    const port = await serve(tls);
    await expect(read(port, true)).rejects.toThrow();
    expect(await read(port, false)).toBe('http /');
    tls.on = true;
    expect(await read(port, true)).toBe('https /');
  });

  it('serves a new certificate after a refresh', async () => {
    const tls = { on: true, material: leaf() };
    const port = await serve(tls);
    const first = (await presented(port)).fingerprint256;
    expect(first).toBe(new X509Certificate(tls.material.cert).fingerprint256);
    tls.material = leaf();
    // looked at again at most once a minute, or at once after a refresh
    expect((await presented(port)).fingerprint256).toBe(first);
    open?.refresh();
    expect((await presented(port)).fingerprint256).toBe(new X509Certificate(tls.material.cert).fingerprint256);
  });
});
