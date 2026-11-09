/**
 * The connections module (build 4): per-person systems. A system that declares `connect` gets a page for every
 * person once an admin has configured it; each person connects their own account (OAuth through the hub's
 * `/connect/callback`, or a form), and that system's per-person fns then act as them. Credentials are a secret owned
 * by the person, sent only on the runs that act as that connection, and replaced when the system refreshes them.
 *
 * Owner: the hub lane. `StoreConnectionService` (`connections/service.ts`) implements `ConnectionService`.
 */
import type {
  ActorId, ConnectionChange, ConnectionId, ConnectionUpdate, ConnectionView, ConnectPage, Json, RunConnection, SystemName, UserConnection,
} from '@harness/core';
import type { ConnectionGate } from '../access/index.ts';

/** Where the redirect sends the person back to (`/connect/<system>`), with the problem when it failed. */
export interface CallbackAnswer {
  readonly system: SystemName | undefined;
  readonly problem?: string | undefined;
}

/** Per-person connections. */
export interface ConnectionService {
  /** Every `connect` system's page, with the asker's own connections to it. */
  pages(asker: ActorId): Promise<ConnectPage[]>;
  /** Begin connecting: the provider's URL to send the person to (OAuth), or the finished connection (a form). */
  connect(asker: ActorId, system: SystemName, form?: Json): Promise<{ url: string } | { connection: ConnectionView }>;
  /** The provider sent the person back to `/connect/callback` with these query params. */
  callback(params: Readonly<Record<string, string>>): Promise<CallbackAnswer>;
  /** Change the asker's own connection's settings, fn switches or sharing. */
  update(asker: ActorId, change: ConnectionChange): Promise<ConnectionView>;
  /** End the asker's own connection: the system revokes it where it can, then its secret and row go. */
  disconnect(asker: ActorId, connection: ConnectionId): Promise<boolean>;
  /** A system sent refreshed credentials, or said they can't be refreshed (`connectionUpdate`). */
  refreshed(system: SystemName, update: ConnectionUpdate): Promise<void>;
  /** How a person's per-person fns stand: their own connection, else the newest one shared with them. */
  gate(actor: ActorId, groups: ReadonlySet<ActorId>): Promise<ConnectionGate>;
  /** What a run acting as a connection carries: its credentials revealed. */
  forRun(connection: UserConnection): Promise<RunConnection>;
}
