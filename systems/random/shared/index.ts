/**
 * The random system's contract (`shared/`): one fn, `random`, that produces a random number between two bounds.
 * Other systems import it to call its fn through typed refs; its server implements it (`server/impl.ts`) and its
 * client draws it (`client/index.ts`). It must stay safe to import anywhere, the browser included: no Node imports here.
 */
import { system, fn } from '@harness/sdk';
import { g } from '@harness/sdk';

/** The random system's contract. */
export const random = system('random', { description: 'Generates a random number between two bounds.' })
  .with({
    fns: {
      random: fn({
        description: 'Returns a random integer between min (inclusive) and max (inclusive).',
        args: g.obj({
          min: g.num({ description: 'Lower bound, inclusive.' }),
          max: g.num({ description: 'Upper bound, inclusive.' }),
        }),
        returns: g.num({ description: 'A random integer between min and max.' }),
        tags: ['math'],
      }),
    },
  });
