// Compile-time proof for `partialOf`: every field of an object's fields made optional, keeping the ones already optional
// and their docs, so a change's args are written once with a create's. Nothing here runs: `npm run typecheck` fails if an
// expectation breaks.

import { expectType, g, partialOf, type Equal, type Infer } from '@harness/sdk';

// partialOf makes every field optional and keeps the ones already optional
const fields = partialOf({ a: g.text(), b: g.field(g.num(), { docs: 'b' }), c: g.optional(g.bool()) });
const partial = g.obj(fields);
expectType<Equal<Infer<typeof partial>, { a?: string; b?: number; c?: boolean }>>(true);
