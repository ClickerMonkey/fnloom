/**
 * The api module: the ayepi server for the web API (`hubWebSpec`) and the link (`hubLinkSpec` on `/link`), sign-in in
 * single admin mode (SSO later is another `Authenticator`), realtime events relayed from the bus, files and content
 * refs (`@ayepi/files`), web push, and serving the built web app.
 *
 * Owner: the api lane (with boot). Implement `Authenticator` + `PasswordHasher` (`api/auth.ts`), `ContentStore`
 * (`api/files.ts`), `PushService` (`api/push.ts`), `EventRelay` (`api/events.ts`) and the web API plugins.
 */
import type { AccessClaims, ActorId, ContentRef, Notification, SetupState, Tokens, UserView } from '@harness/core';

/** Hashes and checks passwords (scrypt). Its own interface so the algorithm can change without touching callers. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

/** Sign-in. Today: one admin account made on first start; later SSO is another implementation. */
export interface Authenticator {
  setup(): Promise<SetupState>;
  createAdmin(input: { email: string; name: string; password: string; device: string }): Promise<Tokens>;
  signIn(input: { email: string; password: string; device: string }): Promise<Tokens | undefined>;
  refresh(refresh: string): Promise<Tokens | undefined>;
  signOut(claims: AccessClaims): Promise<void>;
  /** The user for verified claims, or undefined once the session is revoked. */
  user(claims: AccessClaims): Promise<UserView | undefined>;
}

/** Content refs: bytes stored once by hash, read in chunks, uploaded by presigned URL. */
export interface ContentStore {
  put(bytes: Uint8Array, mime: string): Promise<ContentRef>;
  read(ref: ContentRef, offset: number, length: number): Promise<Uint8Array>;
  /** A presigned upload; `finish` hashes it into a content ref. */
  presignUpload(input: { mime: string; size: number }): Promise<{ url: string; upload: string }>;
  finish(upload: string): Promise<ContentRef>;
  presignDownload(ref: ContentRef, name: string): Promise<string>;
}

/** Web push (VAPID): sends a notification to a user's subscribed browsers. */
export interface PushService {
  publicKey(): string;
  send(user: ActorId, notification: Notification): Promise<{ sent: number; gone: number }>;
}

/** Relays bus events to browsers as `session` / `user` web events, to the right people. */
export interface EventRelay {
  start(): () => void;
}
