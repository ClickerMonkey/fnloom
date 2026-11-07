/**
 * Signing in and staying signed in. `SignInForm` drives the sign-in page: whether the hub still needs its admin
 * account, the form's checks (the endpoint's own body schemas, so the page and the hub agree) and submitting.
 * `SessionKeeper` refreshes the access token shortly before it expires, and signs out.
 */
import { hubWebSpec, type SetupState } from '@harness/core';
import { ref, shallowRef, watch, type WatchStopHandle } from 'vue';
import { BEFORE_SIGN_IN, type AuthApi } from '../api/auth.ts';
import { checkForm, problemText, type FieldProblems } from './problems.ts';
import type { SessionStore } from './session.ts';

/** The admin form's schema; sign-in uses its email and password. */
const CreateAdmin = hubWebSpec.endpoints.createAdmin.cfg.body;
const SignIn = hubWebSpec.endpoints.signIn.cfg.body;

/** What the sign-in form holds. */
export interface SignInInput {
  email: string;
  password: string;
  name: string;
}

/** The fields that can have a problem. */
export type SignInField = keyof SignInInput;

/** The sign-in page's state. */
export class SignInForm {
  readonly #api: Pick<AuthApi, 'setup' | 'createAdmin' | 'signIn'>;
  readonly #session: SessionStore;

  /** What the hub says about itself; undefined until loaded. */
  readonly setup = shallowRef<SetupState | undefined>();
  readonly loading = ref(true);
  readonly busy = ref(false);
  /** A problem with the whole form (wrong password, the hub unreachable). */
  readonly problem = ref('');
  /** A problem with one field. */
  readonly fields = shallowRef<FieldProblems<SignInField>>({});

  constructor(api: Pick<AuthApi, 'setup' | 'createAdmin' | 'signIn'>, session: SessionStore) {
    this.#api = api;
    this.#session = session;
  }

  /** Whether this hub still needs its admin account made. */
  get needsAdmin(): boolean {
    return this.setup.value?.needsAdmin === true;
  }

  /** Ask the hub whether it needs its admin account. */
  async load(): Promise<void> {
    this.loading.value = true;
    this.problem.value = '';
    try {
      this.setup.value = await this.#api.setup.call(BEFORE_SIGN_IN);
    } catch (error) {
      this.problem.value = problemText(error);
    } finally {
      this.loading.value = false;
    }
  }

  /** Check and send the form; resolves whether the person is now signed in. */
  async submit(input: SignInInput): Promise<boolean> {
    const checked = this.needsAdmin ? checkForm(CreateAdmin, input) : checkForm(SignIn, input);
    this.fields.value = checked.ok ? {} : checked.problems;
    this.problem.value = '';
    if (!checked.ok) { return false; }
    this.busy.value = true;
    try {
      const tokens = this.needsAdmin
        ? await this.#api.createAdmin.call({ email: input.email, name: input.name, password: input.password }, BEFORE_SIGN_IN)
        : await this.#api.signIn.call({ email: input.email, password: input.password }, BEFORE_SIGN_IN);
      this.#session.keep(tokens);
      return true;
    } catch (error) {
      this.problem.value = problemText(error, "Couldn't sign in. Try again.");
      return false;
    } finally {
      this.busy.value = false;
    }
  }
}

/** When to refresh: this long before the access token expires. */
export const REFRESH_AHEAD = 60_000;

/** Keeps the session's access token fresh, and signs out. */
export class SessionKeeper {
  readonly #api: Pick<AuthApi, 'refresh' | 'signOut'>;
  readonly #session: SessionStore;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopWatch: WatchStopHandle | undefined;

  constructor(api: Pick<AuthApi, 'refresh' | 'signOut'>, session: SessionStore, now: () => number = Date.now) {
    this.#api = api;
    this.#session = session;
    this.#now = now;
  }

  /** Start refreshing whenever a token is near its end. */
  start(): void {
    this.#stopWatch ??= watch(this.#session.expiresAt, (at) => { this.#schedule(at); }, { immediate: true });
  }

  /** Stop refreshing. */
  stop(): void {
    this.#stopWatch?.();
    this.#stopWatch = undefined;
    clearTimeout(this.#timer);
  }

  /** Swap the refresh token for new tokens now. A refused refresh signs out. */
  async refresh(): Promise<boolean> {
    const token = this.#session.refreshToken.value;
    if (token === '') { return false; }
    try {
      this.#session.keep(await this.#api.refresh.call({ refresh: token }, BEFORE_SIGN_IN));
      return true;
    } catch {
      this.#session.forget();
      return false;
    }
  }

  /** Sign out on the hub (best effort) and forget the tokens here. */
  async signOut(): Promise<void> {
    try {
      await this.#api.signOut.call();
    } catch {
      // the tokens are forgotten either way; the hub expires them
    }
    this.#session.forget();
  }

  #schedule(at: number | undefined): void {
    clearTimeout(this.#timer);
    if (at === undefined) { return; }
    this.#timer = setTimeout(() => { void this.refresh(); }, Math.max(0, at - REFRESH_AHEAD - this.#now()));
  }
}
