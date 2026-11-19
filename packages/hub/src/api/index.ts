/**
 * The api module: the ayepi server for the web API (`hubWebSpec`) and the link (`hubLinkSpec` on `/link`), sign-in in
 * a password (break-glass once SSO is on) or an SSO provider (`api/sso.ts`), realtime events relayed from the bus, files and content
 * refs (`@ayepi/files`), web push, secrets, and serving the built web app.
 *
 * Owner: the api lane (with boot). `ScryptHasher` (`api/hash.ts`), `HubAuthenticator` (`api/auth.ts`), `IdentityLinker` (`api/identities.ts`), `OidcSignIns` (`api/sso.ts`),
 * `FileContentStore` (`api/files.ts`), `WebPushService` (`api/push.ts`), `BusEventRelay` (`api/events.ts`),
 * `AesSecretVault` (`api/secrets.ts`) and the web API plugins (`api/web/*`). Notifications belong to the chat
 * module (`NotificationService`), which pushes through `PushService`.
 */
import type { EmitFn } from '@ayepi/core';
import type { ExternalClaims } from './identities.ts';
import type { AccessClaims, ActorId, ContentRef, HubWebSpec, Notification, SecretId, SetupState, SsoOutcome, Tokens, UserView } from '@harness/core';

/** Hashes and checks passwords (scrypt). Its own interface so the algorithm can change without touching callers. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

/** What an SSO sign-in came to: a session, or the reason it was refused in words. */
export type ExternalSignIn = { readonly tokens: Tokens; readonly outcome: SsoOutcome } | { readonly refused: string };

/** Sign-in: one admin account made on first start, passwords (only that admin's once SSO is on), and SSO providers. */
export interface Authenticator {
  setup(): Promise<SetupState>;
  /** Make the admin account; refused (`undefined`) once one exists. */
  createAdmin(input: { email: string; name: string; password: string; device: string }): Promise<Tokens | undefined>;
  /** Tokens for a good email and password, `undefined` otherwise (the same answer for an unknown email and a bad password). */
  signIn(input: { email: string; password: string; device: string }): Promise<Tokens | undefined>;
  /** New tokens for a refresh token. A refresh token used twice revokes its session (it was stolen or replayed). */
  refresh(refresh: string): Promise<Tokens | undefined>;
  signOut(claims: AccessClaims): Promise<void>;
  /** The user for verified claims, or undefined once the session is revoked or the user is disabled. */
  user(claims: AccessClaims): Promise<UserView | undefined>;
  /** Whether this person may sign in with a password now (once SSO is configured, only the break-glass admin). */
  passwordAllowed(user: { readonly id: ActorId }): Promise<boolean>;
  /** Sign in through an SSO provider whose ID token was verified: linked, made and synced, then a session; or refused. */
  signInExternal(claims: ExternalClaims, device: string): Promise<ExternalSignIn>;
  /** What signing in with these claims would do, changing nothing (a test sign-in). */
  preview(claims: ExternalClaims): Promise<SsoOutcome>;
}

/** Content refs: bytes stored once by hash, read in chunks, uploaded by presigned URL. */
export interface ContentStore {
  put(bytes: Uint8Array, mime: string): Promise<ContentRef>;
  /** Whether the bytes of a ref are stored. */
  has(ref: ContentRef): Promise<boolean>;
  read(ref: ContentRef, offset: number, length: number): Promise<Uint8Array>;
  /** The bytes stored under a hash, as a stream, with their size and type; undefined when none are. */
  open(hash: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number; mime: string } | undefined>;
  /** A presigned upload; `finish` hashes it into a content ref. Refused above the hub's upload limit. */
  presignUpload(input: { mime: string; size: number }): Promise<{ url: string; upload: string }>;
  /** Hash a finished upload into a content ref. Refused when it is missing or isn't the size that was declared. */
  finish(upload: string): Promise<ContentRef>;
  /** A presigned download that saves as `name`. */
  presignDownload(ref: ContentRef, name: string): Promise<string>;
}

/** Web push (VAPID): sends a notification to a user's subscribed browsers. Subscriptions the browser dropped are removed. */
export interface PushService {
  publicKey(): string;
  send(user: ActorId, notification: Notification): Promise<{ sent: number; gone: number }>;
}

/** The web API's typed event emitter (its `session` and `user` events). */
export type WebEmit = EmitFn<HubWebSpec>;

/** Relays bus events to browsers as `session` / `user` web events. Returns the stop. */
export interface EventRelay {
  start(emit: WebEmit): () => void;
}

/** Secrets (provider keys) encrypted at rest. Only ids leave the hub; the plain value is read where it is used. */
export interface SecretVault {
  /** Encrypt and store a value; returns its id. */
  store(input: { name: string; owner: ActorId; value: string }): Promise<SecretId>;
  /** Decrypt a stored value; undefined when there is no such secret. */
  reveal(id: SecretId): Promise<string | undefined>;
  remove(id: SecretId): Promise<boolean>;
}
