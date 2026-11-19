/**
 * The connections module (build 4): per-person systems. A system that declares `connect` gets a page for every
 * person once an admin has configured it; each person connects their own account (OAuth through the hub's
 * `/connect/callback`, or a form), and that system's per-person fns then act as them. Credentials are a secret owned
 * by the person, sent only on the runs that act as that connection, and replaced when the system refreshes them.
 *
 * Owner: the hub lane. `StoreConnectionService` (`connections/service.ts`) implements `ConnectionService`.
 */
import type {
  ActorId, ConnectionChange, ConnectionId, ConnectionUpdate, ConnectionView, ConnectKey, ConnectPage, InstanceName, Json, RunConnection, SystemName, UserConnection,
} from '@harness/core';
import type { ConnectionGate } from '../access/index.ts';

/** Where the redirect sends the person back to (`/connect/<system>`), with the problem when it failed. */
export interface CallbackAnswer {
  readonly system: SystemName | undefined;
  readonly problem?: string | undefined;
  /** The binding cookie to clear, once the sign-in it tied is used up. */
  readonly clear?: string | undefined;
}

/**
 * The cookie that ties a provider sign-in to the browser that started it. The `connect` answer sets it (httpOnly, on
 * the callback path only) and the signed state carries its hash, so the callback finishes only in that browser: a
 * consent link handed to someone else can't link their account to the starter's connection.
 */
export interface ConnectBinding {
  readonly cookie: string;
  readonly value: string;
  /** Seconds the cookie lives: the connect window. */
  readonly maxAge: number;
  /** Send it over HTTPS only (the hub's public URL is https). */
  readonly secure: boolean;
}

/** How connecting began: the provider's URL and the browser binding (OAuth), or the finished connection (a form). */
export type ConnectStart = { readonly url: string; readonly binding: ConnectBinding } | { readonly connection: ConnectionView };

/** Per-person connections. */
export interface ConnectionService {
  /** Every `connect` system's page, with the asker's own connections to it. */
  pages(asker: ActorId): Promise<ConnectPage[]>;
  /**
   * Begin connecting: the provider's URL to send the person to (OAuth), or the finished connection (a form). Build 9:
   * an instance-scoped system (`ConnectDecl.scope`) connects to one `instance`, the way that instance said
   * (`InstanceConnect`); a shared one is connected by an admin, for everyone. A key-scoped system connects to one `key`
   * (an API service), the way its record says.
   */
  connect(asker: ActorId, system: SystemName, form?: Json, instance?: InstanceName, key?: ConnectKey): Promise<ConnectStart>;
  /**
   * The provider sent the person back to `/connect/callback` with these query params; `cookies` are the browser's and
   * must hold the binding `connect` set. Each sign-in finishes once: a replay changes nothing.
   */
  callback(params: Readonly<Record<string, string>>, cookies: Readonly<Record<string, string>>): Promise<CallbackAnswer>;
  /** Change the asker's own connection's settings, fn switches or sharing. */
  update(asker: ActorId, change: ConnectionChange): Promise<ConnectionView>;
  /** End the asker's own connection: the system revokes it where it can, then its secret and row go. */
  disconnect(asker: ActorId, connection: ConnectionId): Promise<boolean>;
  /** An instance sent refreshed credentials, or said they can't be refreshed (`connectionUpdate`); only for its own connections. */
  refreshed(system: SystemName, update: ConnectionUpdate, instance?: InstanceName): Promise<void>;
  /** How a person's per-person fns stand: their own connection, else the newest one shared with them. */
  gate(actor: ActorId, groups: ReadonlySet<ActorId>): Promise<ConnectionGate>;
  /** What a run acting as a connection carries: its credentials revealed. */
  forRun(connection: UserConnection): Promise<RunConnection>;
}
