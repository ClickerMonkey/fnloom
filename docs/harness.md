# Harness

A web-based agent harness. One server, the **hub**, owns every LLM call, every user, every permission
and the record of everything that happened. Separate processes, **systems**, connect to the hub over a
WebSocket and add things to it: fns (tools), fn kinds, types, resources, context, chat inputs and UI
renderers. A system can run anywhere, can be written by Claude Code or by the harness itself, and is
picked up again on reconnect.

This document is the plain-language picture. The same picture as TypeScript is in `types/`:

- **`sdk.ts`**: everything a system author touches. This is the part to review most closely.
- **`fs.ts`**: the first system's contract, written with the SDK exactly as it will ship.
- **`hub.ts`**: the hub's side: the wire format, records, permissions, queues, chat and storage.
- **`examples.ts`**: the fs system's server written against the SDK, plus every mistake the types must
  refuse. It is checked by the compiler, so the SDK can't drift from what this guide promises.

The explorer (`explorer/explorer.html`) shows all of it and lets you leave notes on any section, type or
member. Nothing is implemented yet: the types are for review first, then zod schemas, then code.

**Status:** draft for review. Names are placeholders where noted. Decisions waiting on you are in
[Open questions](#g/open-questions).

## What carries over from product, and what doesn't

Harness borrows ideas from `product` but starts fresh:

- **Kept:** everything is a fn; fns have kinds; gin types for every signature; a record of every call
  (the fn tree); approvals; undo; callbacks (here: handlers); background runs; context with commands;
  @ / / / ! chat inputs; budgets.
- **Changed:** product's core was one interwoven process. Harness is a small hub plus loosely coupled
  systems that talk over one small protocol. Fn kinds live in systems, not in the hub. The hub ships
  only two kinds (`native` and `llm`).
- **Dropped for now:** apps, components, plans, widgets, dashboards, fn authoring agents, the graph
  contextor, the database-first design. A database system comes later.

## Words

| Word | Meaning |
|---|---|
| **Hub** | The main server. Queues, LLM calls, users, permissions, storage, indexing, the web chat. |
| **System** | A process connected to the hub that contributes fns, kinds, types, resources, context, inputs and renderers. What your notes called a plugin. The hub is itself a system named `hub`. |
| **Fn** | A typed function: gin args in, gin result out. "Tool" is what the LLM calls it. Every fn belongs to one system and its name is `system/name`. |
| **Fn kind** | Decides what a fn's definition (its *payload*) looks like and how it runs. Kinds are provided by systems. |
| **Run** | One call of a fn. Runs form a tree: a run's children are the fns it called. |
| **Turn** | One user message and everything it caused. Every run, LLM call and change traces back to a turn. |
| **Session** | A chat. People and agents talk in it; it has enabled systems, a budget and a priority. |
| **Actor** | Anything that can act or be granted something: a user, a group, an agent, or a system (the hub is one). Core table. |
| **Resource** | Content that lives somewhere: a folder, a file, a web page, a database row. Served by a system at an absolute URI. |
| **Section** | A stable, addressable piece of a resource (a heading, a function, a page). |
| **Context** | Content made available to the LLM. It can mention and import other context and fns. |

## Architecture

```
            browser (chat UI + system renderers)
                       │  HTTPS + one WebSocket
┌──────────────────────┴──────────────────────────────────────┐
│ HUB                                                          │
│  web api ── sessions ── turns ── LLM queue ──► aeye AI ──► providers
│                │                    │ tool calls               │
│                │                    ▼                          │
│                │              tool queue ──► hub fns (native, llm)
│                │                    │                          │
│  actors · policies · budgets · store (sqlite) · index         │
└──────────────────────┬──────────────────────────────────────┘
                       │  one WebSocket per system (small binary frames)
        ┌──────────────┼──────────────┬───────────────┐
     fs system   claude-code     mcp bridge      db system …
     (first)      system         system         (later)
```

- The hub pops LLM requests off a queue, calls the model, saves the interaction, turns each tool call
  into a run and pushes it onto the tool queue.
- The tool queue runs a fn in the hub (kinds `native` and `llm`) or sends it to the system that owns
  the fn's kind. The system runs it and sends back a small outcome.
- When the last run of an LLM iteration settles (or goes to the background), the hub queues the next
  LLM request for that session.
- Systems never call an LLM provider. They use an aeye `AI` whose provider forwards to the hub, so the
  hub enforces budgets and records every interaction. **The hub is an aeye provider.**
- The hub stores everything in one generic database. SQLite is the default.

## Systems

A system is a process with a unique **name**. The name namespaces everything it contributes:
`fs/read_file`, `fs/FileInfo`, `fs/guide`. Resources keep their own absolute URIs (`file:///…`) and belong to the system whose root contains them.

### What a system provides

- **Fn kinds** and the handler that runs them.
- **Fns**, declared at boot and added or removed at runtime.
- **Types** (gin type definitions) other systems and the hub can use.
- **Resource roots** (initially folders) and a resource service: list, stat, read, links, sections, watch.
- **Section rules**: how its formats are cut into stable sections.
- **Context**, including `/name` commands.
- **Mention providers** for `@` in the chat: ways to point at things the system knows (a file, a database
  row, a ticket).
- **Hooks** that add information to a user message before the LLM sees it.
- **Embedders**: an embed function the hub can use for indexing.
- **Actor settings**: typed per-actor controls an admin (or a fn) can set, such as a database system's
  row and field rules for a group.
- **Event subscriptions**: hub events it wants to hear.
- **Client assets**: browser code that registers renderers for its fns, resource formats, attachments
  and input types.

All of this is described in one **manifest** the system sends on connect, plus small patches after.

### Connecting and pairing

1. The system opens a WebSocket to the hub and says hello: name, version, public key, manifest hash.
2. **A name the hub has never seen** starts pairing. Two ways:
   - **Code:** the system prints a short code and a link. An admin opens the link (or answers a chat
     prompt / push notification) and confirms the code matches.
   - **Token:** an admin creates a one-time pairing token (in the UI or by asking in chat) and starts the
     system with it.
3. **A known name** must prove it holds the paired key (signed challenge). A different key under a known
   name is refused until an admin re-pairs or replaces it.
4. After the hub welcomes it, the system sends its manifest (or nothing, if the hash matches). The hub
   imports and indexes what changed.
5. On disconnect the system's fns become **unavailable**, not deleted. On reconnect they come back,
   possibly changed. An admin can **remove** a system; its fns stop being callable until it is paired
   again.

A fn is available only if its own system and its kind's system are connected, its kind still exists,
and every fn it depends on is available.

### Talking to the hub

Almost everything between the hub and a system is a plain **request and response**, defined as ayepi
endpoints in two specs: `HubLink` (the system calls the hub: its contract, calls to other fns, progress, LLM
requests, logs) and `SystemLink` (the hub calls the system: run a fn, control a run, read resources, embed,
run a hook, deliver an action). **ayepi makes these work** over the system's one WebSocket in both directions,
and over HTTP where that fits; ids, replies, typed errors, streams, cancellation and reconnect are its job.
**Events** are used only where no answer is needed: a resource changed, a run's progress for the browser.

Two-way calls over one socket aren't in ayepi yet (today only the client calls). That gets added to ayepi
itself, in the linked checkout, rather than built in harness.

Messages stay small: ids, typed args and results, progress. Large content never rides inside a message.
It moves as a **content ref** (`ContentRef`: hash + size) that the other side fetches in chunks when it
needs it, over the link or by presigned URL from the hub's file store (ayepi files).

**Your question, should we use HTTP?** Not for system traffic. HTTP adds headers and a connection setup
to every small call and can't push to the system. One long-lived WebSocket is the efficient choice:
multiplexed calls, cancellation, server push and backpressure. HTTP stays for the browser API, large
downloads and an optional MCP face. On the wire, ayepi frames are JSON text today. That is already compact
for small packets (`{"id":"c3","type":"run","data":{…}}`). Binary frames (MessagePack or CBOR) would be
smaller and faster still, but they need ayepi support: see [Library asks](#g/library-asks).

### MCP for free

The system surface is deliberately a superset of MCP: fns ↔ MCP tools, resources ↔ MCP resources,
commands ↔ MCP prompts. So:

- **Every system can also serve MCP** (stdio or HTTP) with no extra code. Claude Code or any MCP client
  can use a system directly.
- **An MCP bridge system** connects any MCP server to the hub and presents it as a system.
- The **Claude Code system** is a wrapper: it runs Claude Code sessions and exposes them (list, read,
  send, interrupt) and imports Claude's agents, skills and MCP servers as context and fns.

### Building a system

A system package has three folders. The [system SDK](#g/the-system-sdk) section shows each one.

- `shared/`: its **contract**: name, types, fns, kinds, context and the rest, with no implementation.
  Other systems import it to call its fns with typed refs.
- `server/`: the process. It implements the contract and connects to the hub.
- `client/`: browser renderers, typed by the contract. The hub serves them to the chat UI.

`harness-system build` builds the server and client; `harness-system dev` runs it with reload. On
connect the hub reads everything from the contract, so nothing is registered by hand.

### Config, installed systems and lifecycle

- **Config.** A system declares a config type in its contract: what it needs before it can be used (the fs
  system's folders, a database URL, an API key).
  - **Needs a valid value first.** An admin sets the value in the hub, or a person does by asking in chat. The
    hub checks it against the type and refuses an invalid one. Until a valid value is set, the system shows as
    needing config (and admins get a notification), and its fns, mentions and hooks are unavailable.
  - **Passed along with the work.** The current value is in every context the system gets: `ctx.config` in a
    fn, method, action, hook, mention, dynamic context, event or lifecycle event, typed by the config type. The
    hub sends the value when the system connects and when it changes; each request then carries only the config
    version, so messages stay small. A run keeps the value it started with.
  - **Changes are announced.** When someone changes it, the system's `configured` event gets the new value and
    the previous one, so it can react if it wants to (watch new folders, reconnect to a new database).

  ```ts
  // shared/
  config: g.obj({ roots: g.list(g.obj({ path: g.text(), name: g.text(), writable: g.bool() })) }),
  // server/
  read: { async run(args, ctx) { const roots = ctx.config.roots; … } },
  lifecycle: { async configured(ctx) { watch(ctx.config.roots); unwatch(ctx.previous.roots); } },
  ```
- **Installed systems.** Some systems are installed with the hub: kept on disk under the hub's data folder and in
  its database, paired at install (the hub makes the key), started when the hub starts, and restarted if they
  crash (with backoff, and a limit per hour so a broken system doesn't loop). Admins install, configure, start,
  stop and upgrade them from the UI or by asking in chat. Systems that run elsewhere connect and pair as before.
- **Lifecycle.** A system can handle `installed` (first connect with a valid config), `started` (every connect),
  `configured` (the config changed), `stopping` (with a reason and a deadline: restart, upgrade, shutdown,
  removed), `upgraded` (first start of a new version) and `uninstalled`.

### Changing itself

Harness must be able to modify itself, or let Claude Code do it. The **fs system** (the first one
built) gives an agent read, write, edit, search and bash over folders, exposes those folders as
resources, and can **restart itself**. A restarted system reconnects, and the hub imports whatever is
new. An agent can add fns, kinds, context and renderers to a system's source and see them live after a
restart.

## Fns

A fn has a name, a description, a kind, a **payload** (the kind's definition data), and a **signature**
(gin args → gin result) that the kind derives from the payload. Signatures travel as gin JSON. The hub
stores them and rebuilds real gin types, zod schemas and LLM tool schemas from them when needed.

A fn also declares:

- **Deps:** the fns its implementation may call. Calls to anything else are refused. For a native fn
  the author lists them; for other kinds the kind works them out from the payload.
- **Handlers:** callbacks the *caller* can supply (for example "confirm overwrite?" or "pick a file"),
  each `required` or `optional`. A caller that can't answer a required handler can't call the fn. A
  user, an agent or code can answer them.
- **Progress:** none, linear (0–100%), or named steps, each with a status and sub-status.
- **Operations:** whether a run can be cancelled, paused, resumed or undone. These can change during a
  run, so the chat knows what the stop button will do.
- **Undo and resume payload types:** when a run finishes it may register an undo payload; the fn's undo
  implementation receives it later. A paused run returns a resume payload; resuming re-runs the fn with
  it.
- **State:** the fields of its system's session state it reads and writes. See [Session state](#g/session-state).
- **Form:** a type its renderer can submit back to the run while it waits.
- **Display:** how a finished run looks in the chat: its card, a plain message, or nothing.
- **Limits:** timeout, retries, and an estimated cost.

**Most of that is worked out by the kind.** Any system can define a kind, and any system (that one or
another) can add fns of it. A fn of a kind carries the kind's payload, and the kind's `describe` works out
everything else from it: signature, deps, the types and resources it references, handlers, progress,
operations, limits and display. So creating a fn needs only what the kind can't work out, usually the
payload, a name and a description. An *input* kind's payload might be just a gin type: no deps, no refs. A
*code* or *api* kind works out every fn and type its program references. The hub keeps the description with
the fn and recomputes it when the payload, or anything it references, changes. The fn runs on the system
that defines its kind, because that system owns the payload's handler. Native fns are the exception: their
author declares everything, because the code is the payload.

### Session state

Each system has a scratch pad per session: data its fns pass to each other without the LLM seeing it (the
working folder, the rows of the last query, a selection). A fn declares the fields it uses as a gin type,
and `ctx.state` reads and writes only those:

```ts
const Shell = g.obj({ cwd: g.text() });
cd:   fn({ …, state: Shell }),     // run: await ctx.state.set({ cwd: args.path })
bash: fn({ …, state: Shell }),     // run: const { cwd } = await ctx.state.get()
```

- **Fields are matched by name and type.** Two fns share a field only if both declare that name with the same
  type. A system's state may hold a hundred fields; each fn sees just its own.
- **Scoped to the system.** One system's state is invisible to every other system.
- **Safe to share.** `ctx.state.update(change)` reads and writes in one step, so runs working at the same
  time don't overwrite each other.
- **Undoable.** Changes are recorded on the run, so undoing a turn puts state back.
- **Live.** Renderers see their fn's fields, and they update as the state changes. Actions declare fields
  the same way.
- A run outside a session (a scheduled run) gets state scoped to its turn.

### Running a fn

The implementation receives typed args and a context:

- **who and when** (`ctx.run`): the person the turn is for (name, id, email, role, groups, time zone,
  locale), their current time (`now`, zone, and local time with its offset), this system, and the system and
  fn that called, if another system's fn did. The hub builds this from the signed-in user and what their
  browser reports (zone, locale, clock), and passes the same thing to actions, mentions, hooks and dynamic
  context
- **the budget**, for information only: what is left of the turn's money and time, and which budget is the
  tightest. The hub enforces LLM spend itself, so a system doesn't have to; `ctx.budget.spend()` reports
  costs the hub can't see (a paid API)
- typed callers for its deps (`ctx.fns.readFile(...)`) and for its handlers
- progress reporting and live operations
- an abort signal and a pause hook
- the resume payload, if it is being resumed
- services: file operators, fetch, resources, the hub's LLM (through the aeye provider), attachments,
  logging

It returns an **outcome**: done (result, cost, optional undo payload), paused (resume payload), failed
(error plus whether to retry, tell the caller, or stop the turn), or cancelled.

### Calling other fns

A call from inside a fn goes to the hub and is queued like every other run. That is how the hub sees
the whole tree, applies permissions and budgets, and logs everything. The call returns a **handle**: run
info, a result promise, and cancel and pause.

Pausing while code is blocked on a call: the hub asks the waiting fn's pause hook for its state. The fn
returns a resume payload, and the pending promise rejects with a special `Suspended` error the runtime
ignores. Later the fn runs again with its resume payload. Each child call has a **key**, so a resumed run
gets the results of children that already finished instead of calling them again.

### Kinds

A kind decides what a fn's definition looks like and how it runs.

- **`native`:** a fn its system implements in code. Every system has it, the hub included (the hub's
  own fns, like search and configuration, are native fns of the system `hub`). Fully type-checked.
- **`hub/llm`:** an agent: instructions, model, tools, context and an output type. The chat agent is
  one. Any system can declare agents with `agent()`.
- **System kinds:** a system can add a kind with its own payload type and run every fn of that kind.
  Later: `api` (a gin program that builds an HTTP request, as designed in product), `query` (the
  database system), and the rest of product's kinds.

A native fn is typed end to end. A fn of another kind is typed as far as its payload and the args and
result its author expects. What the payload really produces is only known at runtime, so the hub checks it
against those expectations when the fn is declared.

## The system SDK

This is the surface other people build on, so it must read well and refuse mistakes. Three rules:

1. **One source of types.** Every shape is written once as a gin type with `g`. Args, results, handler
   shapes, payloads, settings, attachments and renderer props are all inferred from it.
2. **Refs, not strings.** Everything a contract declares gets a typed ref (`fs.fns.read`,
   `fs.context.guide`, `fs.settings.shell`). References between things are refs, so a reference to
   something that doesn't exist doesn't compile, and a call through a ref has typed args and result.
3. **The contract declares, the server implements.** Everything declared must be implemented, and
   nothing can be implemented that wasn't declared.

### The contract (`shared/`)

`system(name)` starts a contract and `.with(...)` adds to it: types, settings, attachments, kinds, fns,
context, hooks, mentions, embedders and sectioners. `.with` can be called again with a function that
receives the refs declared so far, so later declarations can use earlier ones. From `types/fs.ts`:

```ts
export const fs = system('fs', { description: 'Files and a shell over chosen folders.' })
  .with({
    types: { Entry },
    settings: { shell: setting({ description: 'Which commands run without asking.', type: g.obj({ allowed: g.bool(), safe: g.list(g.text()) }), appliesTo: ['user', 'group'], merge: 'most-restrictive' }) },
    attachments: { diff: attachment({ description: 'A change to a file.', data: g.obj({ path: g.text(), before: g.text(), after: g.text() }) }) },
    fns: {
      read: fn({ description: 'Read a text file.', args: g.obj({ path: g.text(), offset: g.optional(g.num()) }), returns: g.obj({ text: g.text(), lines: g.num(), truncated: g.bool() }) }),
      edit: fn({ description: 'Replace exact text in a file.', args: …, returns: …, undo: Previous }),
      bash: fn({ description: 'Run a shell command.', args: …, returns: …, progress: linear,
        handlers: { confirm: handler({ description: 'Run this command?', args: g.obj({ command: g.text(), reason: g.text() }), returns: g.bool(), required: false }) } }),
      …
    },
    hooks: { git: hook({ description: 'Adds the current branch and changed files.' }) },
  })
  .with(({ fns }) => ({
    context: {
      guide: context({ description: 'How to work with files here.', content: 'Read before editing…', fns: [fns.read, fns.edit] }),
      tree: context({ description: 'The folder tree, as it is now.', command: { name: 'tree', args: { root: arg('Which root', { required: false }) } } }),
    },
    fns: {
      explore: agent({ description: 'Answers questions about the code.', args: g.obj({ question: g.text() }), returns: g.text(),
        instructions: 'Answer {{args.question}} by reading the code.', tools: [fns.read, fns.grep, hub.fns.search_resources] }),
    },
  }));
```

What a fn declares changes what it can do, and the types follow:

- **`undo` type** → the fn is undoable, and the server **must** implement `undo`.
- **`resume` type** → the fn can pause; without one, `ctx.pause(...)` doesn't compile.
- **`progress`** → `linear` gives `ctx.progress.set(0.4)`; `steps({ read: 'Read', write: 'Write' })`
  gives `ctx.progress.step('read', 'active')` with only those names.
- **`handlers`** → a required handler must be passed by every caller; an optional one may be missing,
  so the fn has to check before calling it.
- **`deps`** → the only fns `ctx.fns` can call.
- **context without `content`** is dynamic: the server must implement it, with the command's args typed.
- **`state`** → `ctx.state` reads and writes exactly those fields, typed.
- **`form`** → `await ctx.form()` waits for the renderer's submit; without one, `ctx.form` doesn't exist.
- **`actions`** in the contract → each must be implemented, and every renderer of the system can send them.

### The server (`server/`)

`serve(contract, impl, options)` connects to the hub (pairing the first time) and serves the
implementation. The implementation's type is computed from the contract. From `types/examples.ts`:

```ts
await serve(fs, {
  fns: {
    read: {
      async run(args, ctx) {                       // args: { path: string; offset?: number; … }
        const text = await ctx.files.readText(args.path);
        return ctx.done({ text, lines: …, truncated: false });   // the result is checked
      },
    },
    edit: {
      async run(args, ctx) {
        const previous = await ctx.files.share(args.path);
        …
        ctx.attach(fs.attachments.diff, { path: args.path, before, after }, 'Edited');   // data is checked
        return ctx.done({ replacements: 1 }, { undo: { path: args.path, previous } });
      },
      async undo(payload) { … },                    // required: edit declares an undo type
    },
    bash: {
      async run(args, ctx) {
        const shell = await ctx.setting(fs.settings.shell);       // { allowed; safe } | undefined
        if (!safe && !(ctx.handlers.confirm && await ctx.handlers.confirm({ command: args.command, reason: '…' }))) {
          return ctx.fail('caller', 'The command needs confirmation.', { code: 'denied' });
        }
        …
      },
    },
    …
  },
  context: { tree: async (args) => `tree of ${args.root ?? 'all roots'}` },   // args: { root?: string }
  hooks: { git: async () => [{ type: 'text', tag: 'git', text: 'branch main, 2 files changed' }] },
  resources: { roots, list, stat, read },
}, { hub: 'ws://hub:4100', state: '.system' });
```

A run's `ctx` holds:

- `ctx.fns`, `ctx.handlers` and `ctx.progress`, typed by the fn.
- `ctx.done`, `ctx.fail`, `ctx.pause` and `ctx.cancelled`, which build the outcome object with the
  fn's result, undo and resume types.
- `ctx.budget` and `ctx.signal`.
- `ctx.onPause`, `ctx.allow` (narrow what can be done right now) and `ctx.undoWith`.
- The services: `ctx.llm`, `ctx.files`, `ctx.fetch`, `ctx.resources`, `ctx.attach`, `ctx.link`,
  `ctx.setting` and `ctx.log`.

Calling another system's fn: declare it as a dep with its ref, then `await ctx.fns.copy(args, options)`.
The call is awaitable for its typed result, and it is also a handle with `run`, `settled`, `cancel`,
`pause` and `watch`. If the dep has a required handler, the options with that handler are required.

### Renderers (`client/`)

The chat UI is Vue, and so are renderers. `client(contract, renderers)` registers Vue components, and each
component's props are typed by the contract: a fn renderer gets that fn's args, result and progress, an
attachment renderer gets its data, and an input for a named type works with `v-model`. Props are
reactive, so a running fn's renderer updates as progress and the result come in. A component with the wrong
props doesn't compile. A system's client build keeps `vue` external, so its components share the chat's Vue.

```vue
<!-- client/BashView.vue -->
<script setup lang="ts">
import type { FnViewOf } from '@harness/sdk';
import type { fs } from '../shared';
const view = defineProps<FnViewOf<typeof fs, 'bash'>>();   // args: { command; cwd?; timeout? }, result?: { exitCode; stdout; stderr }
</script>
<template>
  <pre>$ {{ view.args.command }}
{{ view.result?.stdout }}</pre>
  <progress v-if="view.progress" :value="view.progress.fraction" />
</template>
```

```ts
// client/index.ts
export default client(fs, {
  fns: { bash: BashView },
  attachments: { diff: DiffView },     // defineProps<AttachmentViewOf<typeof fs, 'diff'>>()
  inputs: { Entry: EntryInput },       // defineModel<Infer<typeof Entry>>()
});
```

### Talking back to the system

A renderer can call code on its own system. Two ways, both typed by the contract, both through the hub:

- **Actions.** A system declares typed messages its renderers may send (`rerun`, `approve`, `save`) and
  implements them. Any renderer sends one with `view.system.send.rerun({ command })` and gets back a
  **delivery**: its status (queued, delivered, done, failed) is live, and `delivery.result` is the typed
  result. The hub **stores every message before delivering it**, so nothing is lost: if the system is
  offline, it waits and is delivered, in order, when the system connects. `view.system.online` says which.
- **Forms.** A fn that declares a `form` type can be shown as a form: the run waits in `await ctx.form()`, the
  renderer calls `view.submit(value)`, and the run carries on with the typed value. A tool can be just a form
  the user fills in, with the agent getting the answer as the tool's result.

Everything a renderer sees is live: the run's status, progress and result, its state fields, and its
deliveries. A renderer can change as the run goes, and `display` decides what stays once it's done: the card,
a plain message, or nothing.

```ts
// a fn shown as a form; the agent gets the user's answer as the result
approve: fn({ description: 'Ask the user to approve a deploy plan.', args: g.obj({ plan: g.text() }),
  returns: Decision, form: Decision, display: 'message' }),
// server: async run(args, ctx) { return ctx.done(await ctx.form()); }
// renderer: view.submit({ approved: true, note: 'ship it' })
```

### Resource viewers

Viewers are shared by format: a resource is shown with the viewer for its format, whichever system serves it.
The hub ships viewers for the common formats (text, markdown, code, images, PDF, JSON, CSV, folders), so most
systems need none. A system adds viewers for its own formats with `resources` in `client()`, and every other
system's resources in that format use them too. Inside any renderer, `ResourceViewer` shows a resource with the
right viewer: `<ResourceViewer :uri="uri" compact />`.

### Mistakes that don't compile

`types/examples.ts` checks each of these, and that each fails for the stated reason:

- calling a fn that isn't a dep, or with wrong args
- calling a fn with a required handler without passing it
- calling an optional handler without checking it exists
- reporting a progress step that wasn't declared, or step progress on a linear fn
- returning a wrong result, or pausing a fn with no resume type
- leaving out `undo` on a fn that declares an undo type
- leaving out any declared fn, kind, dynamic context, hook or mention provider
- a mention target of the wrong shape, or reading a field the target doesn't have
- reading or writing a state field the fn didn't declare, or writing the wrong type
- waiting for a form on a fn that doesn't declare one, or submitting the wrong shape
- sending an action the contract doesn't declare, or with the wrong input
- leaving out the implementation of a declared action, or of a type's method
- a type display naming a field the shape doesn't have
- calling a type's method without the value (`self`)
- implementing anything the contract doesn't declare
- attaching data of the wrong shape
- a renderer for something the contract doesn't have, or a component whose props don't match

## Sessions and the chat

- **A session** has participants (users and agents), an agent fn that answers, **enabled systems**
  (only their fns, context and inputs apply), a priority and budgets.
- **A session-wide budget** (for its whole life, or per time window) shrinks each message's budget as it is
  used up. See [Priority and budgets](#g/priority-and-budgets).
- **Who answers.** With one person in the session, its agent answers every message. With more than one
  person, agents stay quiet unless addressed. An agent answers a message that **replies to one of its own
  messages**, and every agent answers a **reply-all**. People are notified of every message, of replies to
  their own messages, or of nothing, as they choose.
- **Turn flow:** a user message creates a turn. Hooks add their information, the LLM request is queued
  at the session's priority, and tool calls become runs.
- **A new user message while tools run** moves those runs to the **background**. The agent gets a "still
  running" result per run plus the new message, and can answer right away. Background runs report back
  when they finish.
- **Global tool timeout:** if a run passes the timeout *and* a user is active in the session, the agent
  is unblocked the same way.
- **Pause and cancel** on the session are offered only as far as the running runs support them. Cancel
  stops what can stop; the rest finishes and is reported.
- **Undo a turn:** every run with an undo payload is undone, newest first. The chat reports what was
  created, updated and removed.

### What gets added to a message

Before the LLM sees a user message, two things may add to it:

- **The hub itself**, whenever it can, with no system involved: the person's local time and time zone, and
  suggested context and fns (from the index).
- **Systems' hooks**: a system can declare a hook and add its own information (the git branch, the open
  ticket). A hook gets the message and the same who-and-when every run gets.

Each addition is a small tagged block in the message, so the model can tell it apart from what the user
typed.

### Chat inputs

- **`@`** points at a thing a system knows about: a file, a database row, a ticket. It isn't for
  people. See [Mentions](#g/mentions).
- **`/name args`** pulls in context with that command.
- **`!fn`** opens an input form for the fn's args. The chat has an input for **every gin type**, and
  systems can register custom inputs for their own types.
- **Attachments:** fns can attach things to the assistant message, such as links to resources, files or
  runs, which render as clickable cards.
- **Renderers:** systems supply renderers for their fns' calls, for resource formats and for
  attachments.

### Types

A system declares named types with `type()`: a shape, how values are shown, and methods.

```ts
Customer: type({
  description: 'A customer account.',
  shape: g.obj({ id: g.text(), name: g.text(), plan: g.enum('free', 'pro') }),
  display: { label: 'Customer', plural: 'Customers', icon: 'building', color: '#2f6fde', title: 'name', subtitle: 'plan' },
  methods: { upgrade: fn({ description: 'Move to the pro plan.', args: g.obj({}), returns: g.bool() }) },
})
```

- **Display** gives the type's name for people, an icon and a color, and which fields name a value (`title`
  and `subtitle` must be fields of the shape). Mention chips and cards use it now; widgets will later.
- **Methods** are native fns called on a value: the server implements `run(self, args, ctx)`. A person can
  run them from a mention's card (only those they're allowed to), and code can call them through the type's
  ref: `deps: { upgrade: crm.types.Customer.methods.upgrade }`, then `ctx.fns.upgrade({ self: customer })`.
  They are offered to the LLM only when their `visibility` says so. The hub also registers them as gin
  methods, so gin programs (the later `api` kind) can call them.
- A type ref is a gin type itself, so other systems can use it as a field: `g.obj({ customer: crm.types.Customer })`.

### Mentions

Typing `@` searches the mention providers of the session's systems. Each mention has three views, all
supplied by the system that owns the thing:

- **The chip** shows a friendly name ("Acme Corp", "harness.md").
- **The hover card** is for the person: the system is asked for details when the chip is hovered, so they
  are current (title, a few fields, a short preview, and where clicking goes). A system can draw its own
  card with a Vue component.
- **The LLM text** is written by the system when the message is sent and embedded in the user message in
  place of the chip, so the model knows exactly what the thing is and where it lives:

  `<mention provider="crm/rows" label="Acme Corp">Row 42 of table customers in the crm database (system crm). Customer "Acme Corp", 3 open orders.</mention>`

A provider can say what type its things are (`of: types.Customer`). Then the chip and the card use the type's
label, icon and color, and when `hover` returns the thing as a value, the card offers the type's methods.

What's stored is the system's own key for the thing (a path; a table and an id), typed by the provider:

```ts
// shared/
mentions: { rows: mention({ title: 'Customers and orders', description: '…', target: g.obj({ table: g.enum('customers', 'orders'), id: g.text() }) }) }

// server/: target is typed { table: 'customers' | 'orders'; id: string } in all three
mentions: {
  rows: {
    async search(query, ctx) { return [{ label: 'Acme Corp', hint: 'customers', target: { table: 'customers', id: '42' } }]; },
    async hover(target, ctx) { return { title: 'Acme Corp', subtitle: `customers #${target.id}`, fields: [{ label: 'Open orders', value: '3' }] }; },
    async llm(target, ctx) { return `Row ${target.id} of table ${target.table} in the crm database (system crm). …`; },
  },
},
```

Search, hover and LLM text all run as the person mentioning, so they only show what that person may see.

### What the UI offers

The chat UI is fully driven by the hub. The hub tells the UI which features exist right now: voice only
if a transcription service is configured, `@` only if a mention provider is connected, and so on.

### Configuring by asking

Everything an admin configures can also be done by asking in chat, through the hub's native fns: providers,
model categories, transcription, web search, systems, pairing, priorities, budgets, policies, actor settings.
These always need approval.

### Push notifications

The hub sends web push notifications: approval or input needed, a reply to your message, a turn finished while you
were away, a system waiting for pairing, a budget reached.

## LLM calls and budgets

- **One place for LLM calls.** The hub's LLM queue is the only caller of real providers. Systems and
  `llm` fns go through it.
- **Priority:** every LLM request has one. Interactive chat comes before background work.
- **The hub enforces budgets.** Before each LLM call it reserves an estimate against every budget that
  applies, and settles the real cost after. Systems are told what's left only so they can choose; they
  never have to enforce it.
- **Everything is saved:** every LLM interaction (request, response, usage, cost, timing) and every run
  (args, outcome, progress, timing, cost, errors). The **fn tree** of a turn is a query away.
- **Providers and models** are configured on the hub (or by asking in chat) and come from aeye.

### Priority and budgets

Priority and budgets can be set at each level a turn passes through: the **hub**, the user's **groups**, the
**user**, the **session** and the **turn** (and budgets also on a system, a fn or a model). A budget counts
money (and optionally tokens or calls) over a rolling **window**, over **all time**, or **per turn**. With
that many levels, the rules make sure there is always exactly one answer.

**Priority**

1. The priority comes from the most specific level that sets one: turn, session, user, the user's groups (the
   highest among them), then the hub.
2. Any level can set a ceiling (`max`). The lowest ceiling wins; among groups, the highest one counts, because
   membership grants.
3. The turn runs at its priority, lowered to the ceiling if it is above it.

**Budgets**

1. Every window and all-time budget that applies counts at once, and no spend may take any of them over:
   - the hub's
   - the session's total
   - the user's
   - every **pooled** group budget the user shares with other members
   - the most generous **each-member** group allowance
2. The per-turn cap is the lowest **per-turn** budget across the levels. A session can lower what one message
   may spend, but not raise it above the user's or the hub's cap.
3. A turn's budget is that cap, lowered to the least that is left of every other budget. So as a session's
   total is used up, each message's budget shrinks.
4. When a budget is reached, the request waits for the window to free up, is refused, or asks someone to
   raise it, as the budget says.

The resolved priority and budgets are stored on the turn, and the chat's budget meter shows which one is
the tightest.

## Actors and permissions

- **Actors** are a core table: users, groups, agents and systems (the hub is one). A user is in zero or more
  groups.
- **Policies** decide whether an actor may run a fn: allow, deny or ask. "Ask" names who decides: the
  user who started the turn, a specific actor, a group, an LLM judge (an `llm` fn), or the hub itself.
  Policies match fns by name, system, kind or tag.
- **Approvals** are records. "Always" turns into a policy.
- **Actor settings** are typed values systems declare and attach to actors, set by an admin or by a fn.
  For example, the database system declares row and field access rules; an admin sets them per group.

## Content: resources, sections and context

- **Resources are content.** Systems serve them at absolute URIs. Folders, files, pages and code are all
  treated the same: a resource may have **contents** and **links** to other resources (a folder links to
  its children, code links to what it imports). The hub can ask for links alone; a system may include
  contents for free.
- **Sections** cut a resource into stable pieces. A user picks a sectioning rule per format (headings,
  code symbols, pages, paragraphs, or a system's own). A section's key comes from structure (the
  heading path, the symbol name), not position, so it stays the same when content moves. A new version is
  compared by key: sections are added, changed or removed, and anything derived from a changed section is
  marked stale.
- **Context is content available to the LLM.** It is authored or taken from sections. Context can
  **mention or import** other context and fns, so loading it brings those along (a "skill").
- **Indexing:** the hub embeds fns, context and sections with an embedder (from a provider or a system)
  and searches them for suggestions, `get_fn`/`get_context`-style tools and `@` mentions.

## Storage

The hub keeps everything in one generic database through a small store port. SQLite is the default;
Postgres can come later. Vector search uses the database's vector extension (sqlite-vec by default).

## The libraries

Harness uses `@aeye` and `@ayepi` for everything they offer, following ayepi's rule: **zod schema first,
types derived from it**. See [Library map](#g/library-map) for the exact mapping.

## Library map

| Need | Library | How |
|---|---|---|
| Hub API, browser API, system link specs | `@ayepi/core` | `spec` / `endpoint` / `events`; zod schemas first, types derived. The browser uses the zod-free client with `wsTransport`. |
| System link both ways on one socket | `@ayepi/core` | The system runs `server(systemLinkSpec)` fed through `app.ws.open/message` with no listener, and `client({ ws })` with a custom `ClientWs`. A small envelope routes frames. |
| Hub modules (auth, sessions, queues, systems, budgets) | `@ayepi/plugin` | One plugin per module, installed in dependency order; `provide` for services. |
| LLM queue and run queue | `@ayepi/work` | Priority via `priorityDoer`; tool calls fan out and `.next(…, 'all-done')` queues the next iteration; `WorkDelayError` for limits and 429s; deadlines; DLQ. Cancel is the hub's own registry (work has none). |
| Rate of calls | `@ayepi/rate` | `rateLimitedDoer` caps call starts per model and provider. Dollar limits are a hub ledger (rate counts calls only). |
| Users and systems | `@ayepi/auth` | Bearer JWTs for the browser (HTTP and ws) and short system tokens. Passwords, refresh, revocation and pairing are the hub's. |
| Uploads, attachments, content refs | `@ayepi/files` | `fsFiles` + `mountFiles` presigned routes. |
| Config | `@ayepi/env` | `HubConfig` and every tunable, defaults in the schema. |
| Logs, traces | `@ayepi/log`, `@ayepi/otel` | `console.*` interception with trace context; redaction of secrets. |
| Startup and shutdown | `@ayepi/updown` | Store, work, server and system links in dependency order. |
| A system as an MCP server | `@ayepi/mcp` | `mcpServer` + `serveStdio` over the system's own spec (tools only today). |
| UI work before systems exist | `@ayepi/mock` | Fake data from the spec. |
| LLM loop | `@aeye/core` | Each `hub/llm` run is an aeye `Prompt`. Its tools are built from fn signatures; `onToolIntercept` turns each call into a queued run and throws `PromptSuspend`; when the runs settle, the next LLM job re-runs the prompt with the tool results appended. aeye keeps doing argument repair, retries, schema fallbacks and context trimming. |
| Providers, selection, cost | `@aeye/ai` + providers + `@aeye/models` | One `AI` on the hub. `beforeRequest` reserves budget; `afterRequest` settles it and saves the `LlmInteraction`. |
| The hub as a provider | `@aeye/ai` `Provider` | `HarnessProvider` on systems forwards over the link: tool and output schemas go as JSON schema, and the hub returns chunks, the schema descriptors it used and the real cost. |
| Types and signatures | `@aeye/gin` | Wire `TypeDef`s stored by the hub; `registry.parse` in a per-system scope; `toValueSchema` → zod → aeye `toJSONSchema` for tool schemas; `compatible` checks re-declared fns and types. |
| Typed authoring | harness SDK over gin | gin has no static inference, so the SDK's `g` builder keeps the TS type (`GinType<T>`). |
| Reading and cutting resources | `@aeye/resources` | Parsers (pdf, docx, html, code…), link extraction and the graph builder. Sections are keyed by structure in the harness, because aeye's slice ids are ordinals. |
| Database system (later) | `@aeye/query` | Query tool, RLS and field access through its backing hooks. |

### How a turn runs

1. The browser sends a message. The hub creates a turn, runs the hooks and queues an LLM job at the
   session's priority.
2. The LLM worker reserves budget, runs one iteration of the agent's aeye prompt and saves the
   interaction. Each tool call becomes a run. The run is checked against policies (and may wait for
   approval), then queued.
3. The run worker sends each run to its kind's system, or runs it in the hub. Child calls come back
   through the hub and are queued the same way.
4. When every run of the iteration has settled or gone to the background, the next LLM job is queued
   with the results. A new user message, or the global tool timeout while a user is present, moves the
   rest to the background early.
5. The turn ends when the agent answers without tool calls.

## Library asks

What @aeye and @ayepi don't do yet that harness needs. Each gets fixed in the library itself, in the local
checkout harness links to, so no publish is needed.

Done, on the libraries' `harness` branches:

- **ayepi core: two-way calls on one socket** (peers, and a client that serves calls).
- **ayepi rate: weighted hits**, so a limit counts dollars or tokens, not just calls.
- **ayepi work: cancel** for queued and running work, and **sqlite ports** (`Queue`, `Store`, `PubSub`, a rate store).
- **ayepi mcp: resources, prompts, Streamable HTTP**, a tool list that follows hot installs, and an **MCP client**.
- **aeye gin: static inference** from the builders, so `g` is gin's own builder.
- **aeye resources: stable section ids** and TS import resolution (extensions and index files).
- **JSON schema → zod:** zod 4.6's `fromJSONSchema` covers it; the SDK's LLM wire uses it.

Still open:

- **ayepi core: binary frames** (MessagePack or CBOR) for the ws protocol.
- **ayepi: web push** (VAPID). The hub uses the `web-push` package directly for now.
- **aeye resources: a folder resolver.**

## Later

- **Database system:** query tool, saved queries, custom types, row- and field-level rules as
  expressions, mapping a hub user to a database user (required or not), and public or private types. The
  admin sets this up and can change it through fns.
- **MCP bridge system** and **Claude Code system** (described above).
- **Web system:** fetch and web search.
- **Scheduled fns and trigger fns.**
- Product's other kinds (`api`, `query`, `code`, `input`, …).

## Build order

1. **Library prep.** zod on its latest version everywhere (aeye, ayepi, harness), and two-way calls over one
   socket in ayepi.
2. **The first milestone, all of it together:**
   - the hub core: store, actors, sessions, turns, the LLM queue and the run queue, the `native` and `llm`
     kinds, budgets and priorities, permissions, pairing, installed systems
   - the system SDK: contracts, refs, `serve`, `client`, the build, MCP serving
   - the fs system, including self-restart
   - **the chat**: Vue, realtime everywhere (streaming tokens, live runs, progress, state and deliveries),
     every run and LLM call tracked and inspectable in its tree, and a UI that feels alive and looks good on
     every screen size, from a phone up. Its feature list starts from what the chats in aeye's Cletus and in
     product already do, rebuilt in Vue.
3. Tests throughout: unit tests with injected seams, no live network.

Status (2026-11-07): steps 1 to 3 are built and run together (`npm run dev`).

- **Library prep:** done. zod 4.6.7 in aeye, ayepi and harness; two-way calls, weighted rate hits, work cancel
  and sqlite ports, MCP resources/prompts/HTTP/client in ayepi; gin's typed builders and resources' section ids and
  import resolution in aeye. What is still open is under [Library asks](#library-asks).
- **First milestone:** the hub core, the SDK, the fs and embedder systems and the Vue chat and admin app are built.
  The chat agent streams answers, reads and searches files, runs commands with approval, suggests fns and context
  from the embedded message, and shows every run and LLM call live in its tree.
- **Tests:** unit and web tests (`npm test`, with coverage), minimal live tests on a free OpenRouter model and the
  local embedder (`npm run test:live`), the end-to-end suite over the real stack (`npm run e2e`), and a puppeteer
  script per UI feature at every screen size (`npm run ui-tests`).

## Risks and proofs of concept

What could make the design not work as written, with what was decided about each.

1. **One socket, both ways.** Decided: everything is plain request and response through ayepi, events only
   where no answer is needed, and two-way calls over one socket get added to ayepi. *POC:* two processes
   calling each other over one socket; kill and restart each side mid-call and check every run settles exactly
   once.
2. **The agent loop on aeye, one iteration per queued job.** Each tool call becomes a queued run, so the prompt
   stops (`PromptSuspend`) and resumes later from saved messages. aeye re-renders the system message and resets
   its retry counters on every run, and `forget()` may trim saved history. *POC:* a real model, three tools,
   suspend on every call, resume in a new process, compare with an uninterrupted run.
3. **Three copies of zod** (aeye 4.1.12, ayepi 4.4.3, harness 4.6.7). Decided: everything moves to the latest
   zod first.
4. **The hub as an aeye provider.** Tool and output schemas cross the wire as JSON schema and come back as zod
   (zod's `fromJSONSchema`), and strict-mode descriptors chosen on the hub reach the system's aeye. *POC:* a
   system-side prompt with a tool and structured output, through the forwarding provider, against strict mode.
5. **The `g` builder.** `g` returns real, in-memory gin types carrying their TS type; gin gives the JSON
   definition, JSON schema and value parsing from them. *POC:* every builder round-trips through gin JSON and
   tool schemas, and gin's compatibility check accepts and refuses re-declared types as expected.
6. **Pause and resume by call key.** A resumed fn re-runs its code and gets finished calls back by key, so code
   must call in the same order with the same keys. *POC:* a fn paused after its second call resumes without
   repeating the first two. Decide then whether keys are required for pausable fns.
7. **System renderers.** Decided: renderers are trusted. An admin can turn off a whole system, only its
   renderers, or only its functions (keeping its renderers so old messages still look right). *POC:* a system's
   client build loaded into the chat through the hub, sharing the chat's Vue.
8. **Vectors.** Decided: SQLite with `sqlite-vec` is fine for now (embeddings will be 768-dimensional, from
   EmbeddingGemma 300M later), with Postgres and pgvector swapped in later behind the same store port. Checked:
   it loads and runs on Windows (20,000 vectors inserted in 73 ms). The SQLite work queue still gets a load test.
9. **The self-modifying fs system.** Installed systems keep the last version that started cleanly and roll back
   to it after repeated crashes.
10. **Budget estimates.** Reserve with a margin, settle exactly, allow a small overrun rather than block.
11. **Scope.** The first milestone is the whole of step 2 of the build order. Everything marked later stays
    types only.

Already checked: type-checking all of the types and examples takes about two seconds.

## Decided

- **Kinds derive fns:** a fn of a kind needs only what the kind can't work out (usually just its payload);
  the kind's `describe` supplies signature, deps, referenced types and resources, handlers, progress,
  operations, limits and display, and the hub recomputes it when the payload or its references change.
- **Name:** plugins are **systems**; the main server is the **hub**, itself a system named `hub`.
- **Kinds:** code-backed fns are kind `native` (the hub's own fns too), agents are `hub/llm`, and systems
  can add more. A fn declared at runtime belongs to, and runs on, the system that defines its kind, because that
  system has the kind's handler.
- **Agents in multi-person chats** answer only a reply to their own message, or a reply-all.
- **Libraries:** harness links the local aeye and ayepi repos (`file:../aits/packages/*`,
  `file:../ayepi/packages/*`). Shortcomings get fixed in those repos and are picked up through the link, with
  no publish needed.
- **UI:** Vue, and system renderers are Vue components. Resource viewers are shared by format; the hub ships
  the common ones.
- **Groups and limits:** a user in several groups gets the highest group priority and the highest group
  ceiling. Group budgets are either pooled (one pot shared by the members, and it always applies) or per
  member (each member's own allowance; a user in several gets the most generous one).
- **Permissions:** with no matching policy, fns tagged `read` are allowed; anything else asks the turn's user. Agents (`hub/llm` fns such as `hub/chat`) are allowed too, because an agent acts only through its tools and each tool call is checked on its own.
- **Database:** SQLite through `better-sqlite3` (the fastest Node driver) with `sqlite-vec` for vectors, behind
  the `HubStore` port, with Kysely for typed queries so Postgres with pgvector can take over for large
  databases.
- **Talking to systems:** plain request and response through ayepi; events only when no answer is needed.
- **zod:** the latest version everywhere.
- **Renderers are trusted;** an admin can turn off a system's functions, its renderers, or both.
- **Vectors:** `sqlite-vec` now (768 dimensions), Postgres with pgvector later.
- **Embeddings (first milestone):** product's EmbeddingGemma-300m service (local, 768 dimensions), wrapped as an
  `embedder` system, so embedders come from systems as designed.
- **Library changes** land on a local `harness` branch in aits and ayepi, linked into harness, not pushed.
- **gin types:** `g` is gin's own builder with full TS inference (added to gin), exposing all of gin: constraints,
  defaults, generics, docs. gin reports the named types a type references, so a system can load them from the hub.
  Fns receive plain values gin has checked (dates and timestamps as `Date`).
- **Look:** calm and modern, light and dark following the device, one accent color, subtle motion.
- **Auth:** a single admin account for now; SSO later.
- **System config:** a system declares a config type and can't be used until a valid value is set. The value is
  in every context as `ctx.config`, and the `configured` event announces changes.
- **Installed systems:** the hub can install systems, keep them on disk and in its database, start them with the
  hub, and restart them; systems have lifecycle events.
