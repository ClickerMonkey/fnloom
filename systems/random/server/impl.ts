/**
 * The random system's implementation: one fn, `random`, that produces a random number between two bounds.
 * Its type is computed from the contract (`SystemImpl`), so a declared fn left out does not compile.
 */
import type { SystemImpl } from '@harness/sdk';
import type { random } from '../shared/index.ts';
import type { RandomSettings } from './env.ts';

/** Everything the implementation is built from: the settings. */
export interface RandomDeps {
  readonly settings: RandomSettings;
}

/** Build the random system's implementation. */
export function createImpl(_deps: RandomDeps): SystemImpl<(typeof random)['defs']> {
  return {
    fns: {
      random: {
        async run(args, ctx) {
          const { min, max } = args;
          const value = Math.floor(Math.random() * (max - min + 1)) + min;
          return ctx.done(value);
        },
      },
    },
  };
}
