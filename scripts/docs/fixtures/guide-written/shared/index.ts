/**
 * A system written from the authoring guide alone: what a free model (nemotron 3.5 super, through OpenRouter) answered
 * when given only the `fs/system-authoring` context and "make a system with one fn that reverses text", kept as it
 * answered. `npm run typecheck` compiles it, so the guide stays enough to write a correct system.
 */
import { system, fn, g } from '@harness/sdk';

export const reverse = system('reverse', { description: 'Reverse a text.' })
  .with({
    fns: {
      reverse: fn({
        description: 'Reverse a text.',
        args: g.obj({ text: g.text() }),
        returns: g.text(),
      }),
    },
  });
