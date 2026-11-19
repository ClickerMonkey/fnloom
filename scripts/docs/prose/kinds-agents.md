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
  refers to, its operations, at least one `examples` entry (`sampleArgs(def)` fills one from the args type), and optionally handlers, progress, status words, limits and display. `ctx.type(name)` and
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

### Authoring agents

Some fns write something hard: a query, a form's gin type, an API call or code. Don't hand that to the chat model
(it would carry every table or type in its context and guess at the shape; the database's chat fns `get_query` and
`edit_query` take a description in words, never query JSON), and don't make it an `agent()` (a free
loop of tools can draft before it has looked, and never has to check). Write a native fn that runs an **authoring
agent**: `authoringAgent({ name, description, instructions, tools, draft, check, save, reuse? })` from
`@harness/sdk/server`, run with the run's `ctx.ai()`. The chat model passes only a description of what it wants and
gets back an `AuthoredFn`: the saved fn, its signature, what it does, a short preview and how to call it again. Never
the working context. Use `agent()` for a helper that answers or acts with tools; use `authoringAgent` when the result
is a new fn kept in the hub.

The agent works through fixed stages: **find** (search what exists; `reuse` answers with an existing fn), **inspect**
(load the details of what the search found), **draft** (the built-in `draft` tool, whose args are your typed `draft`
schema), **check** (your `check`, run on every draft: each problem on its own line, in words the model can act on),
**fix** (a draft with problems sends the model back, up to `HARNESS_AUTHORING_FIXES` times) and **save** (offered only
once a draft checked clean; your `save` keeps it as a fn). A tool of a stage is offered only once every stage before
it is done, so the model can't draft before it has searched, and until something is saved or reused every round must
call a tool (`toolChoice: 'required'`), so a model can't stop in words with a clean draft unsaved.
`authoringTool({ name, stage, description, schema, when?, strict?, call })` declares a find or inspect tool; `when`
narrows it further. aeye sends tool args as strict tool calls when the model can take them; `strict` is aeye's setting
for one tool (`true` requires strict, a number is how much it is wanted, `false` sends it non-strict). The built-in
`draft` tool is sent non-strict: strict decoding of a whole program or query (a recursive grammar, optional fields at
every level) made models fill every absent optional with null and pick wrong branches, so the schema guides the draft
and your `check` names each problem by path. `session.disclosure` (`Disclosure`) records what the model has seen
(`markAware`), loaded (`markLoaded`) and searched (`markSearched`), per level (`fn`, `type`, `table`): a load tool is
offered while something is aware but not loaded, and nothing is shown twice. The run's own state (deps, the instance,
what it chose) is `session.state`, the `AuthoringSession`'s second type parameter. Write `instructions` as the job step
by step, with a worked example of a good draft.

**Programs.** The `code` and `api` systems author gin programs with `@harness/sdk/program` (`ProgramScope`,
`programTools`, `testTool`, `ProgramAuthoring` on `authoringAgent`). A program's schemas are gin's strict ones
(`buildSchemas(registry, { newStrict: true })`): a `{ kind: 'new', type, value }` is typed by the type it names. In its
value a plain field (text, a number, a bool, an enum or literal, a date) takes its value as is (`"GET"`) or an
expression; every other field (a list, an object, a body, any JSON) takes an expression, usually a `new` of its type.
A type also accepts a named extension of a type it accepts (`list<obj{ key, value }>` takes `list<api/HttpParam>`).
Write the examples in an authoring agent's `instructions` the same way, and test that each fits the schemas the tools
are sent (`examples.test.ts` in the api, code and database systems).

An agent handed what it builds on has nothing to find: `stages: { find: false }` starts it in **inspect** (a find
tool or `reuse` is then refused). `toolNames: { draft, save }` names the built-in tools for the job (`{ draft:
'report_check', save: 'report_save' }`).

The input system's `get_input` writes a form this way. Its find tool:

<!-- include: systems/input/server/authoring.ts#authoring-tool -->

The agent, its draft schema, check and save:

<!-- include: systems/input/server/authoring.ts#authoring-agent -->

Its fn runs it and turns a run that gave up (`AuthoringError`, with the last problems) into a failure the chat model can
act on:

<!-- include: systems/input/server/impl.ts#authoring-run -->

Test it with a scripted model (`mockModel` and `toolCall` from `@harness/sdk/testing`): each step is the tool call the
model makes, and each forward shows which tools were offered at that stage.

<!-- include: systems/input/server/authoring.test.ts#authoring-test -->
