/**
 * Who is signed in: the access and refresh tokens and the user, kept in this device's storage so a refresh of the page
 * stays signed in. Reactive, so the router guard, the client's headers and the shell follow it.
 */
import { Timestamp, Tokens } from '@harness/core';
import { computed, type Ref } from 'vue';
import type { z } from 'zod';
import { persisted, type KeyValueStore } from './persisted.ts';

/** The storage key. */
export const SESSION_KEY = 'harness.session';

/** What is stored: the tokens without their relative lifetime, and when the access token expires. */
export const StoredSession = Tokens.pick({ access: true, refresh: true, user: true }).extend({ expiresAt: Timestamp });
export type StoredSession = z.infer<typeof StoredSession>;

/** The signed-in browser's tokens and user. */
export class SessionStore {
  readonly #now: () => number;
  readonly #stored: Ref<StoredSession | undefined>;

  constructor(store: KeyValueStore, now: () => number = Date.now) {
    this.#now = now;
    this.#stored = persisted(store, SESSION_KEY, StoredSession.optional(), undefined);
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

  /** Keep new tokens, after signing in or refreshing. */
  keep(tokens: Tokens): void {
    this.#stored.value = { access: tokens.access, refresh: tokens.refresh, user: tokens.user, expiresAt: this.#now() + tokens.expiresIn };
  }

  /** Forget the tokens: signed out, or a refresh that failed. */
  forget(): void {
    this.#stored.value = undefined;
  }
}
