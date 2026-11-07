/** Every e2e scenario. Add a scenario file per UI feature and list it here. */
import type { Scenario } from '../harness.ts';
import { signIn } from './sign-in.ts';

export const scenarios: readonly Scenario[] = [signIn];
