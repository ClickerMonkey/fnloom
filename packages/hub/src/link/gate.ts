/**
 * The door of `/link`: how many sockets that haven't finished the handshake the hub keeps open, and for how long.
 * Before the handshake anyone on the network can open a socket, so an upgrade is refused (`429`) once its address
 * (`clientAddress`, by the admin's proxy setting) has `perAddress` such sockets open, or every address together has
 * `total`. A socket must say hello within `helloTimeout`; one that said hello must be linked (its key proved, or its
 * pairing approved and proved) within `linkTimeout`, or it is closed. A socket stops counting once it is linked.
 *
 * `admit` is `@ayepi/node`'s upgrade check; `bind` gets the handler's way to close a socket, as the front makes it.
 */
import type { Peers, WsConn } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import type { SystemLinkSpec } from '@harness/core';
import { limitKey } from '../api/client-address.ts';

/** The close code a socket gets when it took too long to say hello or to be linked. */
export const HANDSHAKE_TIMEOUT_CODE = 4008;

/** What the gate needs. */
export interface LinkGateOptions {
  readonly log: Logger;
  /** The registry of the link server's sockets, to see each one open and close. */
  readonly peers: Pick<Peers<SystemLinkSpec>, 'onOpen' | 'onClose'>;
  /** Where an upgrade comes from (`clientAddress`). */
  readonly address: (req: Request) => Promise<string>;
  /** Most sockets from one address that haven't finished the handshake. */
  readonly perAddress: number;
  /** Most such sockets from every address together. */
  readonly total: number;
  /** How long a socket has to say hello. */
  readonly helloTimeout: number;
  /** How long a socket that said hello has to be linked (a pairing waits for an admin this long). */
  readonly linkTimeout: number;
}

/** A socket admitted and not yet linked. */
interface Waiting {
  readonly address: string;
  conn?: WsConn;
  timer: NodeJS.Timeout;
  /** Whether it said hello: its time to be linked then runs from the first hello, never from a later one. */
  helloed?: boolean;
}

/** The sockets of `/link` that haven't finished the handshake, counted and timed. */
export class LinkGate {
  readonly #options: LinkGateOptions;
  /** By the upgrade `Request`, which is also the socket's `conn.req`. */
  readonly #waiting = new Map<Request, Waiting>();
  #close: (conn: WsConn, code: number, reason: string) => void = () => undefined;

  constructor(options: LinkGateOptions) {
    this.#options = options;
    options.peers.onOpen((peer) => {
      const waiting = this.#waiting.get(peer.conn.req);
      if (waiting !== undefined) { waiting.conn = peer.conn; }
    });
    options.peers.onClose((peer) => { this.#release(peer.conn.req); });
  }

  /** How many sockets wait: from one address, or in all. */
  waiting(address?: string): number {
    if (address === undefined) { return this.#waiting.size; }
    let count = 0;
    for (const entry of this.#waiting.values()) { if (entry.address === address) { count++; } }
    return count;
  }

  /** Whether to take an upgrade; a taken one counts until it is linked or closes. */
  readonly admit = async (req: Request): Promise<boolean> => {
    const { perAddress, total, helloTimeout, log } = this.#options;
    const address = limitKey(await this.#options.address(req));
    if (this.#waiting.size >= total || this.waiting(address) >= perAddress) {
      log.warn('link.socket.refused', { address, waiting: this.waiting(address), total: this.#waiting.size });
      return false;
    }
    this.#waiting.set(req, { address, timer: this.#timer(req, helloTimeout, 'say hello sooner') });
    return true;
  };

  /** The front's way to close one of the link's sockets. */
  bind(close: (conn: WsConn, code: number, reason: string) => void): void {
    this.#close = close;
  }

  /** A socket said hello: it now has until `linkTimeout` from its first hello to be linked (saying it again buys no time). */
  helloed(conn: WsConn): void {
    const waiting = this.#waiting.get(conn.req);
    if (waiting === undefined || waiting.helloed === true) { return; }
    waiting.helloed = true;
    clearTimeout(waiting.timer);
    waiting.timer = this.#timer(conn.req, this.#options.linkTimeout, 'finish pairing sooner');
  }

  /** A socket proved its key: it no longer counts. */
  linked(conn: WsConn): void {
    this.#release(conn.req);
  }

  #timer(req: Request, ms: number, reason: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const waiting = this.#waiting.get(req);
      this.#release(req);
      if (waiting?.conn === undefined) { return; }
      this.#options.log.info('link.socket.timed-out', { address: waiting.address, reason });
      this.#close(waiting.conn, HANDSHAKE_TIMEOUT_CODE, reason);
    }, ms);
    timer.unref();
    return timer;
  }

  #release(req: Request): void {
    const waiting = this.#waiting.get(req);
    if (waiting === undefined) { return; }
    clearTimeout(waiting.timer);
    this.#waiting.delete(req);
  }
}
