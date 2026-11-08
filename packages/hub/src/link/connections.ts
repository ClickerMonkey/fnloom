/**
 * The connected systems, on ayepi peers. Every `/link` socket gets a `Peer<SystemLinkSpec>` (the hub's typed caller
 * of what the system serves) from the `Peers` registry handed to the hub link server. A socket becomes an instance's
 * connection once the handshake proves its key; until then it has no session and the `linkSession` guard refuses
 * everything but the handshake. A system may have many instances connected at once (a fleet); a newer connection of
 * the same instance replaces the older one, and leaves the other instances alone.
 */
import { peers, type Peer, type Peers, type WsConn } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { MAIN_INSTANCE, instanceLabel, systemLinkSpec, type InstanceName, type InstanceRef, type LinkSession, type StopReason, type SystemLinkSpec, type SystemName } from '@harness/core';
import type { ConnectionChange, LinkService, SystemConnection } from './index.ts';
import { messageOf } from '../catalog/scope.ts';

/** The link service over a `Peers` registry. */
export class PeerLinkService implements LinkService {
  /** The registry to pass to the hub link server as `peers`. */
  readonly peers: Peers<SystemLinkSpec>;
  readonly #log: Logger;
  readonly #clock: () => number;
  readonly #sessions = new Map<WsConn, LinkSession>();
  /** Connections by `system@instance`. */
  readonly #connections = new Map<string, SystemConnection>();
  readonly #listeners = new Set<(change: ConnectionChange) => void>();

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

  /** The handshake proved who is on `conn`: it is now that instance's connection. */
  establish(conn: WsConn, session: LinkSession): SystemConnection {
    const peer = this.peers.of(conn);
    const key = instanceLabel(session);
    const previous = this.#connections.get(key);
    const fields = { system: session.system, instance: session.instance, boot: session.boot };
    if (previous !== undefined && previous.peer.conn !== conn) {
      this.#sessions.delete(previous.peer.conn);
      this.#log.info('link.replaced', { ...fields, previous: previous.boot });
    }
    const connection: SystemConnection = { ...fields, connectedAt: this.#clock(), peer, signal: peer.signal };
    this.#sessions.set(conn, session);
    this.#connections.set(key, connection);
    this.#log.info('link.connected', fields);
    this.#emit({ system: session.system, instance: session.instance, connected: true });
    return connection;
  }

  connection(system: SystemName, instance?: InstanceName): SystemConnection | undefined {
    if (instance !== undefined) { return this.#open(this.#connections.get(instanceLabel({ system, instance }))); }
    const all = this.connections(system);
    return all.find((c) => c.instance === MAIN_INSTANCE) ?? all[0];
  }

  connections(system: SystemName): readonly SystemConnection[] {
    return this.connected().filter((c) => c.system === system).sort((a, b) => a.connectedAt - b.connectedAt);
  }

  connected(): readonly SystemConnection[] {
    return [...this.#connections.values()].filter((c) => c.peer.open);
  }

  whenConnected(system: SystemName, signal?: AbortSignal, instance?: InstanceName): Promise<SystemConnection> {
    const now = this.connection(system, instance);
    if (now !== undefined) { return Promise.resolve(now); }
    const label = instance === undefined ? system : instanceLabel({ system, instance });
    const stopped = (): Error => (signal?.reason instanceof Error ? signal.reason : new Error(`stopped waiting for ${label}`));
    if (signal?.aborted === true) { return Promise.reject(stopped()); }
    return new Promise((resolve, reject) => {
      const aborted = (): void => {
        stop();
        reject(stopped());
      };
      const stop = this.onChange((change) => {
        const connection = change.connected && change.system === system ? this.connection(system, instance) : undefined;
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
        this.#log.warn('link.stop.failed', { system: connection.system, instance: connection.instance, reason, error: messageOf(error) });
      }
    }));
  }

  onChange(listener: (change: ConnectionChange) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #open(connection: SystemConnection | undefined): SystemConnection | undefined {
    return connection?.peer.open === true ? connection : undefined;
  }

  #closed(conn: WsConn): void {
    const session = this.#sessions.get(conn);
    this.#sessions.delete(conn);
    const key = session === undefined ? undefined : instanceLabel(session);
    if (session === undefined || key === undefined || this.#connections.get(key)?.peer.conn !== conn) { return; }
    this.#connections.delete(key);
    this.#log.info('link.disconnected', { system: session.system, instance: session.instance, boot: session.boot });
    this.#emit({ system: session.system, instance: session.instance, connected: false });
  }

  #emit(change: ConnectionChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#log.error('link.listener.failed', { system: change.system, instance: change.instance, error: messageOf(error) });
      }
    }
  }
}

/** The instance ref of a connection. */
export function refOf(connection: Pick<SystemConnection, 'system' | 'instance'>): InstanceRef {
  return { system: connection.system, instance: connection.instance };
}
