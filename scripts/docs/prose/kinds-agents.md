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

### Authoring agents

Some fns write something hard: a query, a form's gin type, later an API call or code. Don't hand that to the chat model
(it would carry every table or type in its context and guess at the shape), and don't make it an `agent()` (a free
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
it is done, so the model can't draft before it has searched. `authoringTool({ name, stage, description, schema, when?,
call })` declares a find or inspect tool; `when` narrows it further. `session.disclosure` (`Disclosure`) records what
the model has seen (`markAware`), loaded (`markLoaded`) and searched (`markSearched`), per level (`fn`, `type`,
`table`): a load tool is offered while something is aware but not loaded, and nothing is shown twice. The run's own
state (deps, the instance, what it chose) is `session.state`, the `AuthoringSession`'s second type parameter. Write
`instructions` as the job step by step, with a worked example of a good draft.

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
