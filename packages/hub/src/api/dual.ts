/**
 * One port, both protocols: a small TCP server peeks at the first byte of each connection (a TLS hello starts 0x16)
 * and hands it to the plain HTTP server or the HTTPS one, so `http://` links keep working while `https://` (and `wss://`
 * for the live socket) works on the same port. HTTPS follows its source: switched on or off without a restart (read for
 * each new TLS connection), and the certificate looked at again at most once a minute (or on `refresh`), so a renewed
 * or remade one is used without a restart. A TLS connection while HTTPS is off is dropped.
 *
 * Ported from hitloop's `dualServer` (`src/hub/tls.ts`), with a `setup` hook so the hub routes WebSocket upgrades on
 * both sides.
 */
import { createServer as createHttpServer, type RequestListener, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import type { KeyPair } from './tls.ts';

/** Where HTTPS's switch and certificate come from. */
export interface TlsSource {
  /** Answer HTTPS now? Read on each new TLS connection, so switching needs no restart. */
  enabled(): boolean;
  /** The key and certificate (made, or made again, as needed); undefined when there is none to use. */
  material(): KeyPair | undefined;
}

/** The two sides and the port they share. */
export interface DualServer {
  /** The server to listen with. */
  readonly server: NetServer;
  /** Plain HTTP. */
  readonly http: HttpServer;
  /** The HTTPS side, once a TLS connection came while HTTPS was on. */
  https(): HttpsServer | undefined;
  /** Look at the certificate again on the next TLS connection (an address changed). */
  refresh(): void;
  /** Close every open connection on both sides. */
  closeAllConnections(): void;
}

/** How often the certificate is looked at again. */
const RECHECK = 60_000;

/** A server answering HTTP and HTTPS on one port; `setup` runs on each side when it is made (to route upgrades). */
export function dualServer(handler: RequestListener, tls: TlsSource | undefined, setup: (server: HttpServer | HttpsServer) => void = () => undefined, clock: () => number = Date.now): DualServer {
  const plain = createHttpServer(handler);
  setup(plain);
  let secure: HttpsServer | undefined;
  let cert = '';
  let checked = Number.NEGATIVE_INFINITY;
  const secureSide = (): HttpsServer | undefined => {
    if (tls?.enabled() !== true) { return undefined; }
    if (secure !== undefined && clock() - checked < RECHECK) { return secure; }
    try {
      const material = tls.material();
      checked = clock();
      if (material === undefined) { return secure; }
      if (secure === undefined) {
        secure = createHttpsServer({ key: material.key, cert: material.cert }, handler);
        setup(secure);
      } else if (material.cert !== cert) {
        secure.setSecureContext({ key: material.key, cert: material.cert });
      }
      cert = material.cert;
    } catch {
      // keep the old certificate, if there is one
    }
    return secure;
  };
  const sockets = new Set<Socket>();
  const front = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); });
    socket.on('error', () => { socket.destroy(); });
    socket.once('data', (first: Buffer) => {
      socket.pause();
      socket.unshift(first);
      const side = first[0] === 0x16 ? secureSide() : plain;
      if (side === undefined) { socket.destroy(); return; }
      side.emit('connection', socket);
      process.nextTick(() => { socket.resume(); });
    });
  });
  front.on('close', () => {
    plain.close();
    secure?.close();
  });
  return {
    server: front,
    http: plain,
    https: () => secure,
    refresh: () => { checked = Number.NEGATIVE_INFINITY; },
    closeAllConnections: () => {
      plain.closeAllConnections();
      secure?.closeAllConnections();
      // connections that never sent a byte belong to neither side yet
      for (const socket of sockets) { socket.destroy(); }
    },
  };
}
