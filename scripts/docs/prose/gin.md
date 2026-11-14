Every shape in a contract is a **gin** type made with `g`, the SDK's gin registry (`import { g } from '@harness/sdk'`).
A gin type is a real runtime type (it parses and checks values, serializes to JSON for the hub, becomes the LLM's tool
schema and the chat's input form) **and** it carries the TypeScript type of its values: `Infer<typeof T>` is exact. So
write each shape once with `g` and infer the TypeScript type from it.

A fn's args reach the model as a **strict tool call** built from their gin types (through aeye), and the hub checks the
call against the same types, so the shape a model is told is the shape it is held to. Give every arg a real type: an
arg the model sees should never be any JSON unless nothing else fits.

| Builder | Values (`Infer`) | Notes |
|---|---|---|
| `g.text({ minLength?, maxLength?, pattern? })` | `string` | |
| `g.num({ min?, max?, whole? })` | `number` | `whole: true` for integers |
| `g.bool()` | `boolean` | |
| `g.timestamp()` / `g.date()` | `Date` | travels as an ISO string, arrives as a `Date` |
| `g.duration()` | `number` | milliseconds |
| `g.list(item, { minLength?, maxLength? })` | `T[]` | |
| `g.obj({ key: type, … })` | `{ key: … }` | an `optional` field is an optional key |
| `g.optional(t)` | `T \| undefined` (key may be absent) | for "may be left out" |
| `g.nullable(t)` | `T \| null` | for "present but empty" |
| `g.enum(['a', 'b'])` | `'a' \| 'b'` | |
| `g.literal('x')` | `'x'` | |
| `g.or([a, b])` / `g.and([a, b])` | union / intersection | |
| `g.map(key, value)` | `Map<K, V>` | |
| `g.tuple([a, b])` | `[A, B]` | |
| `g.field(t, { docs, default })` | (a field of `obj`) | per-field docs the LLM and the form show |
| `json()` | `Json` | any JSON; the LLM and the form get no structure, so prefer a real type |
| `g.void()` | `void` | an action that returns nothing |

The full builder (`TypeBuilder`) and its options are in this section's reference. Named types are fields too: a type a
contract declares (`notes.types.Note`, `hub.types.ContentRef`) is a gin type registered under its qualified name, so
`g.obj({ note: notes.types.Note })` works and serializes by name. `hub.types.LongText` is text whose input is a growing
text area: use it for bodies and plans.

Shapes used in more than one place are constants in `shared/`, named for what they are, with their value types
inferred beside them:

<!-- include: scripts/docs/example/shared/index.ts#shapes -->

<!-- include: scripts/docs/example/shared/index.ts#value-types -->

Doc a field the LLM must fill in carefully with `g.field(type, { docs })`:

<!-- include: scripts/docs/example/shared/index.ts#config -->

**Values at runtime.** Fns receive values already parsed by their gin types, in plain JS form (timestamps as `Date`).
To check a value yourself use `parseValue(type, value)` (throws a gin error naming the problem); to turn a value into
JSON for storage use `encodeValue(type, value)` (dates as ISO strings). Read a file the system keeps with its own type,
so a file that doesn't fit is refused instead of read wrongly: `parseValue(g.list(Entry), JSON.parse(text))` to read,
`JSON.stringify(encodeValue(g.list(Entry), list))`
to write.

To read values of another system's named type at runtime, ask the hub for its definition
(`ctx.types.definitions([name])`) and parse it with `loadTypes`. `ginOf(zodSchema)` makes a gin type from a zod
schema (the hub uses it to mirror core schemas): core's `GinExprDef` becomes gin's `fn` (an expression), and
`GinTypeDef` / `GinObjTypeDef` become gin's `typ` (a gin type, whose tool schema is gin's strict TypeDef schema), never
any JSON. A system's own shapes are written with `g` directly.

**Gotchas.** `g.optional` makes the key optional; with `exactOptionalPropertyTypes`, build objects with conditional
spreads (`...(x === undefined ? {} : { x })`) rather than `x: undefined` where a type says `x?: T`. A `g.timestamp()`
field is a `Date` in code but a string on the wire. Never hand-write a TypeScript type that mirrors a gin type.
