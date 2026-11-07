/**
 * The connected systems, on ayepi peers. Every `/link` socket gets a `Peer<SystemLinkSpec>` (the hub's typed caller
 * of what the system serves) from the `Peers` registry handed to the hub link server. A socket becomes a system's
 * connection once the handshake proves its key; until then it has no session and the `linkSession` guard refuses
 * everything but `hello` and `prove`. A newer connection of the same system replaces the older one.
 */
import { peers, type Peer, type Peers, type WsConn } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { systemLinkSpec, type LinkSession, type StopReason, type SystemLinkSpec, type SystemName } from '@harness/core';
import type { LinkService, SystemConnection } from './index.ts';
import { messageOf } from '../catalog/scope.ts';

/** A change in who is connected. */
type Change = { system: SystemName; connected: boolean };

/** The link service over a `Peers` registry. */
export class PeerLinkService implements LinkService {
  /** The registry to pass to the hub link server as `peers`. */
  readonly peers: Peers<SystemLinkSpec>;
  readonly #log: Logger;
  readonly #clock: () => number;
  readonly #sessions = new Map<WsConn, LinkSession>();
  readonly #connections = new Map<SystemName, SystemConnection>();
  readonly #listeners = new Set<(change: Change) => void>();

  constructor(options: { log: Logger; clock: () => number; peers?: Peers<SystemLinkSpec> }) {
    this.#log = options.log;
    this.#clock = options.clock;
    this.peers = options.peers ?? peers(systemLinkSpec);
    this.peers.onClose((peer) => { this.#closed(peer.conn); });
  }

  /** The session of a socket that finished the handshake. */
  session(conn: WsConn): LinkSession | undefined {
    return this.#sessions.get(conn);
  }

  /** The peer of an open socket (before or after the handshake). */
  peer(conn: WsConn): Peer<SystemLinkSpec> | undefined {
    return this.peers.get(conn);
  }

  /** The handshake proved who is on `conn`: it is now that system's connection. */
  establish(conn: WsConn, session: LinkSession): SystemConnection {
    const peer = this.peers.of(conn);
    const previous = this.#connections.get(session.system);
    if (previous !== undefined && previous.peer.conn !== conn) {
      this.#sessions.delete(previous.peer.conn);
      this.#log.info('link.replaced', { system: session.system, instance: previous.instance, by: session.instance });
    }
    const connection: SystemConnection = { system: session.system, instance: session.instance, connectedAt: this.#clock(), peer, signal: peer.signal };
    this.#sessions.set(conn, session);
    this.#connections.set(session.system, connection);
    this.#log.info('link.connected', { system: session.system, instance: session.instance });
    this.#emit({ system: session.system, connected: true });
    return connection;
  }

  connection(system: SystemName): SystemConnection | undefined {
    const connection = this.#connections.get(system);
    return connection?.peer.open === true ? connection : undefined;
  }

  connected(): readonly SystemConnection[] {
    return [...this.#connections.values()].filter((c) => c.peer.open);
  }

  whenConnected(system: SystemName, signal?: AbortSignal): Promise<SystemConnection> {
    const now = this.connection(system);
    if (now !== undefined) { return Promise.resolve(now); }
    const stopped = (): Error => (signal?.reason instanceof Error ? signal.reason : new Error(`stopped waiting for ${system}`));
    if (signal?.aborted === true) { return Promise.reject(stopped()); }
    return new Promise((resolve, reject) => {
      const aborted = (): void => {
        stop();
        reject(stopped());
      };
      const stop = this.onChange((change) => {
        const connection = change.connected && change.system === system ? this.connection(system) : undefined;
        if (connection === undefined) { return; }
        stop();
        signal?.removeEventListener('abort', aborted);
        resolve(connection);
      });
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  async stopAll(reason: StopReason, timeout: number): Promise<void> {
    await Promise.allSettled(this.connected().map(async (connection) => {
      try {
        await connection.peer.call('stop', { reason, timeout }, { signal: AbortSignal.timeout(timeout) });
      } catch (error) {
        this.#log.warn('link.stop.failed', { system: connection.system, reason, error: messageOf(error) });
      }
    }));
  }

  onChange(listener: (change: Change) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #closed(conn: WsConn): void {
    const session = this.#sessions.get(conn);
    this.#sessions.delete(conn);
    if (session === undefined || this.#connections.get(session.system)?.peer.conn !== conn) { return; }
    this.#connections.delete(session.system);
    this.#log.info('link.disconnected', { system: session.system, instance: session.instance });
    this.#emit({ system: session.system, connected: false });
  }

  #emit(change: Change): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error('link.listener.failed', { system: change.system, error: messageOf(error) });
      }
    }
  }
}
