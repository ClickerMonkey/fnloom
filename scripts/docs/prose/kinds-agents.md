### Kinds

A **kind** decides what a fn's definition looks like and how it runs. A native fn's author declares everything because
the code is the definition; a fn of a kind carries only a **payload** (the kind's definition data), and the kind works
out the rest from it. Declare a kind with `kind({ description, applicability, payload, approveChanges?, status? })`:
`applicability` tells an agent when to pick this kind for a new fn, `payload` is its gin type, `approveChanges`
(default `true`) makes declaring or changing a fn of the kind at runtime wait for approval, and `status` gives the
words of its fns that declare none (they may use `{fn}`, `{n}`, `{args.…}` and `{output.…}`).

<!-- include: scripts/docs/example/shared/index.ts#kind -->

The server implements each kind with three functions, and fns of the kind are **not** implemented one by one:

- `check(payload, ctx)`: problems beyond the payload's type (an unknown fn, a program that doesn't compile), as
  sentences; `[]` when it is fine.
- `describe(payload, ctx)`: everything else about a fn with this payload, as a `KindDescription`: its `args` and
  `returns` (gin definitions, made with `wireType(type)`), the fns it calls (`deps`), the named types and resources it
  refers to, its operations, and optionally handlers, progress, status words, limits and display. `ctx.type(name)` and
  `ctx.fn(name)` look up other declarations while describing.
- `run(payload, args, ctx)`: run one fn of the kind. The args arrive as JSON the hub checked against `describe`'s args;
  read them with the same gin type (`parseValue`). The result is JSON (`encodeValue`). `ctx.call(name, args)` calls the
  deps `describe` returned, by name; `ctx.handler(name, args)` asks a handler; `ctx.progress(...)` reports either shape.
- `undo(payload, undo, ctx)`, optional, for kinds whose fns are undoable.

<!-- include: scripts/docs/example/server/impl.ts#impl-kind -->

Fns of a kind are declared with the kind's ref, `kinds.<kind>.fn({ description, payload, args?, returns?, … })`, by
its own system or by any other. Give `args` and `returns` to type the ref; the hub checks them against what `describe`
derives. Without them the ref takes and returns `Json`. The fn runs on the system that defines its kind.

### Agents

An **agent** is a fn of the hub's `llm` kind: an LLM with instructions, a model, tools and context, callable like any
fn. `agent({ description, args, returns, instructions, … })` declares one; any system can ship its own (a reviewer, a
planner) with tools from any system.

- `instructions` is a Handlebars template; `{{args.question}}` reads the args.
- `returns: g.text()` gives a chat-style answer; any other type asks the model for a structured answer of that type.
- `tools` are fn refs it can use; `canLoad` lets it add more while running (`{ fns?, systems?, tags? }`, default
  `'none'`); `maxTools` (default 32) caps the toolset.
- `context` is context it always has; `hooks` run on each user message it gets.
- `model` picks a model (`{ model: 'openrouter/…' }`, `{ category: 'fast' }` or `{ auto: { cost, speed, accuracy } }`);
  without one the hub's default is used.
- `mode` and `contextor` choose how fns and context reach the model (strict tools or the static toolset; plain,
  suggest or graph context), `maxOutput` caps one answer, `maxIterations` (default 16) caps the steps,
  `toolExecution` is `parallel` (default) or `sequential`.

<!-- include: scripts/docs/example/shared/index.ts#agent -->
