/**
 * The sign-in flow: whether the hub still needs its admin account, and signing in or making it. Components bind to
 * this; it calls the hub through the callers in `api/auth.ts` and keeps the tokens in `state/session.ts`.
 */
import { ref } from 'vue';
import type { SetupState } from '@harness/core';
import { createAdminCaller, setupCaller, signInCaller } from '../api/auth.ts';
import { keepTokens } from './session.ts';

/** The sign-in form's state. */
export function useSignIn() {
  const setup = ref<SetupState | undefined>();
  const busy = ref(false);
  const problem = ref('');

  async function load(): Promise<void> {
    setup.value = await setupCaller.call();
  }

  async function submit(input: { email: string; password: string; name: string }): Promise<boolean> {
    busy.value = true;
    problem.value = '';
    try {
      const tokens = setup.value?.needsAdmin === true
        ? await createAdminCaller.call({ email: input.email, password: input.password, name: input.name })
        : await signInCaller.call({ email: input.email, password: input.password });
      keepTokens(tokens);
      return true;
    } catch (error) {
      problem.value = error instanceof Error ? error.message : 'Sign-in failed.';
      return false;
    } finally {
      busy.value = false;
    }
  }

  return { setup, busy, problem, load, submit };
}
