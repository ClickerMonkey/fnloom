/**
 * The random system's contract (`shared/`): one fn, `random`, that produces a random number between two bounds.
 * Other systems import it to call its fn through typed refs; its server implements it (`server/impl.ts`) and its
 * client draws it (`client/index.ts`). It must stay safe to import anywhere, the browser included: no Node imports here.
 */
import { system, fn } from '@harness/sdk';
import { g } from '@harness/sdk';

/** The random system's contract. */
export const random = system('random', {
  description: 'Generates a random number between two bounds.',
  about: 'A fair random whole number between two bounds: one fn, random/random. Reach for it whenever something must be left to chance (a dice roll, a coin toss as 0 or 1, picking from a numbered list, who goes first) instead of choosing yourself. It defines no fn kinds.',
  grants: { hub: [] },
})
  .with({
    fns: {
      random: fn({
        description: 'A random whole number from min to max, both included. Gives the number.',
        args: g.obj({
          min: g.field(g.num({ whole: true }), { docs: 'Lower bound, inclusive.' }),
          max: g.field(g.num({ whole: true }), { docs: 'Upper bound, inclusive.' }),
        }),
        returns: g.num({ whole: true }),
        instructions: 'Use it whenever a choice must be random (a dice roll, a coin toss as 0 or 1, a pick from a numbered list); never make a random choice up yourself. Both bounds are included; give min below max. For several numbers, call it once per number.',
        examples: [{ args: { min: 1, max: 6 }, result: 4, note: 'A dice roll.' }, { args: { min: 0, max: 99 } }],
        effects: { mode: 'read', free: true },
        tags: ['math'],
      }),
    },
  });
