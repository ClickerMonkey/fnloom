/**
 * Who is signed in: the access and refresh tokens and the user, kept in this device's storage so a refresh of the page
 * stays signed in. Reactive, so the router guard, the client's headers and the shell follow it. Every tab of the app
 * shares the one stored session: a tab follows the others' changes (a rotated token, a sign-out) as they happen.
 *
 * A session signed in without "Remember me" ends when the browser closes: it carries `remember: false`, and signing
 * in sets a browser-session mark (`BrowserSessionMark`, a cookie with no expiry). A later start that finds such a
 * session without the mark forgets it.
 */
import { Timestamp, Tokens } from '@harness/core';
import { computed, type Ref } from 'vue';
import { z } from 'zod';
import { persisted, readStored, type KeyValueStore, type StorageChanges } from './persisted.ts';

/** The storage key. */
export const SESSION_KEY = 'harness.session';

/** What is stored: the tokens without their relative lifetime, and when the access token expires. */
export const StoredSession = Tokens.pick({ access: true, refresh: true, user: true }).extend({
  expiresAt: Timestamp,
  /** False when it should end with the browser session; missing (older sessions) means remembered. */
  remember: z.boolean().optional(),
});
export type StoredSession = z.infer<typeof StoredSession>;

/** A mark that lasts as long as the browser session, shared by every tab. */
export interface BrowserSessionMark {
  /** Whether the mark is set (this browser session signed in without "Remember me"). */
  alive(): boolean;
  set(): void;
  clear(): void;
}

/** The cookie that marks a browser session; it has no expiry, so the browser drops it when it closes. */
export const ALIVE_COOKIE = 'harness.alive';

/** A `BrowserSessionMark` kept as a session cookie on `doc`. */
export function cookieMark(doc: Pick<Document, 'cookie'>): BrowserSessionMark {
  return {
    alive: () => doc.cookie.split(';').some((part) => part.trim() === `${ALIVE_COOKIE}=1`),
    set: () => { doc.cookie = `${ALIVE_COOKIE}=1; Path=/; SameSite=Lax`; },
    clear: () => { doc.cookie = `${ALIVE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`; },
  };
}

/** The signed-in browser's tokens and user. */
export class SessionStore {
  readonly #store: KeyValueStore;
  readonly #now: () => number;
  readonly #stored: Ref<StoredSession | undefined>;
  readonly #mark: BrowserSessionMark | undefined;

  /**
   * `changes` are the other tabs' writes to the same storage; without it, this tab reads the session only at start.
   * `mark` ends sessions signed in without "Remember me" when the browser closes; without it they last like the rest.
   */
  constructor(store: KeyValueStore, now: () => number = Date.now, changes?: StorageChanges, mark?: BrowserSessionMark) {
    this.#store = store;
    this.#now = now;
    this.#mark = mark;
    this.#stored = persisted(store, SESSION_KEY, StoredSession.optional(), undefined);
    if (this.#stored.value?.remember === false && mark !== undefined && !mark.alive()) { this.#stored.value = undefined; }
    changes?.((key) => { if (key === null || key === SESSION_KEY) { this.reload(); } });
  }

  /** The access token, or '' when signed out. */
  readonly accessToken = computed(() => this.#stored.value?.access ?? '');
  /** The refresh token, or '' when signed out. */
  readonly refreshToken = computed(() => this.#stored.value?.refresh ?? '');
  /** The signed-in user. */
  readonly user = computed(() => this.#stored.value?.user);
  /** Whether someone is signed in. */
  readonly signedIn = computed(() => this.#stored.value !== undefined);
  /** When the access token expires (ms since the epoch), or undefined when signed out. */
  readonly expiresAt = computed(() => this.#stored.value?.expiresAt);

  /** Whether this session lasts past the browser closing. */
  readonly remembered = computed(() => this.#stored.value?.remember !== false);

  /**
   * Keep new tokens. Signing in passes `remember`; a refresh leaves it out and keeps what the session had.
   */
  keep(tokens: Tokens, remember?: boolean): void {
    const keepIt = remember ?? this.#stored.value?.remember ?? true;
    if (remember === false) { this.#mark?.set(); }
    this.#stored.value = {
      access: tokens.access, refresh: tokens.refresh, user: tokens.user, expiresAt: this.#now() + tokens.expiresIn, ...(keepIt ? {} : { remember: false }),
    };
  }

  /** Forget the tokens: signed out, or a refresh that failed. */
  forget(): void {
    this.#stored.value = undefined;
  }

  /** Read the session again from storage, where another tab may have rotated the tokens or signed out. */
  reload(): void {
    const stored = readStored(this.#store, SESSION_KEY, StoredSession);
    if (stored?.access !== this.#stored.value?.access || stored?.refresh !== this.#stored.value?.refresh) { this.#stored.value = stored; }
  }
}
