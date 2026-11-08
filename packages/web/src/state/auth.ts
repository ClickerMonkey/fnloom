/**
 * Signing in and staying signed in. `SignInForm` drives the sign-in page: whether the hub still needs its admin
 * account, the form's checks (the endpoint's own body schemas, so the page and the hub agree) and submitting.
 * `SessionKeeper` refreshes the access token shortly before it expires, and signs out.
 *
 * Every tab shares one stored session, and the hub treats a refresh token used twice as stolen (it ends the whole
 * sign-in). So a refresh runs under a lock shared by the app's tabs (`TabLock`): one tab refreshes while the others
 * wait, and each reads the stored session again once it holds the lock, taking the tokens another tab already got.
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

/** The name of the lock the app's tabs take to refresh. */
export const REFRESH_LOCK = 'harness.refresh';

/** A lock shared by the app's tabs: `run` waits for it, runs `task` holding it, and lets it go when the task settles. */
export interface TabLock {
  run<T>(name: string, task: () => Promise<T>): Promise<T>;
}

/** A lock for this tab alone: tasks under one name run one after another. */
export class LocalLock implements TabLock {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(name: string, task: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(name) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.#tails.set(name, result);
    return result;
  }
}

/** The browser's Web Locks, shared by every tab of the app; this tab's own lock where they aren't available. */
export class BrowserLock implements TabLock {
  readonly #locks: LockManager | undefined;
  readonly #local = new LocalLock();

  constructor(navigator: Partial<Pick<Navigator, 'locks'>> | undefined) {
    this.#locks = navigator?.locks;
  }

  run<T>(name: string, task: () => Promise<T>): Promise<T> {
    // the lock resolves with what the task resolves with (its promise, which `then` flattens)
    return this.#locks === undefined ? this.#local.run(name, task) : this.#locks.request(name, task).then((result) => result);
  }
}

/** Why a refresh is asked for: the token is due (the timer), or the hub refused it (a call answered 401). */
export type RefreshReason = 'due' | 'refused';

/** Keeps the session's access token fresh, and signs out. */
export class SessionKeeper {
  readonly #api: Pick<AuthApi, 'refresh' | 'signOut'>;
  readonly #session: SessionStore;
  readonly #now: () => number;
  readonly #lock: TabLock;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopWatch: WatchStopHandle | undefined;
  #recovering: Promise<boolean> | undefined;

  constructor(api: Pick<AuthApi, 'refresh' | 'signOut'>, session: SessionStore, now: () => number = Date.now, lock: TabLock = new LocalLock()) {
    this.#api = api;
    this.#session = session;
    this.#now = now;
    this.#lock = lock;
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

  /**
   * Swap the refresh token for new tokens, holding the tabs' lock. Once it holds the lock it reads the stored session
   * again: when another tab rotated the tokens meanwhile (or, for a due refresh, they are no longer due) it keeps
   * those. A refused refresh signs out; resolves whether this tab is still signed in.
   */
  refresh(reason: RefreshReason = 'due'): Promise<boolean> {
    const before = this.#session.refreshToken.value;
    return this.#lock.run(REFRESH_LOCK, async () => {
      this.#session.reload();
      const token = this.#session.refreshToken.value;
      if (token === '') { return false; }
      if (token !== before || (reason === 'due' && !this.#due())) { return true; }
      try {
        this.#session.keep(await this.#api.refresh.call({ refresh: token }, BEFORE_SIGN_IN));
        return true;
      } catch {
        this.#session.forget();
        return false;
      }
    });
  }

  /**
   * The hub refused this tab's access token (a call answered 401): refresh once, however many calls were refused at
   * the same moment. A refused refresh forgets the session, and the app returns to sign-in.
   */
  recover(): Promise<boolean> {
    this.#recovering ??= this.refresh('refused').finally(() => { this.#recovering = undefined; });
    return this.#recovering;
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

  /** Whether the access token is within `REFRESH_AHEAD` of expiring. */
  #due(): boolean {
    const at = this.#session.expiresAt.value;
    return at !== undefined && at - REFRESH_AHEAD <= this.#now();
  }

  #schedule(at: number | undefined): void {
    clearTimeout(this.#timer);
    if (at === undefined) { return; }
    this.#timer = setTimeout(() => { void this.refresh(); }, Math.max(0, at - REFRESH_AHEAD - this.#now()));
  }
}
