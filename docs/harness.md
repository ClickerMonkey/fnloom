# Harness

A web-based agent harness. One server, the **hub**, owns every LLM call, every user, every permission
and the record of everything that happened. Separate processes, **stations**, connect to the hub over a
WebSocket and add things to it: fns (tools), fn kinds, types, resources, context, chat inputs and UI
renderers. A station can run anywhere, can be written by Claude Code or by the harness itself, and is
picked up again on reconnect.

This document is the plain-language picture. The same picture as TypeScript is in `types/`:

- **`sdk.ts`**: everything a station author touches. This is the part to review most closely.
- **`fs.ts`**: the first station's contract, written with the SDK exactly as it will ship.
- **`hub.ts`**: the hub's side: the wire format, records, permissions, queues, chat and storage.
- **`examples.ts`**: the fs station's server written against the SDK, plus every mistake the types must
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
  stations that talk over one small protocol. Fn kinds live in stations, not in the hub. The hub ships
  only two kinds (`system` and `llm`).
- **Dropped for now:** apps, components, plans, widgets, dashboards, fn authoring agents, the graph
  contextor, the database-first design. A database station comes later.

## Words

| Word | Meaning |
|---|---|
| **Hub** | The main server. Queues, LLM calls, users, permissions, storage, indexing, the web chat. |
| **Station** | A process connected to the hub that contributes fns, kinds, types, resources, context, inputs and renderers. Placeholder name for what your notes called a plugin (alternatives: Rig, Dock, Module, Satellite, Outpost). The hub is itself a station named `hub`. |
| **Fn** | A typed function: gin args in, gin result out. "Tool" is what the LLM calls it. Every fn belongs to one station and its name is `station/name`. |
| **Fn kind** | Decides what a fn's definition (its *payload*) looks like and how it runs. Kinds are provided by stations. |
| **Run** | One call of a fn. Runs form a tree: a run's children are the fns it called. |
| **Turn** | One user message and everything it caused. Every run, LLM call and change traces back to a turn. |
| **Session** | A chat. People and agents talk in it; it has enabled stations, a budget and a priority. |
| **Actor** | Anything that can act or be granted something: a user, a group, an agent, a station, the system. Core table. |
| **Resource** | Content that lives somewhere: a folder, a file, a web page, a database row. Served by a station at an absolute URI. |
| **Section** | A stable, addressable piece of a resource (a heading, a function, a page). |
| **Context** | Content made available to the LLM. It can mention and import other context and fns. |

## Architecture

```
            browser (chat UI + station renderers)
                       │  HTTPS + one WebSocket
┌──────────────────────┴──────────────────────────────────────┐
│ HUB                                                          │
│  web api ── sessions ── turns ── LLM queue ──► aeye AI ──► providers
│                │                    │ tool calls               │
│                │                    ▼                          │
│                │              tool queue ──► hub fns (system, llm)
│                │                    │                          │
│  actors · policies · spend limits · store (sqlite) · index     │
└──────────────────────┬──────────────────────────────────────┘
                       │  one WebSocket per station (small binary frames)
        ┌──────────────┼──────────────┬───────────────┐
     fs station   claude-code     mcp bridge      db station …
     (first)      station         station         (later)
```

- The hub pops LLM requests off a queue, calls the model, saves the interaction, turns each tool call
  into a run and pushes it onto the tool queue.
- The tool queue runs a fn in the hub (kinds `system` and `llm`) or sends it to the station that owns
  the fn's kind. The station runs it and sends back a small outcome.
- When the last run of an LLM iteration settles (or goes to the background), the hub queues the next
  LLM request for that session.
- Stations never call an LLM provider. They use an aeye `AI` whose provider forwards to the hub, so the
  hub enforces budgets and records every interaction. **The hub is an aeye provider.**
- The hub stores everything in one generic database. SQLite is the default.

## Stations

A station is a process with a unique **name**. The name namespaces everything it contributes:
`fs/read_file`, `fs/FileInfo`, `fs/guide`. Resources keep their own absolute URIs (`file:///…`) and belong to the station whose root contains them.

### What a station provides

- **Fn kinds** and the handler that runs them.
- **Fns**, declared at boot and added or removed at runtime.
- **Types** (gin type definitions) other stations and the hub can use.
- **Resource roots** (initially folders) and a resource service: list, stat, read, links, sections, watch.
- **Section rules**: how its formats are cut into stable sections.
- **Context**, including `/name` commands.
- **Mention providers** for `@` search in the chat.
- **Hooks** that add information to a user message before the LLM sees it.
- **Embedders**: an embed function the hub can use for indexing.
- **Actor settings**: typed per-actor controls an admin (or a fn) can set, such as a database station's
  row and field rules for a group.
- **Event subscriptions**: hub events it wants to hear.
- **Client assets**: browser code that registers renderers for its fns, resource formats, attachments
  and input types.

All of this is described in one **manifest** the station sends on connect, plus small patches after.

### Connecting and pairing

1. The station opens a WebSocket to the hub and says hello: name, version, public key, manifest hash.
2. **A name the hub has never seen** starts pairing. Two ways:
   - **Code:** the station prints a short code and a link. An admin opens the link (or answers a chat
     prompt / push notification) and confirms the code matches.
   - **Token:** an admin creates a one-time pairing token (in the UI or by asking in chat) and starts the
     station with it.
3. **A known name** must prove it holds the paired key (signed challenge). A different key under a known
   name is refused until an admin re-pairs or replaces it.
4. After the hub welcomes it, the station sends its manifest (or nothing, if the hash matches). The hub
   imports and indexes what changed.
5. On disconnect the station's fns become **unavailable**, not deleted. On reconnect they come back,
   possibly changed. An admin can **remove** a station; its fns stop being callable until it is paired
   again.

A fn is available only if its own station and its kind's station are connected, its kind still exists,
and every fn it depends on is available.

### Talking to the hub

One WebSocket per station carries everything in both directions. ayepi's WebSocket protocol is one-way:
the client calls and the server answers and pushes events. So each side runs both halves:

- The station is an ayepi **client** of the hub's link spec (`HubLink`): manifest, calls to other fns,
  progress, LLM requests, logs.
- The station is also an ayepi **server** of its own link spec (`StationLink`), with no HTTP listener:
  the hub calls it to run fns, control runs, read resources, embed, run hooks and deliver events.
- Every frame is wrapped with its direction (`LinkFrame`) and handed to the local ayepi server or
  client. ayepi already does ids, replies, typed errors, item streams, cancellation and reconnect, so
  the harness adds only that thin envelope.

Messages stay small: ids, typed args and results, progress. Large content never rides inside a message.
It moves as a **content ref** (`ContentRef`: hash + size) that the other side fetches in chunks when it
needs it, over the link or by presigned URL from the hub's file store (ayepi files).

**Your question, should we use HTTP?** Not for station traffic. HTTP adds headers and a connection setup
to every small call and can't push to the station. One long-lived WebSocket is the efficient choice:
multiplexed calls, cancellation, server push and backpressure. HTTP stays for the browser API, large
downloads and an optional MCP face. On the wire, ayepi frames are JSON text today. That is already compact
for small packets (`{"id":"c3","type":"run","data":{…}}`). Binary frames (MessagePack or CBOR) would be
smaller and faster still, but they need ayepi support: see [Library asks](#g/library-asks).

### MCP for free

The station surface is deliberately a superset of MCP: fns ↔ MCP tools, resources ↔ MCP resources,
commands ↔ MCP prompts. So:

- **Every station can also serve MCP** (stdio or HTTP) with no extra code. Claude Code or any MCP client
  can use a station directly.
- **An MCP bridge station** connects any MCP server to the hub and presents it as a station.
- The **Claude Code station** is a wrapper: it runs Claude Code sessions and exposes them (list, read,
  send, interrupt) and imports Claude's agents, skills and MCP servers as context and fns.

### Building a station

A station package has three folders. The [station SDK](#g/the-station-sdk) section shows each one.

- `shared/`: its **contract**: name, types, fns, kinds, context and the rest, with no implementation.
  Other stations import it to call its fns with typed refs.
- `server/`: the process. It implements the contract and connects to the hub.
- `client/`: browser renderers, typed by the contract. The hub serves them to the chat UI.

`harness-station build` builds the server and client; `harness-station dev` runs it with reload. On
connect the hub reads everything from the contract, so nothing is registered by hand.

### Changing itself

Harness must be able to modify itself, or let Claude Code do it. The **fs station** (the first one
built) gives an agent read, write, edit, search and bash over folders, exposes those folders as
resources, and can **restart itself**. A restarted station reconnects, and the hub imports whatever is
new. An agent can add fns, kinds, context and renderers to a station's source and see them live after a
restart.

## Fns

A fn has a name, a description, a kind, a **payload** (the kind's definition data), and a **signature**
(gin args → gin result) that the kind derives from the payload. Signatures travel as gin JSON. The hub
stores them and rebuilds real gin types, zod schemas and LLM tool schemas from them when needed.

A fn also declares:

- **Deps:** the fns its implementation may call. Calls to anything else are refused. For a system fn
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
- **Limits:** timeout, retries, and an estimated cost.

### Running a fn

Every run gets a **budget** (money and time), carved out of its parent's. The implementation receives
typed args and a context:

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

- **`system`:** a fn its station implements in code. Every station has it, the hub included (the hub's
  own fns, like search and configuration, are system fns of the station `hub`). Fully type-checked.
- **`hub/llm`:** an agent: instructions, model, tools, context and an output type. The chat agent is
  one. Any station can declare agents with `agent()`.
- **Station kinds:** a station can add a kind with its own payload type and run every fn of that kind.
  Later: `api` (a gin program that builds an HTTP request, as designed in product), `query` (the
  database station), and the rest of product's kinds.

A system fn is typed end to end. A fn of another kind is typed as far as its payload and the args and
result its author expects. What the payload really produces is only known at runtime, so the hub checks it
against those expectations when the fn is declared.

## The station SDK

This is the surface other people build on, so it must read well and refuse mistakes. Three rules:

1. **One source of types.** Every shape is written once as a gin type with `g`. Args, results, handler
   shapes, payloads, settings, attachments and renderer props are all inferred from it.
2. **Refs, not strings.** Everything a contract declares gets a typed ref (`fs.fns.read`,
   `fs.context.guide`, `fs.settings.shell`). References between things are refs, so a reference to
   something that doesn't exist doesn't compile, and a call through a ref has typed args and result.
3. **The contract declares, the server implements.** Everything declared must be implemented, and
   nothing can be implemented that wasn't declared.

### The contract (`shared/`)

`station(name)` starts a contract and `.with(...)` adds to it: types, settings, attachments, kinds, fns,
context, hooks, mentions, embedders and sectioners. `.with` can be called again with a function that
receives the refs declared so far, so later declarations can use earlier ones. From `types/fs.ts`:

```ts
export const fs = station('fs', { description: 'Files and a shell over chosen folders.' })
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
}, { hub: 'ws://hub:4100', state: '.station' });
```

A run's `ctx` holds:

- `ctx.fns`, `ctx.handlers` and `ctx.progress`, typed by the fn.
- `ctx.done`, `ctx.fail`, `ctx.pause` and `ctx.cancelled`, which build the outcome object with the
  fn's result, undo and resume types.
- `ctx.budget` and `ctx.signal`.
- `ctx.onPause`, `ctx.allow` (narrow what can be done right now) and `ctx.undoWith`.
- The services: `ctx.llm`, `ctx.files`, `ctx.fetch`, `ctx.resources`, `ctx.attach`, `ctx.link`,
  `ctx.setting` and `ctx.log`.

Calling another station's fn: declare it as a dep with its ref, then `await ctx.fns.copy(args, options)`.
The call is awaitable for its typed result, and it is also a handle with `run`, `settled`, `cancel`,
`pause` and `watch`. If the dep has a required handler, the options with that handler are required.

### Renderers (`client/`)

`client(contract, renderers)` registers browser renderers, typed by the contract. A fn renderer gets that
fn's typed args, result and progress; an attachment renderer gets its typed data; an input renderer for a
named type gets typed values. Renderers mount into a DOM element, so any UI library works.

```ts
export default client(fs, {
  fns: { bash: (el, view) => { el.textContent = view.args.command; return view.subscribe(v => …v.result?.stdout…); } },
  attachments: { diff: (el, view) => drawDiff(el, view.data.before, view.data.after) },
  inputs: { Entry: (el, view) => … },
});
```

### Mistakes that don't compile

`types/examples.ts` checks each of these, and that each fails for the stated reason:

- calling a fn that isn't a dep, or with wrong args
- calling a fn with a required handler without passing it
- calling an optional handler without checking it exists
- reporting a progress step that wasn't declared, or step progress on a linear fn
- returning a wrong result, or pausing a fn with no resume type
- leaving out `undo` on a fn that declares an undo type
- leaving out any declared fn, kind, dynamic context, hook or mention provider
- implementing anything the contract doesn't declare
- attaching data of the wrong shape
- a renderer for something the contract doesn't have

## Sessions and the chat

- **A session** has participants (users and agents), an agent fn that answers, **enabled stations**
  (only their fns, context and inputs apply), a priority and a budget.
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

### Hooks

Before the LLM sees a user message, hooks may add to it:

- the user's local time and time zone
- suggested context and suggested fns (from the index)
- anything a station adds

Each contribution is a small tagged block in the message, so the model can tell it apart from what the
user typed.

### Chat inputs

- **`@`** searches mention providers (any station can provide one) and links what you pick.
- **`/name args`** pulls in context with that command.
- **`!fn`** opens an input form for the fn's args. The chat has an input for **every gin type**, and
  stations can register custom inputs for their own types.
- **Attachments:** fns can attach things to the assistant message, such as links to resources, files or
  runs, which render as clickable cards.
- **Renderers:** stations supply renderers for their fns' calls, for resource formats and for
  attachments.

### What the UI offers

The chat UI is fully driven by the hub. The hub tells the UI which features exist right now: voice only
if a transcription service is configured, `@` only if a mention provider is connected, and so on.

### Configuring by asking

Everything an admin configures can also be done by asking in chat, through the hub's system fns: providers,
model categories, transcription, web search, stations, pairing, spend limits, policies, actor settings.
These always need approval.

### Push notifications

The hub sends web push notifications: approval or input needed, a mention, a turn finished while you
were away, a station waiting for pairing, a spend limit reached.

## LLM calls and budgets

- **One place for LLM calls.** The hub's LLM queue is the only caller of real providers. Stations and
  `llm` fns go through it.
- **Priority:** every LLM request has one. Interactive chat comes before background work.
- **Spend limits:** money (and optionally calls or tokens) per time window, scoped to everything, an
  actor, a group, a station, a session, a fn or a model. When a limit is hit, a request waits for the
  window, is refused, or asks someone.
- **Run budgets:** money and time per run, carved from the parent's.
- **Everything is saved:** every LLM interaction (request, response, usage, cost, timing) and every run
  (args, outcome, progress, timing, cost, errors). The **fn tree** of a turn is a query away.
- **Providers and models** are configured on the hub (or by asking in chat) and come from aeye.

## Actors and permissions

- **Actors** are a core table: users, groups, agents, stations and the system. A user is in zero or more
  groups.
- **Policies** decide whether an actor may run a fn: allow, deny or ask. "Ask" names who decides: the
  user who started the turn, a specific actor, a group, an LLM judge (an `llm` fn), or the system.
  Policies match fns by name, station, kind or tag.
- **Approvals** are records. "Always" turns into a policy.
- **Actor settings** are typed values stations declare and attach to actors, set by an admin or by a fn.
  For example, the database station declares row and field access rules; an admin sets them per group.

## Content: resources, sections and context

- **Resources are content.** Stations serve them at absolute URIs. Folders, files, pages and code are all
  treated the same: a resource may have **contents** and **links** to other resources (a folder links to
  its children, code links to what it imports). The hub can ask for links alone; a station may include
  contents for free.
- **Sections** cut a resource into stable pieces. A user picks a sectioning rule per format (headings,
  code symbols, pages, paragraphs, or a station's own). A section's key comes from structure (the
  heading path, the symbol name), not position, so it stays the same when content moves. A new version is
  compared by key: sections are added, changed or removed, and anything derived from a changed section is
  marked stale.
- **Context is content available to the LLM.** It is authored or taken from sections. Context can
  **mention or import** other context and fns, so loading it brings those along (a "skill").
- **Indexing:** the hub embeds fns, context and sections with an embedder (from a provider or a station)
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
| Hub API, browser API, station link specs | `@ayepi/core` | `spec` / `endpoint` / `events`; zod schemas first, types derived. The browser uses the zod-free client with `wsTransport`. |
| Station link both ways on one socket | `@ayepi/core` | The station runs `server(stationLinkSpec)` fed through `app.ws.open/message` with no listener, and `client({ ws })` with a custom `ClientWs`. A small envelope routes frames. |
| Hub modules (auth, sessions, queues, stations, budgets) | `@ayepi/plugin` | One plugin per module, installed in dependency order; `provide` for services. |
| LLM queue and run queue | `@ayepi/work` | Priority via `priorityDoer`; tool calls fan out and `.next(…, 'all-done')` queues the next iteration; `WorkDelayError` for limits and 429s; deadlines; DLQ. Cancel is the hub's own registry (work has none). |
| Rate of calls | `@ayepi/rate` | `rateLimitedDoer` caps call starts per model and provider. Dollar limits are a hub ledger (rate counts calls only). |
| Users and stations | `@ayepi/auth` | Bearer JWTs for the browser (HTTP and ws) and short station tokens. Passwords, refresh, revocation and pairing are the hub's. |
| Uploads, attachments, content refs | `@ayepi/files` | `fsFiles` + `mountFiles` presigned routes. |
| Config | `@ayepi/env` | `HubConfig` and every tunable, defaults in the schema. |
| Logs, traces | `@ayepi/log`, `@ayepi/otel` | `console.*` interception with trace context; redaction of secrets. |
| Startup and shutdown | `@ayepi/updown` | Store, work, server and station links in dependency order. |
| A station as an MCP server | `@ayepi/mcp` | `mcpServer` + `serveStdio` over the station's own spec (tools only today). |
| UI work before stations exist | `@ayepi/mock` | Fake data from the spec. |
| LLM loop | `@aeye/core` | Each `hub/llm` run is an aeye `Prompt`. Its tools are built from fn signatures; `onToolIntercept` turns each call into a queued run and throws `PromptSuspend`; when the runs settle, the next LLM job re-runs the prompt with the tool results appended. aeye keeps doing argument repair, retries, schema fallbacks and context trimming. |
| Providers, selection, cost | `@aeye/ai` + providers + `@aeye/models` | One `AI` on the hub. `beforeRequest` reserves budget; `afterRequest` settles it and saves the `LlmInteraction`. |
| The hub as a provider | `@aeye/ai` `Provider` | `HarnessProvider` on stations forwards over the link: tool and output schemas go as JSON schema, and the hub returns chunks, the schema descriptors it used and the real cost. |
| Types and signatures | `@aeye/gin` | Wire `TypeDef`s stored by the hub; `registry.parse` in a per-station scope; `toValueSchema` → zod → aeye `toJSONSchema` for tool schemas; `compatible` checks re-declared fns and types. |
| Typed authoring | harness SDK over gin | gin has no static inference, so the SDK's `g` builder keeps the TS type (`GinType<T>`). |
| Reading and cutting resources | `@aeye/resources` | Parsers (pdf, docx, html, code…), link extraction and the graph builder. Sections are keyed by structure in the harness, because aeye's slice ids are ordinals. |
| Database station (later) | `@aeye/query` | Query tool, RLS and field access through its backing hooks. |

### How a turn runs

1. The browser sends a message. The hub creates a turn, runs the hooks and queues an LLM job at the
   session's priority.
2. The LLM worker reserves budget, runs one iteration of the agent's aeye prompt and saves the
   interaction. Each tool call becomes a run. The run is checked against policies (and may wait for
   approval), then queued.
3. The run worker sends each run to its kind's station, or runs it in the hub. Child calls come back
   through the hub and are queued the same way.
4. When every run of the iteration has settled or gone to the background, the next LLM job is queued
   with the results. A new user message, or the global tool timeout while a user is present, moves the
   rest to the background early.
5. The turn ends when the agent answers without tool calls.

## Library asks

What @aeye and @ayepi don't do yet that harness needs. Each can be built in harness first and moved into
the library later. Which way to go is your call.

- **ayepi core: two-way calls on one socket.** A supported "peer" mode instead of the harness envelope.
- **ayepi core: binary frames** (MessagePack or CBOR) for the ws protocol.
- **ayepi rate: weighted hits**, so a limit can count dollars or tokens, not just calls.
- **ayepi work: cancel** for queued and running work, and **sqlite ports** (`Queue`, `Store`, `PubSub`).
- **ayepi mcp: resources, prompts, Streamable HTTP**, a tool list that follows hot installs, and an **MCP
  client** (for the bridge station).
- **ayepi: web push** (VAPID).
- **aeye core: JSON schema → zod**, so forwarded tool schemas can be rebuilt on the hub.
- **aeye resources: stable section ids**, a folder resolver, and TS import resolution (extensions and
  index files).
- **aeye gin: static inference** (`Infer<>` from builders), so the harness `g` wrapper isn't needed.

## Later

- **Database station:** query tool, saved queries, custom types, row- and field-level rules as
  expressions, mapping a hub user to a database user (required or not), and public or private types. The
  admin sets this up and can change it through fns.
- **MCP bridge station** and **Claude Code station** (described above).
- **Web station:** fetch and web search.
- **Scheduled fns and trigger fns.**
- Product's other kinds (`api`, `query`, `code`, `input`, …).

## Build order

1. Types (this review) → zod schemas → code.
2. Hub core: store, actors, sessions, turns, LLM queue, tool queue, the `system` and `llm` kinds,
   the station protocol, pairing, the chat UI.
3. Station SDK: contracts, refs, `serve`, `client`, the build, and MCP serving.
4. The fs station, including self-restart.
5. Tests throughout: unit tests with injected seams, no live network.

## Open questions

1. **The word for stations.** "Station" (with "hub") is a placeholder. Alternatives: rig, dock, module,
   satellite, outpost.
2. **Library gaps** (see Library asks): build them in harness first, or in aeye/ayepi first?
3. **Library versions.** npm has @aeye/core 0.6.0, ai 0.4.0, gin 0.4.5 and @ayepi 0.4.1, which match
   the sources. Build against the npm releases (current setup), or link the local repos?
4. **Where a runtime fn lives.** A fn declared at runtime belongs to the station that declared it but runs
   on the station that owns its kind, so both must be connected. Right, or should it belong to its kind's
   station?
5. **Default permission.** With no matching policy, the default is to ask the turn's user. Should fns
   tagged `read` be allowed by default?
6. **Agents in multi-person chats.** Product made agents reply only through a `respond` tool. Here the
   session's agent answers normally and other agents answer only when tagged. Keep that?
7. **The chat UI library.** React + Tailwind (as in product)? Station renderers use a framework-free
   `mount(el, props)` either way.
8. **Database.** SQLite through which driver (better-sqlite3 or node:sqlite), and a query builder (Kysely)
   or hand-written SQL behind the `HubStore` port?
9. **Pairing.** Is code-or-token enough, or should the hub also start some stations itself (for example
   spawn the fs station already paired)?
