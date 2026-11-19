/**
 * Per-person systems. A system that acts as a person (Google Calendar) declares `connect` in its manifest.
 * Once an admin has configured it, every person gets its page: they connect their own account (OAuth through the
 * hub's redirect, `/connect/callback`), pick the system's per-person settings, turn each of its fns on or off, choose
 * whether each may act without asking (otherwise an approval), and who else may use the connection. The hub keeps the
 * credentials as a secret owned by the person and sends them on each run that acts as them; the system hands back
 * refreshed ones with `connectionUpdate`.
 */
import { z } from 'zod';
import { ShareRule } from './access.ts';
import { GinTypeDef } from './gin.ts';
import { PickOption } from './pickers.ts';
import { ActorId, ConnectionId, InstanceName, Json, LocalName, QualifiedName, SecretId, SYSTEM_NAME_PATTERN, SystemName, Timestamp } from './primitives.ts';
import { RemoteAuth } from './remote-auth.ts';

/** A per-person fn's switches: whether it is on, and whether it must ask before acting. */
export const ConnectionFnOption = z.object({ on: z.boolean(), ask: z.boolean() });
export type ConnectionFnOption = z.infer<typeof ConnectionFnOption>;

/** How a person connects: an OAuth code flow through the hub's redirect, or a form (an API key) the system checks. */
export const ConnectFlow = z.discriminatedUnion('flow', [
  z.object({ flow: z.literal('oauth') }),
  z.object({ flow: z.literal('form'), form: GinTypeDef }),
]);
export type ConnectFlow = z.infer<typeof ConnectFlow>;

/**
 * Build 9: how people connect to one instance of an instance-scoped system (`instanceConnect` on the hub link, sent
 * whenever its config changes). `flow` absent: its calls need no connection (shared credentials, or none).
 * `share`: an admin's single connection is used by everyone (a shared OAuth sign-in), rather than each person's own.
 */
export const InstanceConnect = z.object({
  flow: ConnectFlow.optional(),
  share: z.boolean().default(false),
  /** The words on the connect button's card ("Sign in to Linear"). */
  title: z.string().min(1),
});
export type InstanceConnect = z.infer<typeof InstanceConnect>;

/**
 * A connection key: one of the things a key-scoped system (`ConnectDecl.scope: 'key'`) signs in to below its instance,
 * named by the system's own records (an API service of the one `api` instance). People connect per key.
 */
export const ConnectKey = z.string().regex(SYSTEM_NAME_PATTERN).brand<'ConnectKey'>();
export type ConnectKey = z.infer<typeof ConnectKey>;

/**
 * What the hub reads of each record of a key-scoped system's key type (`ConnectDecl.keys.type`): the key, the words on
 * its card, and how it signs in (`RemoteAuth`, from which the hub works out how people connect). Other fields are the
 * system's own.
 */
export const ConnectKeyRecord = z.looseObject({ name: ConnectKey, label: z.string().min(1), auth: RemoteAuth });
export type ConnectKeyRecord = z.infer<typeof ConnectKeyRecord>;

/**
 * A fn's connection key, for a key-scoped system: a fixed key (an api fn's service, from its kind's description), or the
 * arg whose value names it (a fn that takes the service to act on).
 */
export const FnConnectKey = z.union([ConnectKey, z.object({ arg: LocalName })]);
export type FnConnectKey = z.infer<typeof FnConnectKey>;

/** A system's `connect` declaration: its page, how to connect, the per-person settings and the fns that act as the person. */
export const ConnectDecl = z.object({
  /** The page's title in the nav ("Calendar"). */
  title: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  how: ConnectFlow,
  /** The type of a person's own settings (the calendars to use); the page edits it with the gin value editor. */
  settings: GinTypeDef,
  /** The fns that act as the person, with their default switches. Each is unavailable to people without a connection. */
  fns: z.record(LocalName, ConnectionFnOption),
  /**
   * Build 9: `instance` makes connections per fleet instance (an MCP server, an API service): each instance says
   * whether and how people connect to it (`instanceConnect` on the hub link, `InstanceConnect`), and every fn that runs
   * on such an instance acts as the person. `key`: connections per key the system's records name (`keys`), below its
   * instance (an API service of the one `api` instance); a fn acts as the person through its key (`FnDecl.connectKey`).
   * Absent, `system`: one connection per person to the whole system.
   */
  scope: z.enum(['system', 'instance', 'key']).optional(),
  /** For `scope: 'key'`: the system's stored type whose records are the keys (each a `ConnectKeyRecord`). */
  keys: z.object({ type: QualifiedName }).optional(),
  /** Build 9: the switches of a fn `fns` does not name (the runtime fns of an instance-scoped system). */
  defaults: ConnectionFnOption.optional(),
});
export type ConnectDecl = z.infer<typeof ConnectDecl>;

/** Where a connection is. `pending`: started, waiting for the redirect. `expired`: the refresh failed; reconnect. */
export const ConnectionStatus = z.enum(['pending', 'connected', 'expired', 'failed']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/**
 * The account a connection is to, as the system names it ("phil@example.com"), and, per settings field, the values the
 * account offers for it (its calendars), read when it connected. The page shows those fields as pickers.
 */
export const ConnectionAccount = z.object({
  label: z.string(),
  detail: z.string().optional(),
  /** Per settings field (top-level name): the values to pick from. A field missing here is edited as typed. */
  choices: z.record(z.string(), z.array(PickOption)).optional(),
});
export type ConnectionAccount = z.infer<typeof ConnectionAccount>;

/** The hub's row for a person's connection to a system (table `connections`). */
export const UserConnection = z.object({
  id: ConnectionId,
  system: SystemName,
  /** Build 9: the instance it is to, for an instance-scoped system (`ConnectDecl.scope`). */
  instance: InstanceName.optional(),
  /** The key it is to, for a key-scoped system (`ConnectDecl.scope: 'key'`). */
  key: ConnectKey.optional(),
  owner: ActorId,
  status: ConnectionStatus,
  account: ConnectionAccount.optional(),
  /** The credentials (tokens) as a secret owned by `owner`; absent while pending. */
  credentials: SecretId.optional(),
  expiresAt: Timestamp.optional(),
  /** The person's settings, of the system's `connect.settings` type. */
  settings: Json,
  /** Per fn (local name): the person's switches; a fn missing here takes its declared default. */
  fns: z.record(LocalName, ConnectionFnOption),
  /** Who else may use it: their calls then act as this connection's owner. */
  share: ShareRule,
  /** Why it failed or expired, in plain words. */
  problem: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type UserConnection = z.infer<typeof UserConnection>;

/** A connection as its page shows it (no credentials). */
export const ConnectionView = UserConnection.omit({ credentials: true });
export type ConnectionView = z.infer<typeof ConnectionView>;

/** A per-person system's page in the nav, with the asker's connections to it. */
export const ConnectPage = z.object({
  system: SystemName,
  decl: ConnectDecl,
  /** Whether an admin has configured the system (until then the page says so). */
  ready: z.boolean(),
  connections: z.array(ConnectionView),
  /** Build 9, an instance-scoped system: its instances people connect to, each with how (`InstanceConnect`). */
  instances: z.array(z.object({ instance: InstanceName, label: z.string(), connect: InstanceConnect })).optional(),
  /** A key-scoped system: its keys people connect to, each with how. */
  keys: z.array(z.object({ key: ConnectKey, label: z.string(), connect: InstanceConnect })).optional(),
});
export type ConnectPage = z.infer<typeof ConnectPage>;

/** What a run that acts as a person carries (`RunRequest.connection`): the connection and its revealed credentials. */
export const RunConnection = z.object({ id: ConnectionId, owner: ActorId, credentials: Json, settings: Json });
export type RunConnection = z.infer<typeof RunConnection>;

/** Hub → system: begin connecting (`connectStart`). `state` goes through the provider and back to the hub unchanged. */
export const ConnectStart = z.object({ connection: ConnectionId, owner: ActorId, redirect: z.url(), state: z.string(), instance: InstanceName.optional(), key: ConnectKey.optional() });
export type ConnectStart = z.infer<typeof ConnectStart>;

/** Hub → system: the redirect came back (its query `params`) or the form was sent (`form`); answer the account and credentials. */
export const ConnectFinish = z.object({
  connection: ConnectionId,
  owner: ActorId,
  instance: InstanceName.optional(),
  key: ConnectKey.optional(),
  redirect: z.url(),
  answer: z.union([z.object({ params: z.record(z.string(), z.string()) }), z.object({ form: Json })]),
});
export type ConnectFinish = z.infer<typeof ConnectFinish>;

/** The system's answer to `connectFinish`. */
export const ConnectResult = z.union([
  z.object({ account: ConnectionAccount, credentials: Json, expiresAt: Timestamp.optional() }),
  z.object({ problem: z.string() }),
]);
export type ConnectResult = z.infer<typeof ConnectResult>;

/** System → hub: refreshed credentials for a connection (`connectionUpdate`), or that it can't be refreshed. */
export const ConnectionUpdate = z.object({
  connection: ConnectionId,
  update: z.union([z.object({ credentials: Json, expiresAt: Timestamp.optional() }), z.object({ expired: z.string() })]),
});
export type ConnectionUpdate = z.infer<typeof ConnectionUpdate>;

/** Web: change a connection's settings, fn switches or sharing. */
export const ConnectionChange = z.object({
  connection: ConnectionId,
  settings: Json.optional(),
  fns: z.record(LocalName, ConnectionFnOption).optional(),
  share: ShareRule.optional(),
});
export type ConnectionChange = z.infer<typeof ConnectionChange>;
