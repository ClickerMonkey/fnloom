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
member. The first milestone and build 2 are built (see [Build order](#g/build-order)); build 2's design and the
status of each of its items are in [plans/build-2-design.md](plans/build-2-design.md), its contracts are in
`@harness/core`, and its types are in the explorer under the "Build 2" groups.

**Status:** builds 1 and 2 running together (`npm run dev`). What was decided is under [Decided](#g/decided).

## What carries over from product, and what doesn't

Harness borrows ideas from `product` but starts fresh:

- **Kept:** everything is a fn; fns have kinds; gin types for every signature; a record of every call
  (the fn tree); approvals; undo; callbacks (here: handlers); background runs; context with commands;
  @ / / / ! chat inputs; budgets.
- **Changed:** product's core was one interwoven process. Harness is a small hub plus loosely coupled
  systems that talk over one small protocol. Fn kinds live in systems, not in the hub. The hub ships
  only two kinds (`native` and `llm`).
- **Dropped for now:** apps, components, plans, widgets, dashboards, fn authoring agents, the database-first
  design. A database system comes later. (The graph contextor came back in build 2.)

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
| **Form** | Something made from a resource's raw content for people and LLMs: its markdown, tables or pages, or a model's description, text-in-image or transcript. |
| **Instance** | One attached copy of a system (`fs@laptop`). A system that runs one copy has the instance `main`. |
| **Chat mode** | How fns reach the model: strict native tools, or the static toolset with fn cards and `run`. |
| **Contextor** | What one prompt holds: the plain transcript, plus suggestions, or a graph selection under the model's budget. |
| **Model call** | One call to a model of any modality (chat, embeddings, images, transcription, speech), recorded by the hub. |
| **Hub MCP** | An MCP endpoint an admin makes on the hub, with its own route, secret and rules over what it exposes. |

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
- **Hub MCPs.** An admin can make MCP endpoints on the hub itself, each at its own route (`/mcp/<slug>`) with its
  own secret and include/exclude rules over systems, fns, types, context and resources. Through one, an MCP client
  (for example the Claude sessions a Claude system starts) talks to the hub, and every tool call is a real run with
  the MCP's person's permissions, approvals and budgets, attributed to the MCP. Fns that change what an MCP can reach
  (tagged `admin`) are never exposed; a hidden tool is a refused tool. A grantee system can mint short-lived,
  labelled session tokens from an MCP so its secret never leaves the hub. Use a hub MCP whenever the hub runs; a
  system's own MCP face is for using one system with no hub.


### Building a system

A system package has three folders. The [system SDK](#g/the-system-sdk) section shows each one.

- `shared/`: its **contract**: name, types, fns, kinds, context and the rest, with no implementation.
  Other systems import it to call its fns with typed refs.
- `server/`: the process. It implements the contract and connects to the hub.
- `client/`: browser renderers, typed by the contract. The hub serves them to the chat UI.

`harness system build` builds the server and client and `harness system pack` zips them (see [System folders,
packages and data](#g/system-folders-packages-and-data)). On connect the hub reads everything from the contract, so
nothing is registered by hand.

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

### System folders, packages and data

A system is a folder in one shape, which is also what is zipped and installed:

```
systems/<name>/
  system.json   name, version, description, link protocol, server and client entries, one instance or many
  package.json  npm dependencies and scripts (development only)
  shared/       the contract
  server/       the process (server/main.ts)
  client/       renderers (client/index.ts, optional)
  dist/         what `harness system build` makes and `pack` zips
```

- **`system.json` is the one source** of a system's name and version; its contract's name must be the same (the build
  and `serve()` both check).
- **Config lives in the hub's database**, never in a file in the folder.
- **Data:** the hub gives each installed instance its own folders outside the package:
  `systems/<name>/instances/<instance>/{state,data,cache}` in the hub's data folder, beside
  `systems/<name>/versions/<version>/`. Upgrades and rollbacks keep them. A system stores whatever it likes in
  `ctx.dataDir` (files, SQLite); `ctx.cacheDir` is for what can be rebuilt. Portability comes from the folder being
  known: the hub exports an instance's data with its config as a zip (after asking the system to quiesce, the
  `exporting` lifecycle event) and installs it back.
- **The `harness` CLI:** `harness system new <name>` copies the template system, `build` typechecks and bundles the
  server and client into `dist/`, `pack` hashes every file and zips `dist/`, `install <zip|dir|npm>` installs on a
  running hub (zips are checked: format, link protocol, every file's hash, no path leaving the folder),
  `export-data` downloads an instance's data, and `list`, `start`, `stop`, `upgrade`, `uninstall` wrap the admin
  endpoints. `harness mcp <slug>` bridges a hub MCP to stdio.
- **The template system** (`systems/template`) is a system with placeholder comments and no example code. The docs a
  system author (or an LLM writing a system) needs are generated from the SDK's sources into
  `packages/sdk/AUTHORING.md` by a script, so they change when the SDK does; the fs system offers them in parts, so
  the chat can make systems itself on any window: `fs/system-authoring` (`/new-system`) is the start item (the
  guide's intro, every part with its size, where the template is), and each section of the guide is a context item
  of its own under it (`fs/authoring-<topic>`, each naming the next; the runtime internals and core types are reference
  parts, never suggested), so a contextor picks the parts a budget allows and a model loads the rest by name. The
  script writes the list of parts beside the guide (`systems/fs/shared/authoring.gen.ts`), the one source of fs's
  declarations of them.

### QR pairing

A system started with a hub URL and no pairing tells the hub its description, instance and config type while it
waits, and prints a **QR code** of its pairing link with the code under it. Scanning opens `/pair/<pairing>` on the
hub (from the address the system used to reach it, or `HARNESS_PUBLIC_URL`), where an admin sees the system and
its key, fills in its config with the type's form, names the instance and presses **Pair**: the system is paired
and configured in one step, and the page follows it until it is connected.

### Fleets: many instances of one system

Several copies of a system can be attached at once: a fleet of fs machines is **one system `fs` with instances**
`laptop` and `desk`, so fn names, typed refs and the LLM's tool list stay the same however many machines there are.
A system that runs one copy has the single instance `main`. Keys, config, status and data are per instance; the
catalog keeps one manifest per system. Which instance runs a call is the hub's choice, never a fn argument: an
explicit `on` (offered to the LLM only when more than one instance is connected), else the instance a resource URI
belongs to (`file://laptop/…`), else the session's pinned one, the default, or the only one; otherwise the call is
refused as invalid input that names the choices.

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

- **Inputs are editors and viewers.** A system's input for one of its named types gets `readonly`: the same component
  edits a value (in `!` forms, handler prompts, config forms) and shows it (in run cards, mention cards). The hub's
  own editors and viewers cover every gin type, gin expression and gin type definition, each one component with the
  same flag.
- **Resource views.** A system's viewer for a format either replaces the hub's preview or adds a tab beside it
  (`{ component, mode: 'tab', label: 'Schema' }`).

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

### Chat modes and contextors

Two choices shape an agent's prompt, each set on the agent fn and changeable per session:

- **The chat mode** says how fns reach the model. **Tools** (strict) sends every selected fn as a native tool, as in
  build 1. **Static** sends five fixed tools whatever is loaded: `find`, `inspect`, `load`, `unload` and `run`.
  Loaded fns are shown as text cards at the end of the prompt (name and line, then the call signature, then
  instructions, examples and the types they use, as the budget allows), and the model runs any fn the session may
  use with `run(fn, args)`; the run is of that fn itself, with its policy, card and record. A fn's result can show
  the agent more fns (`ctx.expose`), at a detail. A model without native tool calls writes `<run fn="…">{…}</run>`
  blocks instead. Static is cheaper than strict tools and needs no "drop the least used tool".
- **The contextor** says what the prompt holds. **Plain** sends the conversation and the loaded context.
  **Suggest** adds suggestions (and optionally the best context's content). **Graph** starts every user message
  with a fresh prompt: the recent exchanges as the conversation, summaries of older relevant exchanges, and the
  context and fns most likely to matter, chosen by weights (similarity, words, recency, use, links) at the detail
  that fits.

**Never more than the model takes.** Every prompt, in every mode, is planned against the model's real limits: the
window the provider actually serves (for Ollama, its `num_ctx`, never the length the model was trained to), the
reply (and a reasoning model's thinking), and a safety margin. What doesn't fit is shortened or left out in a fixed
order and reported, never cut silently by the provider. The run inspector shows what the prompt held and why
("4,096 window: 1,024 reply, 246 margin, 612 fixed, 1,230 history, 640 context, 344 fns"). An admin can set a
model's limits; token estimates calibrate themselves against what the provider reports.

Static plus graph is the setup for small local models; `hub/chat_small` is the chat agent with it.

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

### Every model call is recorded

Every call to a model of any modality goes through the hub: chat, embeddings, images, transcription and speech.
Systems use the hub as their provider for all of them. Each call is a **model call** record: modality, provider,
model, what it used (tokens, texts, images, seconds), cost, queue wait, time to first byte, total time and size,
attributed to the run that made it (or to the hub's own work, like indexing). A chat call also keeps its whole
request and response. Model calls are not fns: fns are what agents choose to run.

### Model roles

Besides the model an agent uses, the hub picks a model for its own jobs: **transcribing** audio, **dictation** in
the composer (or the browser's own speech recognition), **speaking** answers, **describing** images and **reading
text** in them, and the default chat model. Each role is set in the admin's model settings (a model, optionally the
provider that serves it, a language) or by asking in chat.

### Fn metrics

Every run records how long it waited in the queue, waited for approval and ran, what it cost and used, how it ended
(done, invalid input, failed, cancelled) and how often it was retried. The hub rolls these up per fn and per day;
the admin's fn pages show them and `hub/fn_metrics` gives them to the LLM.

### Invalid input is not an error

A model's mistake in calling a fn (JSON that doesn't parse, arguments that don't fit the fn's type, input the fn's
own checks refuse) ends the run as **invalid input**: the problems go back to the model so it can try again, the
chat shows it softly as "Retried", and it doesn't count as a failure. A real failure is **failed**.

### The LLM can see and do everything

Hub fns cover everything a person can see or do in the browser: resources (list, read any form, outline, convert,
import, send to the model, rename, delete), context (read, make from a resource, remember, forget), types, runs,
model calls, fn metrics, sessions, systems and their logs, and, with approval, every admin setting. A read fn and
its web endpoint are one operation with one shape.

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

### Context as a graph

Context items link to other context, fns, types and resources with **weighted edges**. An item comes from a system
(skills, guides, `/commands`), is **memory** written by a person or an agent (`memory/…`, for a session, a person
or everyone), or is **made from a resource** (`resource/…`, one item per section, chained when long, live or a
snapshot). What an item declares becomes its edges: context it imports and fns it brings travel with it; suggested
fns, its parent, the next piece of a chain, related items and what it is about only spread weight. The hub also
finds edges in the text (mentions) and learns them from use (two things used in one turn), weaker than declared
ones and fading when unused. A person can draw edges in the context view. The graph contextor walks the edges, so
a skill's fns reach the prompt without the model asking.

### Raw content and forms

The hub keeps a resource's **raw** bytes in its content store (files under its data folder by default, or its
database) and makes **forms** from them for people and LLMs: the markdown of an html page or a document, the typed
tables of a spreadsheet, the pages of a pdf, the text of code; and, through a model, an image's description and the
text in it, an audio transcript, a thumbnail. Forms are kept by the raw content's hash, so the same bytes are
converted once wherever they are; model-made forms are made when someone needs them and cost a recorded model call.
Every form can be viewed beside the raw. Sectioning, the index and the LLM read a resource's primary form by default
(so a web page is cut by its headings, a workbook by its tables). The hub also owns resources of its own
(`hub://resources/…`): uploads, imported URLs and fn outputs.

### Viewing resources

Every common type has a viewer with a preview and a source mode where both make sense: images (zoom, pan), code
and data with real syntax highlighting, markdown with mermaid diagrams drawn, html in a sandbox, tables with sheets,
sorting and paging, pdf pages, audio and video with transcripts, JSON as a tree. The resource browser lists, shows
thumbnails, or groups resources automatically (by type, source, folder path or date) with counts, filters and bulk
actions, everything in the URL.

### The web system

A system for the web: search (Tavily) and reading a page, which imports the page as a hub resource (rendered with a
headless browser first when it is built by scripts) and gives back its markdown. It refuses private addresses
unless an admin allows them.

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

Done for build 2: **ayepi mcp** caller info, tool annotations, a router for many endpoints and bearer secrets;
**ayepi push** (VAPID web push); **aeye resources** converted versions, converters, a url loader with pluggable page
renderers, the folder resolver and sections of a converted version.

Still open:

- **ayepi core: binary frames** (MessagePack or CBOR) for the ws protocol.
- **ayepi sqlite: a `FileStore` over SQLite**, for keeping raw content in the database (the hub has its own until then).
- **ayepi mcp: server progress notifications.**
- **aeye core:** `forget` counting tool definitions; a provider hook for the served context window.

## Later

- **Database system:** query tool, saved queries, custom types, row- and field-level rules as
  expressions, mapping a hub user to a database user (required or not), and public or private types. The
  admin sets this up and can change it through fns.
- **MCP bridge system** and **Claude Code system** (described above).
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

Build 2 (designed 2026-11-07, built 2026-11-08; each item's status is in [plans/build-2-design.md](plans/build-2-design.md) §11): the template system and
generated authoring docs, model roles for transcription and dictation, chat modes and the graph contextor with
token budgets, context links, raw content and forms, the web system, resource viewers and the browser, QR pairing,
hub MCPs, system packages and the CLI, invalid input, fleets, gin editors and viewers, every model call recorded,
fn metrics, and hub fns for everything.

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
- **Owner review notes (2026-11-10, build 5)** are standing rules. The verbatim notes are in
  `docs/plans/build-5-feedback.md`.
  - **Use the libraries:**
    - Never re-implement what aeye or ayepi do. For example, the web system uses `@aeye/resources` for fetching,
      converting and links.
    - When a library can't do something, report it as a library gap and the owner decides. No workarounds.
  - **The hub stores everything shared:**
    - Fns (saved queries and forms included), types, examples, embeddings and enrichment results live in the hub.
    - Systems keep only their connection config and keys.
    - Search runs in the hub's database. No system or browser loads a whole set or does vector math in memory.
    - The hub has one fns/context search endpoint, available on the web API, the system link and as an LLM fn. It
      does text and semantic search, can order by score, filters by kind, system, instance, visibility, types and
      mode, and pages its results.
  - **Anything a contract declares can also be added at runtime:**
    - This covers fns, types, kinds, resources and roots, context, commands, components (including contributions to
      another system's registry), examples and providers.
    - The SDK and link offer one add/update/remove API for all of them.
    - The hub stores each with the system and instance that defined it, its version history and its visibility, and
      tells others live.
    - Static contract entries end in the same records.
  - **Fns:**
    - Fns carry real instructions for the model.
    - Fns can have any number of examples, in their own searchable table. A setting picks how many go into the prompt,
      and `fn_examples` pages through the rest.
    - Agent-like fns (`get_input`, `get_query`, `edit_query`) are a prompt with tools, as product's agent kind is.
  - **Fn facts:**
    - Each fn records the types it reads and writes, worked out deeply through the fns it uses.
    - It also records its mode (read, write or delete) and whether it's free.
    - Each kind estimates cost from a payload (min, typical, max), using run history when there is some.
    - Run-time stats let the chat warn about long-running fns.
  - **Chat modes:**
    - `none`, `read`, `write`, `delete` and `auto`.
    - `auto` asks a classifier model, which admin sets system-wide.
    - Approving a run runs it, with no second Run step.
  - **System builds are self-contained:** they bundle all their JS dependencies so they can be scanned as one
    artifact.
  - **Frontend logs and traffic** go to the hub as per-person resources. A new file starts on size, or after 5
    minutes of quiet.
  - **Systems use aeye with the hub as the provider:** `ctx.ai()` / `hubAi()` returns a full `@aeye/ai` instance, in or
    out of runs. It lists the hub's real models and roles with their capabilities. The hub attributes every call,
    enforces access and budgets, and records it.
  - **Context folders:** a system's `context/` folder holds markdown files, each with a YAML header (any context
    metadata) and then its content. The build checks them and fails on broken fn or context links. They are served to
    the hub keyed by a stable, readable key that people never see. Context links (loads, next choices) always load
    through `load_context`, so a small model can walk a large choose-your-own-adventure graph. The API is organised the
    same way: grouped, indexed and searchable, never one huge flat list.
  - **A system page shows everything the system contributed** (fns, context, types, kinds, resources, commands,
    components, examples, providers) with origin, version and visibility. It has a switch per item and a switch for all
    of the system's context, like the one for its fns.
  - **Authoring fns, as in product:** the chat model hands a full description to one authoring fn (query, input,
    and later API and code). Inside it, a sub-agent on `ctx.ai()` follows a forced tool workflow with progressive
    disclosure of types, schemas and examples, so the huge context stays inside the fn. It ports product's tested
    logic and runs on one reusable SDK authoring-agent helper.
  - **Fns declare their effects:** what they create, update or remove in the hub (fns of a given kind, types, context,
    resources, components, examples, pending runs, secrets). Effects are worked out deeply, like the other fn facts. The
    chat model sees them in one line of the fn's description, search can filter on them, and the hub refuses changes a
    fn didn't declare.
  - **Generated table fns:** for any table type, one fn lists every fn that could be generated (CRUD: create,
    update, updateWhere, remove, removeWhere, selectOne, selectPage; and helpers from its columns and foreign keys:
    aggregates, group-bys, date buckets, lookups, parent/child, and relation-derived fields with normalized ranks and
    shares, as in `docs/plans/database-graph.md`). Another creates or updates them by name.
    Generation is deterministic, comes from `@aeye/query`, and keeps version history.
  - **Testing is native to a system:** one SDK test kit covers a fake hub and ctx, typed fn calls, mocked and replayed
    LLM replies plus a few real ones, component previews in named states with screenshots for review, and kind and
    context-folder checks. `harness test` runs it, and `install_system` runs it before approval.
  - **A context brings the fns its work needs:** the hub adds them to the turn, and the context's text names them and
    says how to use them. For example, fs authoring brings bash, read, write and edit.
  - **A system the chat writes is installed from the chat, not the console.** The plan is in
    `docs/plans/system-install-flow.md`.
  - **Chat shows:**
    - reasoning, fn calls and content in the exact order the model produced them
    - consecutive fn calls collapsed into one section, newest first
    - any fn opened as a modal without leaving the chat, using the same component as the fn page
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
- **Context is a graph** (build 2): items link to context, fns, types and resources with weighted edges; sources are
  skills, memory, resource-derived context, items injected into an agent by name, `/commands`; an item can bring
  fns. The graph contextor walks the edges.
- **Chat modes and contextors** (build 2): `tools` and `static` modes, `plain`, `suggest` and `graph`
  contextors, chosen per agent fn and per session; every prompt is planned against the model's real limits and never
  sent larger.
- **System packages** (build 2): a folder with `system.json`, `server/`, `client/`; the hub gives each installed
  instance data, state and cache folders outside the package; config in the hub database; `harness system
  new|build|pack|install|export-data`; the hub installs zips.
- **Invalid input vs error** (build 2): `invalid-input` is its own run status, retryable, fed back to the LLM and
  shown softly as "Retried"; `failed` is a real failure.
- **Model calls** (build 2): every model call of every modality is a `ModelCall` record attributed to its run; not a
  fn kind; nothing bypasses the hub.
- **Systems add resource views, type inputs (editors that are also viewers) and value renderers** through `client()`.
- **Fn metrics** (build 2): queue and approval wait, run time, cost, tokens, outcome, retries per run, rolled up per
  fn and day, shown in admin and given to the LLM.
- **Hub MCPs** (build 2, the owner's "fn sets"): admin-made MCP endpoints with their own route, secret and
  include/exclude rules; every call is a run.
- **Forms** (build 2): raw content in the hub's files or database; converted and model-made forms kept by content
  hash; sectioning reads the primary form.
- **Fleets** (build 2): one system, many instances; the instance is a hub-owned run option.
- **Web pages are hub resources** (build 2): the web system fetches and renders, the hub imports and converts.
- **Model roles** (build 2): transcription, dictation, speech, image description and text-in-image models are set in
  the admin's model settings.
- **Hub fns call what the hub's code calls** (build 2 integration): the deps rule (a fn may call only the deps it
  declares) keeps systems honest; the hub's own fns are the hub's code, so `hub/resource_import` may fetch a URL
  through `web/fetch_raw` without a declaration no system could name. Agents still call only their tools.
- **Models named on their provider** (build 2 integration): `provider/id` (`ollama/deepseek-r1:7b`) and the bare id
  name the same model everywhere a model is looked up (limits and probes, the planner's tool check, roles), through
  core's `namesModel`.
- **Providers list their models live** (build 2 integration): whenever the stored providers change, the hub asks
  each for the models it serves (aeye's registry refresh), so a local Ollama's models are offered at once, with the
  window Ollama serves them with.
- **Tool args reach the hub's own check** (build 2 integration): agent tools accept any JSON object and the hub checks
  the args against the fn's type, so args that don't fit become an `invalid-input` run the chat shows as "Retried"
  and the fn's metrics count. Args that aren't JSON at all are retried inside aeye, before any run exists.
- **Fleets in the chat** (build 2 integration): in tools mode a fn whose system has several connected instances gets
  an optional `on` choice in its tool schema; the static toolset's `run` takes `on`. Both are taken out of the args and
  given to the run as its instance; a call that names none and has no other pick is refused as invalid input naming
  the machines.
- **Every embedding is a model call** (build 2 integration): the index's calls to an embedder system are `ModelCall`
  records (provider the system, model the embedder, purpose `index` or `search`), like calls through a provider.
- **Common formats out of the box** (build 2 integration): the hub and fs install `@aeye/resources`' optional parsers
  (`xlsx`, `pdf-parse`, `mammoth`, `jszip`, `js-yaml`), so workbooks become tables, pdfs pages and docx markdown.
- **Reading a web page asks first** (build 2 integration): `web/read` imports through `hub/resource_import`, which is
  a write, so a person approves it unless a policy allows it.
- **Dynamic context is written when it is used** (build 2 review): an item declared without `content` (`fs/tree`,
  `/new-system`) gets its text from its system's `context` endpoint, as the person and with the `/command`'s args,
  whenever a prompt shows it whole (commanded, loaded, always, or a graph pick of those), `hub/inspect` shows it or
  `hub/context_get` reads it. The hub keeps each text a while (`HARNESS_DYNAMIC_CONTEXT_TTL`) per session and person,
  so a later load reuses the command's args.
- **The model runs only fns meant for it** (build 2 review): static `run`, `load` and `inspect` refuse, as invalid
  input, a fn that is switched off, unavailable, outside the session's systems, or of visibility `none` or `user`
  (`web/fetch_raw` is for the hub alone). A bad name given to `hub/inspect` is invalid input too, never a failure.
- **A hub MCP's static toolset is the chat's** (build 2 review): its `find` and `inspect` are runs of the hub fns of
  those names, kept inside the MCP's scope; its `run` takes the chat's `run` args, a fleet's `on` included.
- **Prompts leave out, never refuse, what the session loaded** (build 2 review): the plain and suggest contextors keep
  what the message asks for first, then the agent's, then the session's loaded context and fns, each whole or left out
  (and reported); static mode never shows build 1's search and load fns, whose jobs its own tools do.
- **Thinking is never the answer** (build 2 review): a `<think>…</think>` a model writes into its answer streams and is
  kept as the message's reasoning, and the run's result is the answer without it.
- **A role's provider answers its calls** (build 2 review): a model role resolves to a model and a provider, and the
  call carries the provider as a real field (`HubCallMetadata.provider`, enforced in aeye's `onModelSelected`), so a
  model name two providers serve answers from the one the settings page shows.
