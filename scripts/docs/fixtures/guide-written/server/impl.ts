/**
 * The guide-written system's implementation, as the model answered (see `../shared/index.ts`) but for one lint fix:
 * `run` returns a promise instead of being `async` with no `await` (this repository's lint refuses that).
 */
import type { SystemImpl } from '@harness/sdk';
import type { reverse } from '../shared/index.ts';

export function createImpl(): SystemImpl<(typeof reverse)['defs']> {
  return {
    fns: {
      reverse: {
        run(args, ctx) {
          return Promise.resolve(ctx.done(args.text.split('').reverse().join('')));
        },
      },
    },
  };
}
