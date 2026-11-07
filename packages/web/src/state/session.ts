/**
 * Who is signed in: the access and refresh tokens, kept in `localStorage` so a refresh stays signed in. Reactive, so
 * the router guard and the client headers follow it.
 */
import { UserView, type Tokens } from '@harness/core';
import { computed, ref } from 'vue';
import { z } from 'zod';

const KEY = 'harness.session';

const Stored = z.object({ access: z.string(), refresh: z.string(), user: UserView });
type Stored = z.infer<typeof Stored>;

function load(): Stored | undefined {
  const raw = window.localStorage.getItem(KEY);
  if (raw === null) { return undefined; }
  const parsed = Stored.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : undefined;
}

const stored = ref<Stored | undefined>(load());

/** The access token, or '' when signed out. */
export const accessToken = computed(() => stored.value?.access ?? '');
/** The refresh token, or '' when signed out. */
export const refreshToken = computed(() => stored.value?.refresh ?? '');
/** The signed-in user. */
export const currentUser = computed(() => stored.value?.user);
/** Whether someone is signed in. */
export const signedIn = computed(() => stored.value !== undefined);

/** Keep new tokens (after sign-in or refresh). */
export function keepTokens(tokens: Tokens): void {
  stored.value = { access: tokens.access, refresh: tokens.refresh, user: tokens.user };
  window.localStorage.setItem(KEY, JSON.stringify(stored.value));
}

/** Forget the tokens (sign-out, or a refresh that failed). */
export function forgetTokens(): void {
  stored.value = undefined;
  window.localStorage.removeItem(KEY);
}
