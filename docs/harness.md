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
  design. A database system comes later. (The graph contextor came back in build 2; widgets came back in build 8 as the bundled `widgets` system, drawn with ECharts; dashboards are still later.)

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
- **Providers**: an aeye provider whose models the hub can use like any configured provider's: chat, embeddings
  (the index's embedders are a system's embedding models) and decisions. See **Providers from systems**.
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
and every fn it depends on is available. A fn whose system has changes waiting for an admin's review is
**held** until the review is approved. That is its own reason (`held`), apart from a fn an admin switched off
(`disabled`).

**The model always gets the reason.** Whenever the hub won't let the model use a fn (`hub/fns_load`, `hub/load`,
`hub/ctx_load`, `hub/inspect`, static `run`, or a native tool call in tools mode), it answers with the hub's own
words, for example "database/create_table changed and waits for an admin to approve it", and tells the model not to
call it again but to tell the person what blocks it. Refusals are structured (a code, the reason, and the fn's
system), so the web can act on them. For the model, `hub/fns_search` returns fns it can't use now marked with what
blocks them instead of leaving them out; only fns an admin switched off stay out.

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
  can use a system directly. Its tools are named by their fns' model names (`fs__read`), the names a chat model sees
  (see [One name for the model](#g/one-name-for-the-model)); a hub MCP's are the same.
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

A system says in `system.json` whether it runs one copy or many (`"instances": "one"` or `"many"`, written by
`harness system new --instances`), and a paired system sends the same in its hello, which the hub keeps on the
system's record (a later hello that says nothing keeps it). A `one` system's page has no Instances tab and no
"Install another": its instance's facts are on the overview and its data and export are on a Data tab, and old
instance links go to the same tab on the system page. A `many` system keeps the fleet pages even with one
instance. claude, database, fs, mcp and ollama are `many`; api is `one`. Like code, the api system authors fns: an api fn is
code that calls an external service. Its services are records of the one instance (`api/Service`: the base URL, how
it signs in, the OpenAPI document), which the authoring agent picks or adds and admins edit under Admin → API services;
a record never holds a secret. Connections are keyed per service (`ConnectDecl.scope: 'key'`): each person connects
their own token, or an admin sets a shared one for everyone, and a token signs only while the service keeps the base
URL it was given for. A call to a service that signs in, by someone with no connection to it, is refused when the run
starts, before anyone is asked to approve it, with the connect page's link. An older hub's per-service instances become records of the one instance when it starts
(`link/migrate-api.ts`).

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

### One name for the model

A fn has one name the model sees, everywhere it meets one (its tool list, static mode's `run`, cards, search hits,
results, refusals and errors, and an MCP client's tool list): its **model name**, the qualified name with every `/` and
`.` written `__` (`database/main.tasks_create` → `database__main__tasks_create`, `fs/Entry.reveal` →
`fs__Entry__reveal`). It is a valid tool name for every provider (letters, digits, `_` and `-`, at most 64, starting
with its system's first letter). Past 64 characters it is cut to 54 (no trailing `_`) and ended with `_x` and 8 hex of
the qualified name's sha-256. People see the friendly label; admins see the qualified name on hover. Only fns have
model names: context keys (`fs/guide`), types (`fs/Entry`) and hook tags (`<fs_git>`) keep their forms.

- **Encode by rule** (Phil, 2026-11-22). The format is computable from the name, so text spells every name shaped like
  a fn's by it, even one no fn holds: an example in a description (`database/main.overdue_invoices`,
  `input/project_details`, `code/price_with_tax`, `api/github.open_issues`) reads `database__main__overdue_invoices`, so the
  model never meets the `/` form of a fn name. Fn-shaped (core `isFnShaped`): its system is installed (the `systems`
  table, the hub always), its local name is a `FnLocalName` and not a type's (one capitalised part), and neither it nor
  a name it ends in at a `.` is a context key, kind or type (`database/guide`, `database/query`, `input/form`,
  `hub/llm`, `database/guide.md`). A family (`input/ask_`) and an attribute's value that is no fn (a mention's
  `provider="fs/files"`) keep their `/`. Only reading a cut name back needs the registry.

- **The rule a fn's name keeps** (core `FnLocalName`): dot-separated parts, none holding `__` or starting or ending
  with `_`, so `__` always separates parts. The SDK's build refuses a contract with one that breaks it, and the hub
  refuses such a fn (declared or saved) with the reason. Context keys and types keep `LocalName`.
- **The registry, in the store.** The hub never reads a model name back by rule, and never holds every name in
  memory. Each fn's model name is a row of the `modelFnNames` table (`{ model, fn, system }`, keyed by `model`, indexed
  by `fn` and `system`), written and removed by the catalog in the same transaction as the fn itself (`catalog/fn-names.ts`;
  a hub whose fns predate the table fills it once at start, page by page). A fn whose model name another fn holds (only
  possible through a cut name's hash) is refused when it is declared or saved: one lookup by key. A fn that goes moves
  its name to the `modelFnNameHistory` table, so an old call still reads back for people. Core's
  `ModelFnNameRegistry` is the batched interface (`fnsAmong`: which of these qualified names are fns; `fnsOf`: which
  fn each of these model names was given out for; `shapesAmong`: which of their systems are installed and which are
  context keys, kinds or types, for the rule), answered with indexed `in` queries 500 names at a time.
- **One module, three boundaries.** Core's `model-names.ts` owns the encoder, the rule and `modelFnNames`, the names
  for one prompt; nothing else spells a model name. A prompt's names object first `learn`s everything it will spell
  or read: it pulls the candidate `system/name` tokens and the cut-shaped model names out of the texts and values, asks
  the registry about the new ones in one batch (one query of each table), and keeps the answers for that prompt (or
  that batch of replies) only. Then `text`, `value`, `fn` and `read` run synchronously; a bare name it never learned is
  left as written. In static mode the hub fns the static tools do the jobs of read as the tools (`hub/fns_search` is
  `find`, `hub/ctx_search` `find_ctx`, `hub/inspect` `inspect`, `hub/fns_load`, `hub/ctx_load` and `hub/load` `load`,
  `hub/fns_drop`, `hub/ctx_drop` and `hub/unload` `unload`); every other fn reads as its model name. **Out, prompt
  text:** the planner spells every authored string the model reads (`text`: `fn:` refs, and each known fn's qualified
  name standing alone, not after `/`, `:`, `.` or a letter, so paths are left alone; a `context:` ref is written as its
  key; a bare name that is both a fn and a context key reads as the fn): the agent's instructions (`CHAT_BASE`, any
  `agent()`'s, a chat's own), the injected section, the systems list, the mode's guide, context blocks and cards, the
  tools' descriptions and their schemas' field descriptions, the trailing card message, and every person's, tool and
  system message of the history, so the hub's blocks on a message (`<loaded_for_you>`, `<file read="…">`, suggestion
  cards, `<systems_changed>`, `<invocation>`, a hook's `Loaded:` line), `<background-result>`s and refusals all read
  the one name. The model's own messages are left as it wrote them. **Out, results:** each tool reply goes through
  `text`, and a result read as JSON has its fn-name fields written as model names (`value`); an MCP client's tool
  descriptions and results the same. **In, calls:** a tool name, `run`'s `fn` and every fn-name field of the args are
  read back (a cut name through the registry); a qualified name the model writes anyway is accepted.
- **Refs in authored text.** In TypeScript a fn ref interpolates as `fn:<its name>` and a context ref as
  `context:<its key>` (`` `Read it first with ${fns.read}.` ``), so a rename is a compile error, not a stale sentence; a
  bare qualified name works too, found automatically. The SDK's build (`authoredNameWarnings`, printed by `harness
  system build`) warns on a `fn:` or `context:` ref that names nothing, and on a bare name of the system's own or the
  hub's that is near a name it knows but names nothing (a misspelling), in descriptions, instructions, examples' notes,
  context bodies and summaries, hooks' `explains` and `about`. A saved fn's name (`database/main.tasks`), a family
  (`input/ask_`) and another system's names are examples it can't know, and are left alone.
- **A fn's name as a value** is `g.fnName()` in gin (core's `FnNameValue` in zod): code and people see `fs/read`, the
  model sees and writes `fs__read`, and its tool schema says "A fn's name, as your tools spell it." Every field that
  names a fn uses it (`hub/fns_load`'s `fns`, `hub/inspect`'s `name`, `hub/fns_get`'s `fn`, …).
- **Stored data.** One store migration (`store/migrate-fn-names.ts`, run at start) rewrites the tool calls in stored
  transcripts (read back by the old rule, renamed, written by the new one) and the renamed fns in sessions and every
  other table that holds a fn's name. Model call records stay as they were; the LLM call view reads their old spelling
  with core's display-only `fnOfStoredToolName`, and asks the hub (`fnsOfModelNames`) for a cut name.

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

### Parallel claims

When a model makes several tool calls in one step, the hub starts them together, unless they operate on the same
thing. A fn says what its calls operate on with **claims**, plain strings compared exactly: `parallelClaims` in its
contract holds templates the hub fills from the call's args with no round trip (`file:{args.path}`; a list arg gives
one claim per item, `{args.dir|.}` names a fallback, `*` conflicts with every call), and `dynamicClaims: true` has
the hub also ask the system's `claims(args, ctx)` before the call starts (a path resolved against the roots, the
person and chat in `ctx`). The rule is aeye's (`claimsConflict`, `claimWaits`): a call whose claims conflict with an
earlier call's (in the model's order) waits until that call has settled, and the rest run together. A kind's
`describe` may add claims for a payload (a write query claims the tables it writes).

- **Where it runs.** The agent loop orders the child runs of an iteration itself: a call that must wait is **held** on
  the agent's state (`PendingCall.held`: what it waits for and what it starts with), and starts once those calls have
  settled. A call in the background is still running, so a held call keeps waiting for it. The state is saved as each
  held call starts, and child runs are keyed by iteration and call id, so a restart neither loses a held call nor
  starts it twice.
- **What takes no part.** Refused input (invalid args, a fn the model made up) never waits and holds no one up. A step
  of one call asks no system anything.
- **When it can't be told.** A system that is gone, or whose `claims` hook throws, makes that call claim `*` (it runs
  alone), with a warning in the log.
- **When the agent stops waiting.** Cancelling the agent (or its deadline, or its tool timeout while the person
  watches) skips its held calls for good, Continue included; the model reads that each did not run and why. A pause
  keeps them held.
- **`toolExecution: 'sequential'`** is the same mechanism: every call of such an agent claims `*`, so each waits for
  the one before.
- **Bundled fns that claim:** fs `write`, `edit` and `remove` (dynamic: `file:<full path>`, so `./a.ts` and `a.ts`
  clash); database `create_table`, `alter_table` and `change_schema` (`table:{args.table}`), and saved queries that
  write (`table:<table>` for each table written, from the kind's `describe`).

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

**Every fn has at least one example.** The author writes the examples of a native fn or an agent, and a static one
without any stops the build and `serve` before the system connects, with an error naming each such fn. A fn of any
other kind gets its examples from its kind: a kind's `describe` must return at least one, worked out from the payload
(a query's sample params, a form's sample answers, an MCP tool's own schema examples, sample args for api, code and
widget fns, a task prompt for a Claude agent). Examples the author wrote win over the kind's. When the hub starts, it
stores the declared examples of any fn that has none stored yet. The system page and the review flag a fn with no
examples, and say who owes them.

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
    hooks: { git: hook({ description: 'Adds the current branch and changed files.', explains: 'The branch and the files changed since the last commit.' }) },
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
- **Result renderers.** `results: { fns, kinds }` draws only a finished run's result, under the chat's own run line,
  by fn or by kind. A fn renderer, which draws the whole run, wins over it. A result renderer can draw with the app's
  own result view (`RESULT_VIEW`) and controls (`APP_COMPONENTS`), on every page that shows a run, not only in a
  chat. In a chat it can also reach the chat itself (`CHAT_HOST`) to ask in the composer, wait for a run's outcome,
  or move somewhere.

**System pages.** A system can own whole pages of the app. The contract declares them
(`system({ pages: [{ segment, title, icon, nav, access, component }] })` and `client()` names each component. A page
lives at `/s/<system>/<page>/…`. Pages with `nav: 'main'` are in the sidebar, and hidden ones are detail pages
reached by links. `access: 'admin'` pages are listed only for admins. The hub lists a person's pages only while the
system is live, has its renderers on, ships a client build and is visible to them. Each page is also a review and
switch item (`<system>: page <segment>`), so an admin can switch one off or hold it for review. Pages come and go
with their systems without a reload.

A link to a page whose system isn't installed keeps its URL and says so, and draws the page once the system is
back. A page that fails to load or throws says so, and the app stays up.

A page gets a host. It holds:
- the person and the typed hub web API, whose calls run as that person;
- the URL query, bound for `v-model`;
- links and moves between the system's pages and the person's chats;
- `openChat`, which starts a chat running a fn;
- `runs` and `inbox`, for the person's own runs and approvals;
- notices, formatting, and `live` refreshing;
- the app's shared components: the page frame, inputs, buttons, dialogs, fn pills, markdown, the chat's
  conversation, composer and approval card, and more, each with props typed in the SDK.

A page draws with these, so it looks and behaves like the app's own. Two systems own pages now:
- **Claude:** the fleet at `/s/claude/sessions`, and one session at `/s/claude/session/<instance>/<session>`. The
  transcript is drawn with the chat's own message, answer and note parts, with the chat's composer under it. The old
  `/claude` links redirect there.
- **Widgets:** the saved widgets at `/s/widgets/saved`. The proposal card and saved widgets are its result
  renderers. The old `/data/widgets` link redirects there.

Nothing of either is left in the web package except the shared result view, which the Data pages and plain fn
tables use too.

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
  stops what can stop; the rest finishes and is reported. In a chat, Stop opens the panel with Pause, Resume and
  Cancel. On a system page's composer (the Claude session page), one press of Stop stops at once, and the panel opens
  from the small menu button beside it, a long press or a right-click.
- **Undo a turn:** every run with an undo payload is undone, newest first. The turn also goes back to where it
  started: its messages come out of the conversation, the fns and context it loaded are unloaded, the ones it
  dropped are loaded again, and the graph selection is put back. The chat reports what really changed, and says
  "it had changed nothing" only when that is true. A turn can't be undone while a later turn of the session still
  stands, so undo goes newest first.
- **Retry** is undo and send again, a true redo. The web always asks before it retries.
- **Continue** carries on a turn that stopped at the step limit or was cancelled. It resumes the same run with the
  conversation kept: the step count and the turn's time start over, while the cost spent so far still counts
  against the turn's cost cap. In the web, Continue is the main button on such a stop and Retry the second one.
- **When it is blocked, it stops and says so.** Both chat agents' system prompts tell the model that when something
  it needs is unavailable or refused, or the same call keeps failing or returning nothing, it should tell the person
  what blocks it, with the reason the hub gave, instead of retrying or working around it. There is no hub guard for
  this; the prompt rule is all.
- **A/B compare.** Compare (beside the fn mode under the composer) sends the draft to 2 to 4 variants of the chat's
  settings at once: any setting can vary (the agent, model, chat mode, contextor, fn mode, systems, and the system prompt,
  `Session.instructions`). Each variant answers in a **fork** of the chat: a hidden copy of the session (its transcript,
  loaded fns and context, suggestions, what the model was told about the systems, and its session state) with the
  variant's settings over it, and a turn of its own. Nothing a variant does reaches the chat, and forks are never listed.
  The compared turn keeps the variants (`Turn.compare`); its user message is marked `compared`. Each variant is reserved
  an even share of the message's budget up front (its turn's cost cap is the turn's divided by the number of variants), so
  together they never spend more than one answer may; the ledger counts their spend as the chat's, so the chat's budgets
  see it. A variant's call that would change something (anything but reads and agents) waits for the person in that
  variant, whatever a policy, auto mode or an earlier "this chat" answer allowed (a deny still wins), and its approval
  names the variant (`Approval.variant`); an answer there is never remembered, so "always" in a variant never reaches
  the chat. The compare opens over the chat (`?compare=<turn>&v=<variant>`, the variant from 1): columns side by side on wide screens, one tab per variant on a phone, each with its answer as it streams, the
  approvals it waits on, its cost of its share, tokens and time. **Use this** (once that variant has finished) appends it
  to the chat: the transcript it added, the fns and context it loaded, the state it changed, and its messages, runs and
  LLM calls move to the compared turn, so the turn's tree, details and undo work as for any turn. "Keep its settings"
  makes its settings the chat's own too. The others are cancelled if still going and discarded; what they already did
  stays done and is listed on the turn (`TurnCompare.discarded`). A compare can't be chosen once a later message was
  sent or once it was undone. Undoing a compared turn undoes only the chosen variant's runs; what the others did (or
  every variant did, when it is undone before one was chosen) stays done, and the undo lists it by variant
  (`UndoReport.kept`): the note says how many changes each variant left and shows its fns as pills (a `kept-effects`
  part), and the undo toast counts them (Phil: "Keep effects, but list them in the undo notice"). The chat's own
  system prompt is in its settings (System prompt), so a kept variant's prompt can be seen, changed or given back to the agent. The variant dialog is built from the chat's own pickers
  (model, mode, agent, fn mode, systems, system prompt), warns when two variants are the same, and shows each one's
  share of the budget.
- **Use citations** (a chat setting, `Session.citations`, off by default; in the chat's settings and a variant field in
  A/B compare). Phil: "add chat option "Use citations" and the system prompt or next user message is told that it needs
  to cite it's work with `<cite tool="tool ID" path="results.0">how the citation provides evidence</cite>` … In the chat
  UI it renders as [#] where # is the citation in the chat history. Citations are stored in chat metadata so this
  computation isn't done all the time." How it works:
  - *Telling the model.* On from a chat's first turn, the rule (`chat/cite-rule.ts`, its own text, kept apart from the
    base prompt) is in the fixed part of the system prompt, after the mode's guide, so the prompt caches. Turned on or off
    later, the next user message starts with a hidden `<citations_changed>` block, once per change (a compare variant
    whose setting differs from the chat's is told the same way); what was told is `Session.citationsTold`, kept in the
    turn's start, so an undo or retry tells it again. The rule says what a cite is, its syntax, that `tool` is the id
    on the tool result's first line and `path` a JSON path into that result (`results.0.title`, `rows.3`, `""` for all),
    with an example, and that every claim from a tool result carries one.
  - *The id it cites.* A tool call id is not text the model reads (a recorded tools-mode request shows only the result
    JSON in the tool message), so while citations are on every tool result it reads, in both chat modes, starts with
    `tool id: run_…`, the run's id; background results too. A cite naming a tool call id instead is found by it.
  - *Streaming.* From an opening `<cite` the text is held back until `</cite>` (at most `HARNESS_CITE_HOLD_CHARS`, then
    it was no cite and shows as text), so the browser never sees half a cite; the whole cite streams as a `cite` event
    and its marker as a token.
  - *Stored once.* When the answer settles the hub parses its cites, resolves each to its run (in the chat, or the chat
    a fork is of) and the value at its path (in the result, else in the result as the model read it, such as a table's
    rows), numbers them in chat order (an undone turn's numbers are given again) and keeps them on the message
    (`ChatMessage.citations`; the value only up to `HARNESS_CITE_VALUE_CHARS`). A cite that doesn't resolve is kept
    with why. The text keeps a marker in each cite's place. A variant's cites live on its messages, so they join the
    chat with "Use this" and go with a discarded fork.
  - *In the chat.* Each cite is a small raised `[n]` chip. Hovering or pressing it opens a popover with the model's
    reason, the fn, the value in readable form (fields, items or text; JSON behind a toggle) and **Show in result**,
    which opens and lights up the run's card (opening its group), or the run panel when no card is on screen. One that
    doesn't resolve is dashed and says why. An answer given with citations on that cites nothing says "No citations" at
    its foot. Copying an answer gives `[n]` for each cite.
- **A held system shows a banner.** When a turn's runs show a fn refused because its system waits for a review, the
  answer shows one warning per held system, naming its fns. Admins get a link to the system's pending review.

### Chat modes and contextors

Two choices shape an agent's prompt, each set on the agent fn and changeable per session:

- **The chat mode** says how fns reach the model. **Tools** (strict) sends every selected fn as a native tool, as in
  build 1. **Static** sends six fixed tools whatever is loaded: `find` (`hub/fns_search`), `find_ctx` (`hub/ctx_search`),
  `inspect`, `load`, `unload` and `run`.
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

Static plus graph is the setup for small local models; `hub/chat_small` is the chat agent with it. **The systems
list follows the agent's detail** (Phil, 2026-11-22): an agent whose injected section takes summaries
(`injected: { detail: 'summary' }`, as `hub/chat_small` does) gets `<systems>` at one line a system (its name and
one-line description, not its `about`; the snapshot keeps both, `AnnouncedSystem.summary`), and the static tools'
short descriptions (`STATIC_TOOL_BRIEF`; their examples stay). That brought its fixed part from ~5,250 to ~2,990
tokens for the scenario stacks' systems on a 2,048-token `qwen2.5:3b` (core 969, systems 431, guide 126, tools
1,462, mostly their JSON schemas), still over the 1,413 the window leaves; `scripts/chat-small-fit.test.ts` holds the
target (fits 2k with room for a short message and some injected summaries) as an expected failure until it does.

**Seeing the whole prompt.** An admin can ask for the request a session's agent would send for a message without
calling any model (`previewPrompt`, the contextor slice: the message enriched with the hub's and hooks' blocks as
when it is sent, the planner's prompt planned as a turn's first step but keeping nothing (`PromptPlanner.draft`), and
the agent's aeye request caught where a model would be called, `AgentLoop.preview`), with the parts and the model's
token estimates, optionally planned for another model. `npm run prompt:render` boots a fresh stack the way the
scenarios do (`.harness-test/prompt-render/`, port 4360) and writes `hub/chat` and `hub/chat_small` as their models
read them, with a token table per part, against the chat model and a 2,048-token `qwen2.5:3b`.

When a context item in the prompt brings fns, it says which of them are in the model's tools this step, which are
not in its tools this step, and which it can't use now, with the reason (fns sharing a reason are named together).
The wording follows the chat mode. In tools mode the fns are "in your tools now". In static mode they are loaded:
their cards are in the prompt and the model runs one with `run`, or writes a `<run fn="…">` block when it has no
native tool calls. A fn that isn't loaded this step is one to inspect for its args and then run by name.

**Tools carry their examples.** In tools mode each native tool's description is the fn's description, its instructions and its example args (the turn's chosen examples, and at least the first declared one when it has any); that whole text is the aeye tool's description, since the agent prompt has no tools section for separate tool instructions. The schema goes at aeye's default strictness (strict where the model takes it). The static toolset's six tools carry their description and first example only, to stay small.

**One card format.** Every fn and context the model reads about, in every mode and every place (static cards, the
`more_fns` and `more_ctx` lists, `inspect`, a fn's exposed fns, a refused call, suggestions), is the same XML card,
written by one renderer: `<fn name label mode available reason>` with its description, args, returns, instructions,
examples and types as the room allows, and `<ctx key title>` with its text, the fns it brings and its choices.
Every value is escaped, so text inside a card can never pass for a tag. A fn the person can't use now still gets its
card, marked `available="no"` with the reason. What `hub/fns_load` and `hub/ctx_load` give back reaches the model
as cards too: the fns loaded and those refused with their reasons, and the context loaded with the fns it brought.
The run's record keeps the names as well, which the chat's held banner reads.

**The systems in the prompt.** The chat agent's system prompt lists the systems available when the chat started, as
`<systems>` with each one's name, label and what the model is told about it: the contract's `about` (`system(name, { description, about })`: what it is for, the sort of fns it has, the kinds it defines and when to reach for it), else its one-line description. It comes after the agent's instructions (the core text, `packages/sdk/src/chat-prompt.ts`, written for a model that knows tools and nothing of this app: fns, systems, context, asking, how calls behave, the blocks the hub adds whatever is installed; it names no installable system and lists no tools) and its injected section (below), where the hub's features and each system's own guidance are. The list is kept on the
session and never changes after the first turn, so prompt caching holds. When a system later goes on or off (the
person turns it on or off in the chat, an admin switches it, it disconnects or reconnects, it needs config, it waits
for approval, it is installed or removed), the next user message starts with a `<systems_changed>` block saying what
went on and what went off, and why, once per change. A system the prompt lists that stays off for a new reason is
told the new reason. The block is hidden in the chat and undone with the turn, so a retry announces it again. In a
chat several people share, the change is worked out for the person sending.

### What gets added to a message

Before the LLM sees a user message, two things may add to it:

- **The hub itself**, whenever it can, with no system involved: the person's local time and time zone, and
  suggested context and fns (from the index).

  A suggestion's score is its similarity of meaning to the message (cosine, measured in the database), not its rank.
  With EmbeddingGemma the scale is low: measured on 2026-11-22 over a scenario hub's 262 fns and context items and 42
  ordinary requests, a close fit (a saved query, a memory, a matching form) scores 0.35 to 0.7, a clearly relevant
  general fn only 0.2 to 0.3 (`widgets/make_widget` 0.23 and `database/create_table` 0.13 for an ordinary request to
  keep track of something), the median item 0.09 to 0.19 and the 90th percentile at most 0.27. With no model, an
  item needs `HARNESS_SUGGEST_THRESHOLD` (0.3, past nearly all of that noise) to be suggested, the best first, up to
  `HARNESS_SUGGESTIONS` (6); the old 0.45 let almost nothing through. A chooser (a decision model or an LLM) picks
  among the candidates over its floor (0.2 by default, so it sees the near misses); when it fails, the threshold
  decides. Searches still order hits by fusing the word and meaning ranks. Suggestions are found by meaning only:
  while the embedder can't answer in time, nothing is suggested rather than the best word matches.

  Suggestions are **brief cards** in the one XML format (Phil, 2026-11-22: "Brief cards"), under a line written for
  the session's mode: in tools mode the model loads them with `hub/fns_load` or `hub/ctx_load` and then calls them;
  in static mode it runs one by its name (inspecting it first for its full args). A suggested fn is its name, label,
  mode, description and its first example's args; its full args and returns come when it is loaded (or with
  `inspect`). A suggested context item is its title and summary (its description when it has none). A card stored
  whole before brief cards reads brief too. `<loaded_for_you>` is unchanged: what is loaded is there in full. Each
  card is fixed when the message is sent, so the message reads the same later even if the fn changes. Fns the person can't see, or that aren't for the model, are left out;
  fns they can't use now are shown with `available="no"` and the reason. **Nothing is suggested twice in a chat:** what
  was suggested is kept on the session in the hub database, and neither the hub nor a hook suggests it again, nor
  anything the session already has loaded. The search query itself leaves those keys out, in the word, meaning and
  combined searches alike, so a page of suggestions is still full. Undoing a turn gives its suggestions back.

  **Who picks** is one admin setting (Models page, "Who picks"): **no model** (the default: the best candidates by
  similarity at or over the threshold are suggested, up to the cap; until 2026-11-22 it meant no suggestions at all),
  a **decision model** (its own, or the decide role's), which answers one yes/no question
  per candidate and picks those at or above the decide role's threshold, most likely first, or an **LLM** (a chat
  model), which reads the candidates and answers which to pick, with reasons. If the model fails, the score decides.
  A system's `decide` link call uses the same choice.

  **What it does** with its picks is a second choice for a model chooser (Phil, 2026-11-22: "There should also be
  options to not only allow a decision model or llm to suggest context or fns but actually have them automatically
  add them making the fn available or the context is brought into the user message"): **suggest** (the default, the
  cards above) or **load**. With load, what it picks is loaded for the turn as `hub/fns_load` and `hub/ctx_load`
  load: each fn the session may use joins its tools from the model's first step (in static mode its card is in the
  prompt, run by name), and each context item is brought into the user message as its text, with its imports and the
  fns it brings (which join the tools too). The message tells the model so in a `<loaded_for_you>` block (who picked,
  each fn with the chooser's reason, each context item's text), so it uses them and doesn't load them again. Context
  is sized to the prompt: at most `HARNESS_AUTOLOAD_TOKENS` (6000) of text, and no more than
  `HARNESS_AUTOLOAD_ROOM_SHARE` (a quarter) of the room the agent model's window leaves past its output, reasoning,
  margin, instructions, tools and the message; the planner counts the message in its fixed part, so the history gives
  way, never the window. What doesn't fit (`budget`), a fn that can't be used now, or a context item with no text of
  its own yet (`blocked`), is suggested as a card instead, and the message's record says what became of each pick
  (loaded, budget or blocked; the admin's "Try it" shows it too). Loaded items count as suggested, so nothing loaded
  is suggested again, and undoing the turn takes the loaded fns out of the tools again (the turn's start keeps the
  tools as they were) and the message, with its context, goes. No model (the score alone) only suggests: similarity
  is too weak a sign to put things in the prompt unasked. When the model fails, the score's picks are suggested, not
  loaded.

  The **fn and context search decisions** (who filters `hub/fns_search` and `hub/ctx_search` hits: the fn decision
  judges `fns_search`'s, the context decision `ctx_search`'s) take the same action. With load, either search in a chat
  also loads the best kept hits it may use, up to
  `HARNESS_SEARCH_LOAD_MAX` (5) each: fns into the tools, context into the session (with its imports and the fns it
  brings), and its page says so (`loaded`, with a line telling the model not to load them again). The web's search
  only filters, and a filter that failed loads nothing. A `hub/ctx_search` hit already in the prompt says so
  (`inPrompt`: `injected` for an item of the agent's injected section, `loaded` for one loaded in the chat, the page's
  own loads included), and a load never loads it again.
- **Systems' hooks**: a system can declare a hook and add its own information (the git branch, the open
  ticket). A hook gets the message and the same who-and-when every run gets. Its block is tagged after the hook
  (`fs/git` → `<fs_git>`), and what the block means is the hook's `explains`, injected with its system's items (the
  hub's prompt names no hook). fs's git hook reports a root only when
  the root is its repository's top level: a root inside another repository is not that repository, so its branch
  and changed files are left out.

Each addition is a small tagged block in the message, so the model can tell it apart from what the user
typed.

**A form's answers come back as the next message.** A run is the chat's own (`RunInfo.inChat`: the turn's agent or a
fn it called directly, on a session, not in the background) whether or not anyone has the chat open (`watched`). A
form shown there tells the agent to end its turn: the person's answers arrive as the next user message, in
`<input-answer>` tags, whenever they send it. Only a run that is not the chat's own (a nested agent's call, an MCP
call, a background run) is told not to wait, since the answers go to the chat and not back to it. Until iteration 2
this went by `watched`, so a chat nobody had open (every scenario run) told the chat agent "Nobody is watching… go on".

**Attached files are resources the model reads in one call** (iteration 2: attached pictures, PDFs and spreadsheets
reached the model as a name and a hash, and it spent its turn looking for them). When a
message is sent, each file is kept as a hub upload (`hub://resources/uploads/<day>/<name>`, as its sender), and the
message carries the resource's uri. The model reads `<file name mime size uri read="…" />`: `read` names the one fn
that reads it, called with `{ "uri": … }`: `hub/resource_send` for a picture (the model sees the image itself),
`hub/resource_read` for anything else (a PDF's pages, a spreadsheet's tables, a document's text). A text file (plain
text, markdown, CSV, JSON…) of up to `HARNESS_FILE_INLINE_CHARS` (4000) characters is in the block itself, with
`truncated="true"` when only its start is (`chat/files.ts`). The readers (and `hub/resource_outline`) join the
session's tools with the message. A file the hub could not keep goes out with its content ref (`hash`) only, which
`hub/resource_import` takes. For a chat model that can't see images, an attached picture's tag reaches it as an
`<image id>` block instead ([Images for models without vision](#g/images-without-vision)).

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
  and `subtitle` must be fields of the shape). Mention chips and cards use it now; widget rows and their action menus do not yet.
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

Reasoning pieces that sit next to each other in an answer (with nothing shown between them) read as one block.
Side panels (a run, an LLM call, details, settings, people, the model) can be dragged wider or narrower from their
left edge, between 360px and 60% of the window; each kind of panel remembers its own width, and a double-click
puts it back. Tab strips scroll sideways with the mouse wheel and show an arrow on a side with more tabs beyond it.

**Fn pills.** Wherever the web names a fn (grants, review lists, refusals, approvals, the chat's run tree, LLM call
details, turn details, banners, pickers, the Data page) it shows a pill: the fn's friendly label tinted by its
system, its qualified name on hover, and an off look with a short word ("held", "off") when the hub says it is
blocked. Clicking one opens the one fn modal the whole app shares, bound to `?fn=` on whatever page is open, so the
link can be shared and Back closes it. Admins see the fn's full details there, others its overview. A glob
(`hub/search_*`) or a whole system is a link to the admin's fns list filtered to match, for admins only.

**Admin.**
- **The graph is an admin page** (`/admin/graph`, in the Systems group beside Fns; the old `/graph` link goes
  there). It searches with the same search bar as every other list (`list="graph"`): text, and filters on system,
  node kind, edge kind, fn kind, mode, effect, visibility, stage and machine, all applied by the hub. The graph's
  own controls (focus and how many hops, collapse, references outside) sit in the bar, every one is in the URL,
  and a line under it says how many nodes and edges are shown. The hub's graph endpoint and the `hub/graph` fn take
  the same `text` and `filters` and refuse a bad filter.
- **System counts.** Each system card shows chips for its fns, context, types and instances (only when 2 or more),
  and warning badges for pending changes and refusals; zero counts are hidden and each chip opens its tab. The hub
  counts them in the database, and the systems list can sort and filter by each count.
- **Toggle all.** The Fns tab has one switch for all of the system's fns, as the Context tab has for its context.
  Turning it off also turns off the system's mentions and hooks; each fn keeps its own switch.
- **The Pending tab** starts with a summary the hub works out: what was added, changed and removed, how the grants
  moved, whether the config type changed, and risk flags (new delete or write fns, new effects, hub calls,
  secrets, hosts, file paths, fns it may call, models). The chat's install card shows the same summary, for the
  contract whose hash the install binds. Each change is a card drawn the way its tab draws it (fn facts before
  and after, `TypeDiff` for types and the config type, context as a word diff, grants as a delta), with the raw
  diff behind a toggle. An admin approves or declines each change on its own, or all at once: approved changes go
  live, declined ones are switched off and listed under "Declined", and the rest keep waiting. When nothing
  waits, the reviewed version becomes the live one.

### Configuring by asking

Everything an admin configures can also be done by asking in chat, through the hub's native fns: providers,
model categories, transcription, web search, systems, pairing, priorities, budgets, policies, actor settings.
These always need approval.

### Push notifications

The hub sends web push notifications: approval or input needed, a reply to your message, a turn finished while you
were away, a system waiting for pairing, a budget reached, and what a system tells one person (`system-message`).

A notification has a `link` (a session, an approval, a pairing, a run, a system, or one of a system's declared pages:
`{ page: { system, segment, path?, query? } }`), an optional second link with a label (`also`: a button in the
inbox and an action on the push), a `tone` (`ok`, `failed`, `info`: the inbox icon) and a `key`. A new
notification with the same key replaces the person's unread one in place (same id, newest, unread again), and the key
is the push's tag, so the phone replaces it too: a run that repeats leaves one item, not forty. A body holds at most
`NOTIFICATION_BODY` (160) characters, in core, so the chat and systems clamp alike.

**Runs a system starts by itself** (the `runs` grant; the review flags it: "Starts runs on its own, as the owners of
its fns, and notifies them"). Outside any run, a system may list the saved fns of its own kinds with owner, title,
version and parsed payload (`ctx.runs.kindFns`, optionally only those changed or removed since a time), start one as
its owner (`ctx.runs.start`) and tell that owner how it went (`ctx.runs.notify`). A start makes a sessionless turn
for the owner (limits for `background` unless asked otherwise, the turn's budget lowered by `maxSpend`) with the
system's actor as caller, so the owner's policies, approvals, budgets and the ledger apply as at any call; it is
refused (with the reason) unless the fn is a saved fn of the system's own kind, the system is live and its owner can
still use the hub. Its `key` is required and makes it idempotent: the same key is the same run, whether the start is
retried later or doubled at once. Inside a run, `ctx.notify` tells the run's own person. A notice reaches one person
only and links only to their runs or the system's own declared pages (by page ref, `contract.page.<segment>`, never a
segment string); its key is kept per system. The settled run event says `notified` when the run or a run under it
sent its person a notice, so a system that reports runs doesn't tell people twice. The SDK types every ctx an
implementation gets with its own kinds and pages (`OwnOf`), so another system's kind, fn or page doesn't compile,
and only a `KindFn` `kindFns` listed (branded) can be started.

**Removing a saved fn** (`hub/fns_remove`): a system removes a saved fn of its own kind, for its owner or an admin,
declared as a dep and an effect (`fns` `remove`) like `hub/fns_save`. The hub keeps its versions (a `removed`
version holds the declaration it last had), and undoing the run saves that version again. Undoing a run of
`hub/fns_save` likewise puts back the version before it (or removes the fn the save made), unless the fn was saved
again or removed since, so undoing a turn takes back what its saves did. The `fns` event says
`added`, `removed` and `changed` (saved again, or its availability moved), so an edit made anywhere re-plans
what a system keeps of its fns.

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
- **Every answer has an output bound** (iteration 2: GPT-6 Luna once wrote 65k tokens of whitespace into one tool call
  over four minutes). An agent fn's answer is capped by its declared `maxOutput`, else `HARNESS_AGENT_MAX_OUTPUT`
  (16k tokens; 0 leaves the model's own limit), and an authoring agent's steps by `HARNESS_AUTHORING_MAX_TOKENS` (16k,
  or the agent's `maxTokens`). Every chat stream also passes the **stream guard** (`execution/stream-guard.ts`): a tool
  call whose arguments run into `HARNESS_STREAM_BLANK_RUN` blank characters in a row (2000; spaces, newlines or their
  JSON escapes) is stopped there, and a call the output limit cut off is finished instead of reaching aeye as `length`.
  Either way the call's arguments become a short note ("Stopped by the hub: …"), which fails to parse, so the model
  reads it as that call's invalid input and calls again; nothing runs. An answer whose text runs blank just ends.
- **Forwarded calls cost the loop little** (iteration 1, rep 3, where the hub shed load). A system's call carries its
  tool schemas as JSON schema; the hub rebuilt a code authoring step's 54 KB program schema every round (12 to 21 ms)
  and converted it back to JSON schema to save the interaction (about 110 ms), all on the event loop. Rebuilt schemas
  are kept by their JSON (`HARNESS_WIRE_SCHEMA_CACHE`, 64) and each zod schema's JSON schema is made once, so a step
  costs under 1 ms after the first (measured on rep 3's own recorded requests).

### Every model call is recorded

Every call to a model of any modality goes through the hub: chat, embeddings, images, transcription and speech.
Systems use the hub as their provider for all of them. Each call is a **model call** record: modality, provider,
model, what it used (tokens, texts, images, seconds), cost, queue wait, time to first byte, total time and size,
attributed to the run that made it (or to the hub's own work, like indexing). A chat call also keeps its whole
request and response. Model calls are not fns: fns are what agents choose to run.

### Model roles

Besides the model an agent uses, the hub picks a model for its own jobs: **transcribing** audio, **dictation** in
the composer (or the browser's own speech recognition), **speaking** answers, **describing** images (and answering
questions about them for a chat model that can't see: [Images without vision](#g/images-without-vision)) and **reading
text** in them, **deciding** (yes/no questions answered by a decision model), and the default chat model. Each role is
set in the admin's model settings (a model, optionally the provider that serves it, a language) or by asking in chat.

The **decide** role takes only models with the `decision` capability, and has a **threshold** (0 to 1, default 0.5)
instead of a language: an answer counts as yes when its probability is at or above it. A decision model may cap how
many questions one call takes (`maxQuestions` on the model, 64 for Ollama). aeye never splits a call; it refuses one
over the cap before sending it. The hub's own callers (suggestions, systems' `decide`, `hub/ctx_crawl`, the search decisions) go through
one decider that picks the model (the job's own or the role's) and sends the questions in batches that fit both the
model's question cap and its request size (`maxRequestBytes`), one call after another. A question too large to fit
alone is refused before anything is sent. Every decide call is a model call with modality `decide`, budgeted and priced like the others.

### Images without vision

Phil (2026-11-23, verbatim): "For image reading if the current model doesn't have vision then the image content should
be replaced with xml about the image with an identifier then an image read tool with that ID and a request which does
get sent off to an llm configured by an admin to answer the question for the blind llm."

A conversation keeps every resource the model is shown **by reference**, never its bytes: a done `hub/resource_send`
call is followed by a hub-written `<shown uri="…" section="…">` message (it starts no exchange), and an attached file
is its `<file … uri>` tag. Before each model call the agent loop makes the conversation for the model that call goes
to (`chat/shown.ts`, `ConversationMedia`, as the run's person, before the planner so estimates and spelling see it):

- **A model with `vision`** gets a shown image as an image part (a data URL), as before; attached pictures stay
  `<file>` tags it opens with `hub/resource_send`.
- **A model without `vision`** (also an automatic choice, or a model no provider lists) gets, in place of every image
  it would receive (a shown image, an attached picture's `<file>` tag, an image part already in a message), an
  `<image id="…" name mime size width height source>` block: `id` is the image's resource uri, the width and height
  are read from the bytes' header (PNG, GIF, JPEG, WebP), `source` says where it came from, and one line says to ask
  about it with `hub/image_read {"image": "<id>", "question": "…"}`. With no image model set up the line says nothing
  can read it instead. An image part with no resource behind it says it has no id. No model call is made to build a
  block. An image too large to send inline (`INLINE_MAX`) is a block for a vision model too.
- A shown resource's text (a document sent whole) is kept to `HARNESS_READ_CHARS`, saying how to read on.

**`hub/image_read`** takes the id and a question (`ImageReadArgs`, at most `IMAGE_QUESTION_MAX` characters), checks the
caller may reach the resource (as `hub/resource_read` does), and sends the image and the question to the **describe**
role's vision model through the LLM gateway, recorded against the run (an `LlmInteraction` and a `ModelCall`); it
answers `{ answer, model, image: { id, name } }`. It declares `roles: ['describe']`, so it is unavailable
(`role-unset`) until an admin sets that role on the Models page or with `hub/set_model_role`, and a call that reaches
it anyway is refused "no image model is set up" (`NO_IMAGE_MODEL`). Something that isn't an image is refused with
`NOT_AN_IMAGE`. The hub's **Unseen images** item (`packages/hub/context/images.md`) brings the fn and explains the
block; it is injected only while the fn is available. The scenario runner sets the describe role to GPT-6 Luna
(`HARNESS_SCENARIOS_IMAGE_MODEL`) on every rep's hub.

Since only references are kept, undo cuts them with the rest of a turn, and a chat that changes model reads every
earlier image the way its new model takes them.

### Providers from systems

A system can provide a whole aeye provider: its contract declares the provider and its models (with prices and
abilities, and for embedding models their `dimensions`), and the server answers chat, embed, decide and model-list
calls over the link. The hub offers it like a configured provider while the system is live. Its model list is read
live from the provider's `listModels`, but only ever includes the declared models, which an admin reviewed: the live
list can drop a model the provider no longer serves and update its window, reply and question limits, never add one or
change a price. A system that doesn't answer within 5 seconds is offered its declared models.

Embedders are part of this. The index's embedders are the embedding models of offered providers, named
`<system>/<model>`; the `embedder` system declares a `gemma` provider with `document` and `query` models (768
dimensions), so `embedder/document` and `embedder/query` keep their names and stored vectors stay valid.

The hub's own Ollama provider is aeye's `@aeye/ollama`. It reads a model's abilities from Ollama's `/api/show`; when
that lists none, the provider's **Decision models** field (an admin's list) marks which models decide. Decisions go to
Ollama's `/v1/systemone`.

**Runtime providers.** A provider whose models an admin chooses while the system runs is declared
`provider({ description, models: 'runtime' })` (at most one per contract). The contract has none of its models: the
running system sets them, whole, with `running.models(contract.providers.<name>, models)`, and each fleet instance sends
its own, **named after the instance** and owned by it (`SystemProviderDecl.runtime` and `instance`), so `ollama/desk`
and `ollama/laptop` are two providers. The hub routes each one's calls to its instance, offers it only while that
instance is connected, keeps each instance's own when another sends (`fromInstance`, as with types an instance owns),
drops it with the instance, and rebuilds the hub AI when its models change (the offered set is compared by
declaration, not just by name). Once an admin reviewed a system that has a runtime provider, a change to such a
provider's models goes live without another review as long as every model is free (`runtimeProviderChange` in
`link/lifecycle.ts`); a price, or a provider that isn't runtime, still waits for one. The live list still narrows the
declared models to what the provider serves now.

### The Ollama system

Phil (2026-11-23, verbatim): "Add an ollama system to be aeye provider the user can select models from"; what it is:
"Actually installs and runs ollama and can get models listed and installed etc."; who picks: "An admin offers, a
person picks per chat".

`systems/ollama` (`"instances": "many"`: one per machine or server) runs an Ollama, manages its models and offers the
ones an admin chose as a runtime provider named after the instance, so people pick them in a chat's model picker like
any provider's.

- **Where Ollama runs** is the instance's config (`server`, zod `OllamaServerConfig`, read with `ginAs`): `managed`
  (the official release installed in the instance's data folder and run from there; the default), `binary` (an Ollama
  already on the machine, `path` or the first one found, run by the system with its models in the data folder unless
  `modelsDir` says otherwise) or `url` (a server someone else runs; the system lists, pulls, removes and offers, but
  never starts or stops it). `managed` and `binary` take `port` (11435 by default, so an Ollama already on 11434 is
  left alone), `host` (127.0.0.1), `autoStart`, `contextLength` (Ollama's `OLLAMA_CONTEXT_LENGTH`) and `keepAlive`.
- **Installing** (`ollama/install`, `managed` only): the release for the OS and architecture comes from GitHub's
  releases API (`ollama-windows-<arch>.zip`, `ollama-darwin.tgz`, `ollama-linux-<arch>.tar.zst` or `.tgz`), is
  downloaded with linear progress, checked against the sha-256 the release publishes (the asset's own digest, else its
  `sha256sum.txt`; a mismatch installs nothing, and a release with no checksum at all says so on the card), unpacked by
  the OS's own `tar` (System32's on Windows; no shell, a bare environment) into a new, empty staging folder and moved to
  `<data>/ollama/<version>/`, with `<data>/ollama/install.json` recording it. No system-wide installer, no admin rights.
  Older versions are removed once the server isn't running them.
- **Running** (`ollama/start`, `ollama/stop`): `ollama serve` is a child process, run directly with the OS's
  essentials, the GPU names in `OLLAMA_SYSTEM_PASS_ENV` and Ollama's own settings (`OLLAMA_HOST`, `OLLAMA_MODELS`, …),
  never the system's other environment. A start is refused while anything already answers on its port, waits until
  the server answers (`OLLAMA_SYSTEM_START_TIMEOUT`), and a crash is restarted after a wait that doubles
  (`OLLAMA_SYSTEM_RESTART_DELAY` up to `…_RESTART_MAX`) until `OLLAMA_SYSTEM_RESTARTS_PER_HOUR` crashes leave it
  `failed`. `autoStart` starts an installed server when the system starts and after a config change (the admin's
  config is the consent); the system stops it when it stops. `ollama/status` gives its state, address, version,
  restarts, last exit, problem, install, pulls in progress, the offered models and its last output; `ollama/detect`
  finds programs on the PATH and where installers put them, and servers that answer, without running anything.
- **Models** (`ollama/models`, `ollama/pull`, `ollama/remove`): the list reads `/api/tags` and `/api/show` with
  `@aeye/ollama`'s own readings (`capabilitiesOf`, `servedWindow`), so it shows the same abilities (tools, vision,
  reasoning, embedding with its vector size, decision), trained length and served window the provider uses, beside
  size, family, parameters and quantization. A pull streams Ollama's progress as linear progress (and into
  `ollama/status` for the page); a removal drops the model from the picker at once.
- **Offering**: the config's `offered` list (`OfferedModel`: `model`, `label`, `contextWindow`, the cap on what the
  hub sends it, Ollama's `num_ctx` served window never raised; `maxOutput`; `decision` for a server that doesn't list
  the ability). The provider declares the **offered models the server has** (`declaredModels`, free, each within its
  offer), sent again whenever that set changes: at start, on a config change, once the server answers, and after a
  pull or a removal. The provider itself is `@aeye/ollama`'s `OllamaProvider` pointed at the instance's server
  (`OfferedOllamaProvider` only narrows its live list to the offers and their caps), so chat, embeddings and System One
  decisions are aeye's code; nothing of Ollama's API is written again. The OpenAI-compatible endpoint takes no
  `num_ctx`, so the served window comes from the Modelfile or the managed server's `contextLength`; the offer's cap
  keeps prompts within it.
- **Admin only, with approval.** Every fn is tagged `admin`; `install`, `start`, `stop`, `pull` and `remove` ask an
  admin first (`approval: { approver: 'admins' }`) with a card that says what happens (the file, its size and how it is
  checked; the command and port; the model and where it goes). The reads (`status`, `detect`, `models`) don't ask.
- **The page** `/s/ollama/servers` (admins, the app's own components) shows one instance at a time (`?on=`): its
  state, facts and output, Install / Start / Stop, the models with an Offer switch and a context cap each (written to
  the instance's config with the hub's `configureSystem`), Pull with progress (read every second while a pull runs) and
  Remove. Reads are the hub's quiet read (`readFn`), which takes `on` to name a fleet instance; changes are the
  admin's own runs in an "Ollama" chat, their approvals answered on the page.
- **The hub's built-in Ollama provider stays** for a server an admin only points the hub at (Models page; one base
  URL, a decision-models list, every model the server has). Use the system when the hub should run and manage Ollama on
  a machine, or choose which of a server's models people see; use the built-in provider for a remote server nobody
  manages from here. Both use `@aeye/ollama`, and both can point at the same server.
- **In development** `npm run dev` runs it only with `HARNESS_DEV_OLLAMA` set: an address (its `url` mode) or
  `managed` (with `autoStart` off; nothing is installed until an admin approves). Its tests fake the release, the
  download, the unpack, the child process and Ollama's HTTP API; nothing real is installed, started or pulled.

### Fn metrics

Every run records how long it waited in the queue, waited for approval and ran, what it cost and used, how it ended
(done, invalid input, failed, cancelled) and how often it was retried. The hub rolls these up per fn and per day;
the admin's fn pages show them and `hub/fns_metrics` gives them to the LLM.

### Invalid input is not an error

A model's mistake in calling a fn (JSON that doesn't parse, arguments that don't fit the fn's type, input the fn's
own checks refuse) ends the run as **invalid input**: the problems go back to the model so it can try again, the
chat shows it calmly as "Thinking harder", and it doesn't count as a failure. A real failure is **failed**.

Phil (2026-11-23): model mistakes are not errors, anywhere. The chat never shows a model's slip as an error or a
warning in red: a call that went back to the model reads **"Thinking harder"** (its card: "Thinking harder · no bearing
on the result", what was wrong in its tooltip and details; the live status line: "Thinking harder…" while the model
works out a better call), and so do the other slips the model recovers from: a field it sent as a string of JSON (the
run's details say the hub read it as JSON), a call the hub stopped mid-stream ("Stopped by the hub", a stuck stream or
the output limit) and a tool name it wasn't offered (an LLM call's details note both quietly). Fn metrics keep them
apart from failures (a fn's failure rate counts its real runs only; "Fixed by the model" counts the rest), the hub logs
them at `info`, and the scenario judge, checks and diagnosis count them apart as model arg mistakes, recovered or not:
not delivering a good result is the failure.

The problems are short (iteration 2: a nested type's mistake came back as megabytes of union branches, or as
"Unrecognized key: props" one level too high). `conciseIssues` (core) names at most five, each at its full dotted path
with what was expected there: a union is followed into the branch the value got furthest into, a union no branch of
which got past its tag says which tags fit (`program.vars.0.value: no form fits; "kind" must be one of: get, new, …`),
and a gin type at the failing path is parsed by gin, whose message names the real fault
(`gin.parse: prop 'id' has unknown key 'name' — valid keys: docs, type, …`) with the shape of an object type. The hub's
args check uses it, and so does every authoring agent's tool (`parseArgs`, which also reads a field sent as a string
holding JSON).

### The schedule system

Phil's words (docs/plans/todo-2026-11-23.md, verbatim): "Schedule system which uses dayspan-ts schedule format to
schedule fns. It also adds a schedule page with a calendar that shows scheduled fns. The payload could contain gin
program since some fns that are called has arguments." The design, its decisions and what each slice built are in
docs/plans/schedule-system.md.

`systems/schedule` (`"instances": "one"`) adds the fn kind `schedule/schedule`: a schedule is a saved fn of the
person's whose payload names a fn to run, *when* as a dayspan schedule read in a time zone, and its args as a gin
program over `fire` (this firing) and `previous` (the last one that ran). The system owns the timer:

- **The kind.** Its check refuses times closer together than the config's `minGap`, a target the owner can't see,
  and an args program that calls fns or doesn't give the target's args. Its describe gives the schedule fn's args
  (`{ at? }`: the timer passes the planned instant; without it a call is "run now"), the target's result and mode,
  and the target as its dep (with `hub/fns_get`, to read the target's signature again when it runs), so a firing may
  call it with no new grant. Its run works out the args (checked again against the target as it is now), calls the
  target as its child, follows it through a wait for approval and records the firing. Only its owner runs it.
- **The timer** keeps one delayed `@ayepi/work` item per schedule (its next firing, at the planned instant) on SQLite
  in the instance's data folder (`SCHEDULE_DB`), beside a row per schedule and per recent firing. It reconciles at
  start and on `fns` events (`ctx.runs.kindFns`), starts a due firing with `ctx.runs.start` as the owner (key
  `schedule:<fn>@<instant>`, background priority, the payload's `maxSpend`), and hears it settle on the `run` event.
- **Catching up.** Every firing since the last one handled is due at once: the latest runs (late) when it is on time
  (`SCHEDULE_ON_TIME`) or within the config's grace window with `missed: 'latest'`; the others are recorded as
  missed and told in one notice (or in the latest's, when it runs). While the hub can't be reached a firing waits and
  tries again (`SCHEDULE_RETRY`) until the grace window passes.
- **Overlap**: a firing due while the last still runs is skipped (default), queued (at most one waits) or replaces it.
- **Approvals**: a firing whose target waits for approval waits until its next firing or `SCHEDULE_APPROVAL_WAIT`
  (24 h), then gives up (`expired`); with the config's `approvals: 'refuse'` it is cancelled at once (`refused`).
- **Limits** (the config): schedules per person (the newest beyond the limit don't run) and firings per person a day;
  a firing past one is refused with the reason.
- **Records and notices.** Each firing is a `schedule/Firing` record of the owner's (written in its run, or, for one
  that never became a run, by the system outside any run naming the owner: `ctx.data.save(type, value, { owner })`,
  which the hub allows only to a person-owned type's own system outside a run). Its one-line summary is worked out by
  fixed rules, never a model: the reason, a text's first paragraph, "12 rows: …", an object's telling field, or the
  target's own done line, with "(2 h late)". The owner is told once per settled firing by `notify` (always, failed,
  never): never a skipped or "run now" firing, a refusal once per reason, no "ran" when the run already told them
  (`notified`), keyed per schedule, linking to the run (or the schedule's page at that firing) and to its history.
  Records are pruned to the config's `keep` (per schedule and days), at most daily.

- **The chat's fns** (group `schedules`). `schedule/add` reads the target with `hub/fns_get`, checks the payload with
  the kind's own `scheduleProblems` (and that it runs at all, and that the first run's args work out) and saves it with
  `hub/fns_save`, named from `name`, a reminder's text or the target (the next free name when one is taken); it answers
  with the schedule as the chat shows it (`ScheduleView`: its words, the next three runs, the first run's args, when the
  person is notified). Fixed args become a literal program; args that change with each run come as `compute`, plain
  words that a small authoring agent on `ctx.ai()` and the program tools (`schedule_args_author`: `examples`, then
  `set` checked against the target's args and run for the next three runs, then `return`) turns into the program, kept
  with the words (`argsAsked`). The program reads `fire.date`, the run's local day as a gin date, for day arithmetic.
  `change`, `pause` (until a day), `resume` and `skip` (one run's `exclude`) save a new version over the old;
  `remove` uses `hub/fns_remove`; only the owner changes a schedule (an admin may also pause and resume one). `list`
  reads the person's schedules from the timer with each last run from the firing records; `history` is a page of those
  records; `remind` notifies its own person (`ctx.notify`), so "remind me" is a schedule of it.
- **Undo.** Each saving fn's run has the hub's save or remove as its child, and the turn's undo undoes that child:
  `hub/fns_save` now has an undo of its own (it puts back the version before, or removes the fn the save made, unless
  the fn was saved again or removed since), as `hub/fns_remove` has. The schedule fns' own undos say that in words.
- **Result renderers** (`systems/schedule/client`): `add` and `change` as the schedule's card, `list` as one card per
  schedule with a link to the calendar, and a run of a schedule fn (its run page, a chat) under a header naming the
  schedule and when it was planned for, above the target's own result.

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
- **Signing in** (SSO, to-do item 2): generic OpenID Connect providers from `HARNESS_SSO_PROVIDERS` (env only), run
  by `@ayepi/auth/oauth`'s `OidcClient`. A provider button starts at `/auth/sso/<provider>/start`; what finishing
  needs rides in a signed, httpOnly cookie on `/auth/sso/callback` (the same signed-payload helper as the connections'
  `state`), and the callback hands the sign-in page a one-time code in the URL fragment, bound to that browser by a
  signed httpOnly cookie on the redeem endpoint (`redeemSso`), which swaps it for the session's tokens once, within a
  minute (security review M2). An
  `ExternalIdentity` (issuer, subject) links a provider account to a person; otherwise a matching email links only when
  `email_verified` is true. A first sign-in with nobody to link makes an account only as the admin's policy allows
  (invite only, email domains, anyone). Claims set the role (admin, member, or not allowed) and the groups of the same
  names, again at every sign-in; memberships a sign-in made are marked with the provider, so it takes away only its own.
  Once a provider is configured, only the bootstrap admin keeps a password. That admin is the break-glass login: the
  first account given a password, always an admin, never turned off, and the only password sign-in the page offers
  (folded under "Admin? Sign in with a password"). A provider sends people back to `HARNESS_URL`, and the sign-in is
  bound to the browser that started it. A start opened at any other address (the LAN IP, the web dev port) first
  sends the browser to the same start on `HARNESS_URL`, keeping where to go after, so the sign-in finishes there.
- **First admin and password tries** (security review M1, M12): a hub that starts with no one in it (and no
  `HARNESS_ADMIN_*`) makes a one-time setup code, prints a `/sign-in?setup=<code>` link to its log and writes the code
  to `setup-code.txt` in its data folder; the setup page needs it. Password tries are counted with `@ayepi/rate` in the
  hub's database per (email, address) and per address, never per email alone, so guessing from elsewhere never locks
  the owner out. The limits and the number of trusted proxies (`X-Forwarded-For` is ignored until an admin says one is
  there) are admin settings on the People page's Sign-in tab, read through one helper (`api/client-address.ts`).
- **Admin › People** (`/admin/people/<tab>`) has three tabs. **People** lists everyone (searched, filtered and counted
  in the database), and a person's panel sets their role, whether they can sign in and their groups, and shows how they
  sign in; an admin can add a person ahead of their first sign-in. **Groups** lists the groups with their member
  counts and members. **Sign-in** shows each provider read-only with the redirect address to register and what its
  claims map to, with **Check** (discovery and key set reachable) and **Test sign-in** (a real provider sign-in that
  signs nobody in and shows the claims and what a sign-in would do), then the "Who can join" policy and the
  break-glass card. Every tab, search and open panel is in the URL. A member sees how they sign in and their groups in
  Settings › Account.
- **Policies** decide whether an actor may run a fn: allow, deny or ask. "Ask" names who decides: the
  user who started the turn, a specific actor, a group, an LLM judge (an `llm` fn), or the hub itself.
  Policies match fns by name, system, kind or tag, and by the fn whose run made the call (`via`, at any depth up the
  run's tree), so "always allow `fs/write` when a nightly backup fn calls it" leaves every other `fs/write` as it was.
- **Approvals** are records. "Always" turns into a policy.
- **Actor settings** are typed values systems declare and attach to actors, set by an admin or by a fn.
  For example, the database system declares row and field access rules; an admin sets them per group.

### Security

What the security review of 2026-11-21 changed (findings in `docs/plans/security-review-2026-11-21.md`):

- **Live events go only to the people they are for.** A browser subscribes to `on.user` as the person signed in, and
  the hub refuses anyone else's. Each event names who hears it: a notification its person, an approval its approvers
  and the turn's person, a session change the session's people, a pairing the admins (read from the database when it
  happens). `on.session` uses the same check as reading the session. Signing out, a replayed refresh token, a revoked
  sign-in or an admin turning someone off ends that sign-in's subscriptions at once.
- **Links built from data are http or https only.** `HttpUrl` in core is the one schema for URLs the browser opens
  (connect and SSO-test addresses, chat links, web sources), and `safeHref` in the SDK is the one check the app and
  system renderers use before a link, `window.open` or `location.assign`. `javascript:`, `data:`, `//host` and `/\host`
  are shown as plain text. ayepi's OAuth and OIDC metadata endpoints must be https (http only on loopback).
- **Outside images ask first.** A markdown image from another host shows a "Load image" button; images never send a
  referrer. The admin setting "Load outside images" (Settings › Hub, `outsideImages`, default `ask`) turns that off.
- **A system's client build loads only after approval.** `SystemLifecycle.approvedClient` is the one rule: the system
  is live and its current build was approved in review. `/clients`, the chat's renderers, pages and the settings page
  all use it; a build's `.html` and `.svg` are sent as downloads.
- **Agent fns always call as an agent actor**, made in one place (`ensureAgentActor`), never as the person who started
  them, so their tool calls get approval cards as any agent's do.
- **fs bash.** A "safe" command runs without asking only when it is a plain command (no `;`, `|`, `>`, `$`, `~`,
  globs or braces), every path in it resolves inside the roots, and its options fit a small table (no
  `git diff --output`, no `git branch -D`). Test runners and `echo` are no longer safe. Commands get a scrubbed env plus
  the names the fs config's `commandEnv` allows. Writes that lead to running code (`.git`, package manifests, configs,
  hooks, workflows) ask, case-insensitively on Windows and macOS. The hub's own git calls and typed safe git commands
  run with fsmonitor, hooks, pagers and external diffs turned off. Grep runs in a worker with a deadline, and
  snapshots are pruned (fs config `snapshots`, 20 per file and 500 MB by default).
- **The api system checks addresses.** Every request and the OpenAPI fetch, each redirect hop included, goes through
  the SDK's `addressVerdict`: private, loopback and link-local hosts are refused unless an admin turns on "Allow private
  addresses" for that service. A service an agent adds belongs to its person until an admin shares it, and only admins
  write the service records (`RecordStorage.writers: 'admins'`).
- **Headers.** Every hub response is `nosniff`, never framed (`frame-ancestors 'none'`) and sends only the origin as a
  referrer. The app page's policy allows scripts only from the hub (no inline scripts, no eval), inline styles, images
  from the hub, `data:`, `blob:` and https, and requests and sockets to the hub only. Uploaded files opened from their
  link never run script.
- **SSO hand-off.** The callback puts a one-time code in the URL, bound to the browser by an httpOnly cookie; the
  sign-in page swaps it for tokens once, within a minute.
- **First admin.** A hub with no one in it makes a setup code (logged as a link and written to `setup-code.txt` in
  its data folder); making the first admin needs it.
- **Rate limits** all use `@ayepi/rate` in the hub's database. Password tries count per (email, address) and per
  address, never per email alone (admin settings `signInLimits`, 10 and 100 per 15 minutes). An IPv6 address counts as
  its /64. `X-Forwarded-For` is read only when an admin says how many proxies are in front (`proxyTrust`, default 0);
  `api/client-address.ts` is the one place that works out where a request comes from.
- **Link limits.** Pairing requests count per address and in total, a repeated request from the same place replaces
  the open one, and a code pairing can't replace a paired key (that needs a token). Sockets that haven't finished the
  handshake are capped per address and in total and closed if they don't say hello in time; messages and uploads in
  progress are capped. These are env settings (`HARNESS_PAIRING_*`, `HARNESS_LINK_*`, `HARNESS_MAX_FRAME`,
  `HARNESS_WS_MAX_MESSAGE`). A fleet instance can act only on its own runs.
- **Other systems.** The claude system asks the person before a riskier mode, reads project `.claude` items as files,
  follows links before checking a folder and shows an MCP import's command on its card. The web system's Chrome goes
  through a proxy per tab that connects only to the address the guard checked, and read fetches list every URL they
  requested on the run. The database re-checks approval before a write. The test MCP server listens on 127.0.0.1. The
  CLI reads secrets from the env or stdin and refuses a hub address from the folder's `.env` with a sign-in from
  elsewhere.

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
- **Indexing:** the hub embeds fns, context and sections with an embedder (an embedding model of an offered
  provider, usually a system's) and searches them for suggestions, `get_fn`/`get_context`-style tools and `@` mentions.
  Each embed goes through the hub's AI pinned to that model, so it is priced and recorded like any model call, and a
  search's embed waits as interactive work. Catching up after an embedder comes back asks the database for just the
  rows whose vector is out of date. An embedder is taken up only once the hub's AI has its provider set up (a system
  going live offers it a moment before the AI is rebuilt). The catch-up embeds in small chunks
  (`HARNESS_INDEX_EMBED_BATCH`, one embed call each), saving each as it lands; a failed chunk halves the next ones and
  the rest is tried again after a doubling wait, back to full chunks once it gets through. Admins (and the scenario
  runner) read how far it has got with `indexStatus`: items waiting for a vector, running or retrying, the last failure.
- **Pictures** are indexed too when an image space is in use: image resources (from their bytes) and the http(s)
  images a context item's text shows (as children of the item). Images get a **second vector space** with its own model,
  an embedding model with aeye's `imageEmbedding`. A model whose text and image vectors share one space
  (`crossModalEmbedding`, like EmbeddingGemma v2) can serve both, and then there is one space and a text search finds
  pictures. The admin's one setting (Models page, Roles, "Pictures") is **off**, **same as text** (the default: one
  space when the text model is cross-modal, else no pictures) or **a model**. With no image space nothing about
  pictures is indexed and they are found by their captions only. A picture can be the query; in a separate space,
  pictures are searched by the query picture or, for a cross-modal model, by the query text, and merged with the text
  results by rank. Changing the space re-embeds the pictures there; a model that goes away and comes back keeps its
  vectors. Pictures over `HARNESS_INDEX_IMAGE_MAX` (5 MB) are skipped. Who may see a picture follows its resource or
  its context item.
- **Searching context** goes through the one hub search, the same one the model's `hub/ctx_search` (static mode's
  `find_ctx`) uses, as `hub/fns_search` (`find`) does for fns: by words and meaning
  when an embedder is up, by words alone when not. Each context item is indexed whole and by its heading sections, so
  a long item is found by the part that matches, and counts once at its best. The Context page's search uses it, with
  the page's filters (origin, tags, switched off, size, updated…) run as SQL in the same query, and its sorting and
  paging in the database. Each row found by text shows how well it fits, whether words, meaning or both found it, and
  the section that matched. A person only ever finds context they may see, private memory included. While text is
  searched the list is in best-match order unless the person picks a sort. A picked sort applies to the best 100
  matches, and the database sorts and pages them. The search box says whether it searches meaning as well as words,
  and changes as soon as an embedder comes or goes. A search hit's place in the order is its `rank`. "Score" means
  only a suggestion's similarity.
- **Niche material ranks last for ordinary requests.** A fn or context item may declare a **niche** (`niche` on its
  declaration): `developer` (the authoring guides, which the generator marks), `admin` (running the hub; a fn tagged
  `admin` is admin material without saying so) or `reference` (the API listings the catalog writes, whose fns are hits
  of their own). A search multiplies a niche hit's rank by `HARNESS_FN_SEARCH_NICHE_WEIGHT` (0.5) unless the query
  names its niche (`niches: ["developer"]`, for a search about writing a system), so a request to keep track of
  something finds `database/create_table` before `fs/authoring.*`; niche material is still found, and each hit says
  its niche. A model's search (`hub/fns_search`) never finds a fn whose visibility leaves the model out (`web/fetch_raw`,
  which the hub calls while importing a URL): it could never load it.
- **Search decisions** (Models page, "Search"): an admin may have the hits of a search filtered before they are
  returned, fns and context apart (`hubOptions` `fnsSearchDecision` and `contextSearchDecision`, or
  `hub/search_decision_set` in chat): **none** (the default, as ranked), a **decision model** (its own or the decide
  role's), which answers one yes/no question per hit, "does it fit what the search is for?", and keeps those at or
  over the decide role's threshold in their order, or an **LLM**, which reads the hits and answers which to keep, with
  reasons. What the search is for is its text and, inside a turn, the turn's latest user message. It applies to the
  one operation wherever it is asked (`hub/fns_search`, `hub/ctx_search`, the web's and the system link's `searchFns`), only to searches
  by text (not by name or for named items). The calls go through the one decider, each a model call (purpose
  `fns-search` or `context-search`) charged to the run that searched; the page lists what was dropped and why
  (`filtered`). If the model fails, every hit is kept and the page says so.

### Injected context (the declaration)

Design: `docs/plans/injected-context-2026-11-22.md` §4 and §6. The declaration, then the injected section the planner
builds from it (below); the admin's Injected tab is its own part.

- **A context item may declare `inject`** (`InjectDecl`: `into`, `order` default 100, `requires`, `mode`,
  `replaces`), in the contract (`context({ inject })`) or a context file's header (`inject: { into: ['hub/chat*'],
  order: 40 }`). It goes into the system prompts of the agents (`hub/llm` fns, saved ones included) it targets, once approved, unless an
  admin switches it off for an agent. `alwaysFor` is gone: the store migration turns a hub-made item's `alwaysFor` into
  `inject` with the same agents as exact names and drops a system's (it declares `inject` now): `store/always-for.ts`,
  a step of the one migration (`store/migrate-fn-names.ts`).
- **Targets** (`AgentTargetDecl`, matched only by core's `targetHits`): an agent's exact qualified name, or a pattern
  holding `*`. `*` alone is every agent; otherwise `system/local`, where each `*` is any run of characters on its own
  side of the `/`: it crosses `.` (`crm/*` takes a saved `crm/main.reviewer`), never `/`. Case counts; `**` is refused
  ("write one *"). In TypeScript one agent is named by its ref (`AgentRef`: only `hub/llm` fns carry `kind:
  'hub/llm'`), a string without `*` doesn't compile, and `agents.startingWith(hub.fns.chat)` / `agents.of(crm)` /
  `agents.all` build patterns from refs.
- **Checked at manifest time.** The catalog refuses an item whose exact target is no agent the hub has (stored, or
  declared in the same contract): "`crm/reviewr` is not an agent"; a pattern that hits no agent yet is accepted and
  logged (`catalog.inject.no-agent`), and its review card says "hits no agent yet". The SDK's context-folder check
  refuses an exact name that is no agent it knows (`KnownNames.agents`).
- **Replacing another item** (`replaces`, context refs in the SDK: `inject: { replaces: [hub.context.later] }`; a name
  as a string doesn't compile; absent on the wire when there are none, so older manifests hash the same). While the
  item goes into an agent's section, each item it replaces is left out of that section with the reason `replaced`
  ("replaced by Scheduled runs (schedule/basics), which says what is true instead"); when it is out (switched off, its
  system off or not in the chat, the other mode, its fns unusable) the replaced items are back. It is how a system
  makes a general hub statement untrue without hub text naming it: the hub's `later` item says "Nothing runs later by
  itself", and a system that runs fns later replaces it and restates what is still true. The hub's own items have
  refs in the SDK (`hub.context.<key>`, `HUB_CONTEXT_KEYS`, kept equal to `packages/hub/context/` by a test); the
  context-folder check follows a file's `inject.replaces` like its other links. Replacing is one pass over what goes
  in before any replacing (an item replaced by another still replaces what it names), and it is decided before the
  section is fitted, so a replacing item that later falls to a `<more_ctx>` line or `no-fit` still keeps what it
  replaces out.
- **Review.** A new, changed (text, summary, title, targets, order, mode, fns, replaces) or removed injection, and a
  hook's new or changed `explains`, raise the review flag `injects` ("Changes what hub/chat and hub/chat_small are
  told: + Forms (input/asking, 310 tokens)"; one that replaces items adds "takes hub/later out"), and each such
  change's card on the Pending tab lists its targets with the agents each hits now and what it takes out of their
  sections (`PendingReviewView.injections`, `injectionChanges`, `InjectionChangeView.replaces`).
- **Hub-made context** (a memory, context made from a resource) injects only when an admin sets it by hand
  (`guardReach`: `ADMIN_ONLY` for anyone else, `INJECT_BY_HAND` for any model's run, an admin's included).
- **An agent** says how it takes its section: `injected: { detail: 'full' | 'summary', maxTokens? } | 'none'`
  (`AgentInjected`, on `agent()` and the `hub/llm` payload). **A hook** says what its block means: `explains`.
- **What the catalog lists** (`catalog/injections.ts`): `agentNames` (every agent now), `listInjections` (each item's
  `ContextInjection`: its targets resolved to agents, the agents it reaches, review state `approved` / `pending` /
  `declined`, whether it is off or dynamic) and `listHookExplains`.

### The injected section (the planner)

The planner (`contextor/injected.ts`, called from `planner.ts`) puts what reaches an agent into its system prompt:

- **What reaches it** (`gatherInjected`): every item whose target hits the agent, and, for a session's own agent, each
  hook of the chat's systems that `explains` its block (heading "The `<fs_git>` block", keyed by the hook's name,
  order 100). Each is in, or left out with the first `INJECTION_LEFT_OUT` reason that applies: `pending`, `declined`,
  `off` (the admin's switch for this agent in `injectionSettings`, or the item's own switch), `system-off` (not
  installed, not in this chat, or off), `mode` (its `mode` is the other chat mode), `fns-unusable` (a fn in its `fns`
  or `requires` can't be used here: switched off, held, unseen, or beyond the chat's fn setting; `none` takes every
  item that names a fn out), then `replaced` (an item that goes in replaces it: `inject.replaces`, above). Another
  person's memory is skipped without a reason.
- **Order**: the admin's per-agent order, else the item's `inject.order`; ties by system, a context item before a
  hook's note, then key.
- **Text**: each item as `## <title>`, then its text at the agent's `injected.detail` (`full`: its content; `summary`:
  its summary, else its content), fn names rendered as the model calls them in this mode (`ModelFnNames.text`). It
  goes at `{{injectedContext}}` in the instructions (the hub fills it in raw, as `{{{injectedContext}}}`; nothing in it
  is read as a template), or straight after them. `injected: 'none'` gets no section. `hub/chat_small` takes
  `{ detail: 'summary', maxTokens: 600 }`.
- **Room**: the section is part of the fixed region and is counted in the budget's `fixed`. It may take the agent's
  `injected.maxTokens`, and at most `HARNESS_INJECTED_SHARE` (default 0.5) of what the model leaves after the
  instructions, the mode's guide and its tools: worked out from the model alone, never from the current message, so
  it is the same from turn to turn. Over that, items fall back from the highest order down: all to their summaries
  first, then to a line under `<more_ctx>` (loadable with `hub__ctx_load`; a hook's note has none), then out
  (`no-fit`). Every fallback is a `cut` entry of the selection report. So the small agent's cap holds however many
  systems add a chat item: `scripts/chat-prompt.test.ts` checks that the hub's own items fit it by themselves, that
  every chat item has a summary of its own (at most 220 characters, an eighth of the cap at most), and that with
  thirty more systems' items the section stays in the cap with every hub item still in it, at least as a line.
- **Starting tools**: the fns of each item shown (full or summary) join the agent's starting tools, through the
  chat's fn setting and the mode as the payload's `tools` do. A `<more_ctx>` line brings none.
- **Already loaded**: the shown items are in the prompt, so every contextor treats them as loaded (`ContextorInput
  .injected`): they are taken out of `always`, `loaded` and `asked`, never candidates for the graph contextor, never
  auto-injected or brought in as an import, and the enricher never suggests them or loads them for you. A
  `hub/ctx_search` hit for one says it is in the prompt (`inPrompt: 'injected'`), and a search decision that loads
  leaves it.
- **Caching** (`FixedRegionStamp`, `Session.fixed`): the section is worked out at a turn's first step and kept in
  memory (`HARNESS_INJECTED_STEPS` turns) for every later step of the turn, whatever changes meanwhile. At that first
  step the planner hashes the fixed region (the instructions with the section, then the `<systems>` list, the mode's
  guide and the citation rule) and compares it with the session's stamp: the same hash writes nothing; a different
  one rewrites the stamp (`hash`, the items in it, the turn), logs `contextor.fixed-rebuilt` and reports
  `injected.rebuilt` (the items added and dropped). A turn already stamped (the hub restarted mid-turn) keeps the items
  it was stamped with. So a system going off, an approval or an admin's switch costs one cache miss, at the next turn;
  the person's message still carries `<systems_changed>`. Previews and runs outside a chat keep nothing.
- **The run inspector** shows the section on the selection report (`SelectionReport.injected`): its tokens of the fixed
  part, each item at its detail, each item left out with why, and whether the region was rebuilt this turn.

### The admin's view of injected context

Phil: "an admin for any hub/llm fn instance they can see what is injected and also can toggle them off if desired".

- **Switches** (`injectionSettings`, `InjectionSetting`: agent, item, `on`, `order?`, `by`, `at`): an admin's switch and
  order for one item (a context item's key, or a hook's name for its `explains`) in one agent. Only rows that differ
  from the default exist: switching back on at the item's own order removes the row. The planner reads it.
- **Hub fns** (tagged `admin`): `hub/ctx_injections_list({ agent?, context?, mode?, fnMode? }) → InjectionsPage` (a
  read; asks nobody) and `hub/ctx_injection_set({ agent, context, on?, order? }) → InjectionView` (asks, as every admin
  change; `order: null` goes back to the item's own order; logs `injection.set` and publishes `capabilities.changed`).
  Web endpoints `injections` and `setInjection` (`injectionsSlice`, admins) run the same operations
  (`api/injections.ts`).
- **One implementation.** The list is the planner's own: `gatherInjected` (what reaches the agent, order, why left
  out) and `fitInjected` (detail, tokens, `<more_ctx>` lines, `no-fit`), fn names spelled by `modeNames` after
  `learn`, run for **a new chat with that agent** as the admin: every system on, the query's `fnMode` (default none
  set) and `mode` (default the agent's own). So a hook's `explains` shows on every agent, as it would for a chat's
  agent. Not known outside a turn: the model's window (room is the agent's cap) and, for an agent with no fixed model,
  its calibration (tokens at the default characters per token). An item listed only under `<more_ctx>` reads as
  `no-fit` with that said.
- **`InjectionView`**: agent, item, source (context or hook), system, `via` (the target that took it in; the agent
  itself for a hook), title, detail, text as the model reads it, tokens, order, `on`, `leftOut` (`INJECTION_LEFT_OUT`
  with the reason) and `switched` (who, when). `InjectionsPage` adds, for one item, its targets with the agents each
  hits now.
- **Web.** An agent's fn page and fn modal have tabs, About and **Injected** (`?tab=injected` on the page, `?fnTab=`
  in the modal; Open page keeps it): a total line ("3 of 4 items in · about 1,240 tokens", estimated outside any
  chat), then each item in order with its system as a pill, title, key (to the item's page), state badge, why it is
  left out, the target that took it in, tokens and detail, who last changed it, its text as markdown (collapsed), an
  "On for this agent" switch, earlier/later buttons, an order field and "Own order" (`admin/components/InjectedList.vue`,
  `admin/logic/injected.ts`, `admin/state/injected.ts`). A context item's page (admins) has an **Injected into** card:
  each target with the agents it hits as pills, then one row per agent with the same state, text and controls. The
  review card lists each target with its agents (`InjectTargets.vue`).

### Context as a graph

Context items link to other context, fns, types and resources with **weighted edges**. An item comes from a system
(skills, guides, `/commands`), is **memory** written by a person or an agent (`memory/…`, for a session, a person
or everyone), or is **made from a resource** (`resource/…`, one item per section, chained when long, live or a
snapshot). What an item declares becomes its edges: context it imports and fns it brings travel with it; suggested
fns, its parent, the next piece of a chain, related items and what it is about only spread weight. The hub also
finds edges in the text (mentions) and learns them from use (two things used in one turn), weaker than declared
ones and fading when unused. A person can draw edges in the context view. The graph contextor walks the edges, so
a skill's fns reach the prompt without the model asking.

**Crawling context.** `hub/ctx_crawl(keys, guidance, maxDepth, maxDecisions, maxTokens, metadataOnly)` walks the
graph level by level with a decision model. Level 0 is the starting keys and everything they import. At each later
level, every `choices` link from what the last level took, to an item not taken yet, becomes one yes/no question
("Load X when: <condition>?"), with the guidance as the input. Only choices are conditional: imports always come along,
transitively, all or nothing with the item that imports them. A level's questions go out in calls of at most 256 (fewer
when the model's `maxQuestions` says so), each a recorded model call charged to the crawl's run. Answers at or above the
decide role's threshold are taken highest first while they fit `maxTokens`. The crawl stops when nothing is left
(`complete`), at `max-depth`, `max-decisions` or `max-tokens`, or `failed` when a decide call fails (what was taken is
kept); a cancelled run just ends. It loads what it took into the session as `ctx_load` does and returns it with its
content, or with `metadataOnly` loads nothing and returns keys, titles, sizes and why each was taken; skipped items are
listed with why. The model reads the result as XML cards. The fn is unavailable (`role-unset`) until the decide role
has a model, and comes on when an admin sets one.

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

**Its searches and reads are reads** (Phil, 2026-11-22: "Go with your recommendations"). `web/search`, `web/read` and
`web/crawl` keep what they fetch as hub resources through `hub/resource_import`, which is a write. Keeping what was read
changes nothing the person owns, so the fns declare it as a fact, `effects: { mode: 'read', keeps: ['resources'] }`
(`FnEffects.keeps`): when a fn's facts are worked out, creating a thing it keeps (its own registry effect, or a fn it
uses whose only change is that creation and which writes no types) does not raise its mode. The creation is still
listed in its facts' `registry`, so the auto classifier and reviews see it. Anything else still folds in: a fn that keeps
resources and also removes one is a delete. So read-only searches (`modes: ["read"]`) and chats in `read` mode use them.
Approvals are unchanged: the fns are tagged `read`, and a system's call of `hub/resource_import` (tagged `own`) is
allowed as before.

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

Done for the 2026-11-18 to-do batch: **ayepi auth** an OAuth 2 / OpenID Connect client (`@ayepi/auth/oauth`:
discovery, PKCE, JWKS id-token checks, userinfo), which MCP's sign-in shares; **ayepi core** `withJsonSchema` and
merged schema helpers; **aeye** `@aeye/ollama` with System One decisions, decision images and limits, multimodal
embeddings; **aeye resources** markdown image links typed as images.

Still open:

- **ayepi core: binary frames** (MessagePack or CBOR) for the ws protocol.
- **ayepi sqlite: a `FileStore` over SQLite**, for keeping raw content in the database (the hub has its own until then).
- **ayepi mcp: server progress notifications.**
- **aeye core:** `forget` counting tool definitions; a provider hook for the served context window.
- **aeye ollama: pulling and removing models.** `OllamaApi` reads `/api/tags`, `/api/show` and `/api/version`; the
  Ollama system adds `POST /api/pull` (its NDJSON progress) and `DELETE /api/delete` in `systems/ollama/server/api.ts`
  until `OllamaApi` has `pull` and `delete`, and parses `/api/tags`' sizes and details itself (`OllamaTags` types only
  the names).
- **aeye ai: one count of a decision request's bytes** (say `decisionRequestBytes(request)`), so the hub splits by
  the same count the provider checks. The hub estimates it today.
- **ayepi auth: an authorization request without PKCE.** `authorizationUrl` and `exchangeCode` always use PKCE, and
  google-calendar's connect start and finish have nowhere to keep a verifier between them, so its connection stays on
  its own OAuth calls until the library has the option (or the system gets a pending store).

## Later

- **Database system:** query tool, saved queries, custom types, row- and field-level rules as
  expressions, mapping a hub user to a database user (required or not), and public or private types. The
  admin sets this up and can change it through fns.
- **MCP bridge system** and **Claude Code system** (described above).
- **Trigger fns** (runs started by events). Scheduled fns are the schedule system (above).
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
    - The hub has one fns/context search endpoint, available on the web API, the system link and as two LLM fns:
      `hub/fns_search` finds fns only and `hub/ctx_search` context only (fns do things; context holds information). It
      does text and semantic search, can order by score, filters by kind, system, instance, visibility, types and
      mode (fns) or origin, a memory's scope and tags (context), and pages its results. The model's `kinds` filter is
      for a person who asks for a kind by name: a search by what a fn does finds every kind.
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
      and `fns_examples` pages through the rest.
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
    through `ctx_load`, so a small model can walk a large choose-your-own-adventure graph. The API is organised the
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
  - **Installed is not live:**
    - **Installed:** a system is connected but offers nothing.
    - **Going live:** an admin reviews everything it declares (fns with facts and effects, context, types, resources,
      components, capabilities, tests, scan), configures it, turns items off and presses "Go live". That saves the
      reviewed contract.
    - **Later changes:** anything outside what was reviewed waits for review with a diff, and each change can be
      approved or declined on its own (2026-11-18).
    - **Enforcement:** the hub enforces every declaration over the link (effects, mode, types, hub capabilities,
      models and spend, secrets, fns it calls, network and files for supervised systems) and logs every refusal.
    - **Configuration:** systems can ship their own Vue configuration component. The hub still validates with the gin
      type.
  - **Graphs:**
    - Each system page has a graph of everything the system contains: fns, context, types, kinds, resources,
      components and the rest, with the relations between them. References into other systems are greyed.
    - Hovering a node or an edge explains it.
    - A global graph shows all systems, with filters on node and edge kinds. One hub endpoint and one hub fn serve both.
      (2026-11-18: the global graph is an admin page searched like every other list; see **What the UI offers**.)
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
- **Auth:** generic OpenID Connect sign-in, with the bootstrap admin's password as the break-glass login (see
  **Actors and permissions**).
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
  shown calmly as "Thinking harder"; `failed` is a real failure.
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
  the args against the fn's type, so args that don't fit become an `invalid-input` run the chat shows as "Thinking harder"
  and the fn's metrics count. Args that aren't JSON at all are retried inside aeye, before any run exists.
- **Fleets in the chat** (build 2 integration): in tools mode a fn whose system has several connected instances gets
  an optional `on` choice in its tool schema; the static toolset's `run` takes `on`. Both are taken out of the args and
  given to the run as its instance; a call that names none and has no other pick is refused as invalid input naming
  the machines.
- **Every embedding is a model call** (build 2 integration): the index's calls to an embedder system are `ModelCall`
  records (provider the system, model the embedder, purpose `index` or `search`), like calls through a provider.
  Since 2026-11-19 they go through the hub's AI like every other embed, so its pricing and live model listing apply.
- **Common formats out of the box** (build 2 integration): the hub and fs install `@aeye/resources`' optional parsers
  (`xlsx`, `pdf-parse`, `mammoth`, `jszip`, `js-yaml`), so workbooks become tables, pdfs pages and docx markdown.
- **Reading a web page asks first** (build 2 integration): `web/read` imports through `hub/resource_import`, which is
  a write, so a person approves it unless a policy allows it.
- **Dynamic context is written when it is used** (build 2 review): an item declared without `content` (`fs/tree`,
  `/new-system`) gets its text from its system's `context` endpoint, as the person and with the `/command`'s args,
  whenever a prompt shows it whole (commanded, loaded, always, or a graph pick of those), `hub/inspect` shows it or
  `hub/ctx_get` reads it. The hub keeps each text a while (`HARNESS_DYNAMIC_CONTEXT_TTL`) per session and person,
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
- **The hub's name is the owner's to choose** (2026-11-12, for build 8): "Let's make it configurable so that you can
  feed in a custom harness name (right now it's just Harness) and have that be used visually everywhere in the app."
  Every place the app shows the product name shows the configured one; code names stay `harness`.
- **Sign-in remembers** (2026-11-12): "The login screen doesn't ask to remember my username and password - also add
  password visibility toggle. Update so browser can remember or they can click remember me." Done in `9b49d1b`.
- **Audit gate calls** (2026-11-12): "1. Move into settings 2. Yes 3. Do suggested". Context metric defaults move into
  env settings; esbuild is a root devDependency; a system searches resources for a mention only as the person the
  hub's own mention request named.
- **Widgets follow product's plan, drawn with ECharts** (2026-11-12): "Have it use apache echarts and try to do every
  type. Look at the products widget plan I have it - thats what I want with this widget system." The owner's 39
  answers (questionme set `widgets`) are verbatim in `docs/plans/build-8-feedback.md`. In short: everything in
  product's plan except dashboards; widgets are a bundled `widgets` system, not a hub kind; every ECharts series
  that draws from rows and columns, in about 12 families with styles; the database system's own visuals go; systems
  may bundle their own ECharts charts; a write's form is followed by a confirm; the agent proposes a widget and the
  person saves it; the Data page's tables use the widget view.
- **Functional testing is ours; the fn modal** (2026-11-13): "I need you to have unit tests around these things so I
  don't hit these during my testing which should be more about ux and not functional since I've communicated
  functional to you. Use luna gpt 6 for testing since I exhausted free calls. Don't run a test more than once unless
  you're doing a final test across them all after you handle each individually. In system page when I click on a fn
  it expands - I think a modal should open up - ... fn modal and page should share same stuff since I asked that the
  chat open a modal and not take the user away from where they are." Full note in `docs/plans/build-9-feedback.md`.
- **Fn signatures are strict gin tool calls** (2026-11-13): "The fns signature should be using gin to convert it to a
  strict tool call with zod etc and all the work I did in aeye. Please report back why it had a tool call problem".
  A fn arg that holds a gin type is gin's `typ<T>`, whose value schema is aeye's strict TypeDef schema
  (`buildSchemas`), so the tool JSON schema and the hub's arg check both carry the shape. No LLM-visible arg position
  is an empty schema unless it is on an explicit, reasoned allow-list (tested). Handlers take gin's one shape; they don't
  reinterpret other shapes. Full note in `docs/plans/build-9-feedback.md`.
- **Chat describes queries; the authoring agent writes them** (2026-11-13): "Yes fix both, but to be clear normal chat
  agent shouldn't be able to specify query object, only text descriptions for editing and creating given the json can
  be very complex and there can be tons of tables and that's why product has progressive disclosure for all that".
  The chat agent creates and edits saved queries by describing them in words; only the query-authoring agent, which
  discloses tables progressively, writes query JSON. The policy/MCP-rule `when` becomes a typed gin expression.
- **aeye handles any schema** (2026-11-14): "the schema files and prompt clas in aeye core should handle that behavior
  already. Make sure the right schema rules are being applied because there should be no error.  But also see if the
  schema can be made smaller by just changing which types are named and ref'd. I am interested in you fixing it because
  aeye is suppose to handle anything for the dev". A schema that fails at the provider is an aeye bug, fixed in aeye;
  gin's TypeDef schema is shrunk by what is named and referenced. Full note in `docs/plans/build-9-feedback.md`.
- **Authoring works live; what the LLM is sent is accurate** (2026-11-14): "Yeah let's update gin to support that. And
  figure out further why any make API or code call falls and fix it. Whether it's missing or incorrect examples or docs
  in the prompt.... Make sure what's sent to the llm is accurate". gin's strict `new` takes plain values in primitive
  and enum slots; make_api / make_code failures are fixed at their cause; prompts, examples, docs and schemas match the
  code. Full note in `docs/plans/build-9-feedback.md`.
- **Published libraries on the owner's signal; the session orchestrates** (2026-11-14): "Fyi I had another agent make
  the ayepi and aeye repos publish on commit I know we're working with local copies but once everything is done and
  tested we should switch to live libraries and that flow when I give the signal / Just pass my requests and the
  context you have that's need to agents and you orchestrate from now on". harness stays on the local linked branches
  until the signal, then moves to the published packages; work is done by agents the session briefs and reviews.
- **Widget chrome shows the data context; the rest is in a hover menu** (2026-11-14): "Let's update the look of the
  widgets so that what you see by default is only stuff that when you're thinking about what data am I looking at, it
  helps tell you. So it would be something like the filters, stuff like that is what would be visible. And then if the
  settings has a subset of the valid widgets that the user agent has pre-selected, those would be in a little toggle.
  But a lot of the other icons and toggles that you have at the top of widgets right now, it's a whole lot going on. So
  let's put it in a 3-dot menu that is in the top right and only shows up on widget hover. And we should be able to, if
  supported, export image or export as JSON or CSV. And full screen a widget. And the settings just to change it
  visually and to save it." Full note in `docs/plans/build-9-feedback.md`.
- **Every widget drills down through the query** (2026-11-14): "Also was drill downs implemented? There's a
  drilldownify and and maybe paginate or something functions that take a gin query and make them safe to use for
  widgets so all can support pagination and drilldowns. If the query doesn't support drilldowns it throws an error or
  something. So every widget if I click on a part of it that basically represents a group and should be sent to a
  drilldownify query which flattens a query to produce the rows that made that group - in turn another widget could be
  displayed in a modal. Default to table." Full note in `docs/plans/build-9-feedback.md`.
- **Widget labels are human-friendly; no false empty state** (2026-11-14): "For widgets let's have a rule where all
  labels (like fields) are passed through a human friendly function to convert id to ID and title to Title and due_date
  to Due date etc. the title attribute for those things can have the original value of the person is curious. / I saw
  task in data tab and it says 128 rows but when I click on it it says no records yet. Either there are and we
  shouldn't show that message until we know for sure or a loading visual". Full note in
  `docs/plans/build-9-feedback.md`.
- **No data types beside field names** (2026-11-14): "Hmm let's remove data type from the table columns or anywhere
  else, not particularly useful for user but you could add that info to tooltip". Full note in
  `docs/plans/build-9-feedback.md`.
- **To-do batch decisions** (2026-11-18): Phil answered 60 questions in hitloop set `todo-2026-11-18`. Highlights:
  - unavailable fns always carry their reason to the model
  - Retry is a true redo, and Continue resumes the same run
  - loops are handled by a system prompt rule only
  - systems own their pages (`/s/<system>/<page>`, Claude and widgets now)
  - api is single instance. Phil (2026-11-19): "API system is like code in that it authors API fns which is code that calls an external service, etc. I hope that's clear, not sure why there was confusion in what the API system does". So api is one instance whose authored fns each call an external service; services are not instances.
  - one XML card format for fns and context, and never suggest the same fn or context twice
  - the suggestions setting is a decision model, an LLM, or none
  - `ModelInfo.maxQuestions` is respected by callers
  - ctx_crawl returns content or metadata only by a flag, with its threshold on the decide role
  - SSO is generic OIDC, configured by env vars, with first sign-in set by the admin

  Full list in `docs/plans/todo-2026-11-18.md` § Phil's decisions.
- **Decisions, crawl and pictures** (to-do phase 5, 2026-11-19): built as Phil decided.
  - Embedders fold into system-provided aeye providers. A system provider's models are its live `listModels`, limited
    to the declared (reviewed) set.
  - Ollama is aeye's `@aeye/ollama`, and harness's own copy is gone. Decide detection comes from `/api/show`, else
    the provider's admin list.
  - aeye refuses a decide call over `ModelInfo.maxQuestions` or `maxRequestBytes` and never splits it; the hub's
    decider splits by both, and a suggestion record keeps every call.
  - The `decide` role has the yes threshold.
  - Suggestions are picked by a decision model or an LLM, or there are none (nothing is suggested: no fns, no
    context); the old on/off setting reads as LLM or none.
  - A system declares embedders only as providers' embedding models: the old `embedders` section, `embedder()` and
    the link's `embed` are gone, and the SDK refuses a contract or implementation that still has them.
  - `hub/ctx_crawl` stays unavailable until the decide role is set.
  - aeye's `EmbeddingRequest.inputs` takes text and `{image}`, with `imageEmbedding` and `crossModalEmbedding`
    capabilities. Pictures get a second vector space, or share the text space when one model serves both.
- **SSO** (to-do phase 6, 2026-11-19): built as Phil decided.
  - Generic OIDC only, providers from `HARNESS_SSO_PROVIDERS` (a JSON list in the env; `.env.example` documents it),
    shown read-only in Admin › People › Sign-in with Check (discovery and key set reachable) and Test sign-in (a real
    provider sign-in that signs nobody in and shows the claims and what a sign-in would do).
  - First sign-in is the admin's `SignInPolicy` (default invite only); new accounts need a verified email.
  - Linking: an `ExternalIdentity` (issuer, sub), else a matching email only when `email_verified` is true; an
    unverified email someone here already has is refused, never joined.
  - Roles and groups from claims (`SsoClaimMap`: role claim with admin and member values, groups claim), re-synced at
    every sign-in; the break-glass admin always stays an admin.
  - Passwords: once a provider is configured, only the bootstrap admin (the first account with a password) keeps one.
  - All of OpenID Connect is `@ayepi/auth/oauth`; harness keeps only the linking, policy, routes and pages.
  - Member-facing pass: Settings › Account shows how a person signs in and their groups.
- **A/B compare** (to-do phase 6, 2026-11-19): built as Phil decided. Up to 4 variants, any session setting (system
  prompt included), each variant in a hidden fork with an even share of the turn's budget reserved up front, and every
  write in a variant approved by the person for that variant (never remembered as a policy).
- **To-do follow-ups** (2026-11-19, hitloop `todo-2026-11-19-followups`): built as Phil decided.
  - SSO origin: "Redirect to HARNESS_URL before starting sign-in". A start reached at another host (the request's
    `Host`, or a proxy's first `X-Forwarded-Host`) redirects to the same start on `HARNESS_URL` with `next` kept and
    a `relocated` flag, so a proxy that hides the host can't cause a loop. The person finishes on `HARNESS_URL`.
  - A/B undo before choosing: "Keep effects, but list them in the undo notice". Undo reverts none of the variants'
    runs; the report's `kept` and the note list each variant's writes.
  - Claude Stop: "Stop interrupts at once; panel via long-press/menu". Only system pages' composers work this way;
    the chat's Stop still opens the panel.
  - api fn with no connection: "Check the connection before asking approval". The run start reads the one key
    record and refuses the call `not-connected` (class `caller`) with the link in its data. The api system's own
    `not-connected` failure still covers a token set for an older base URL.
- **Phase 5 follow-ups** (2026-11-19): "No suggestions" means nothing is suggested (no score-only fallback); embedders
  exist only as providers' embedding models, and the index embeds through the hub's AI; `backfill()` filters in the
  database; decide calls split by `maxRequestBytes` as well as `maxQuestions`; markdown image links come from
  `@aeye/resources` as `targetType: "image"`.
- **ayepi follow-ups** (2026-11-19): gin's wire schemas are gin's own JSON Schema, supplied through `@ayepi/core`'s
  `withJsonSchema`; identical schema helpers merge into one component; MCP tool inputs use core's conversion; Ajv
  2020 strict checks run in ayepi's tests.
- **Security review** (2026-11-21, hitloop `security-2026-11-21`, report docs/plans/security-review-2026-11-21.md):
  all seven high findings fixed as recommended (events scoped per person, http(s)-only URLs in schemas and UI, system
  client builds load only after approval, agent fns always call as an agent actor, bash safe list confined to the
  roots with a scrubbed env, writes that lead to execution ask and internal git is hardened, the api system uses the
  address guard with admin-only private hosts). Phil: "For outside images and other things that could be conditional
  have admin setting. For rate limiting use ayepi/rate". Outgoing fetches from read fns are logged on the run, not
  asked about.
- **Parallel claims** (2026-11-21). Phil: "Let's enhance aeye (aits) and then harness so a tool can statically or
  dynamically with the ctx and tool args specify parallelClaims so during parallel tool execution if tools operate on
  the same things they aren't ran in parallel and they are executed sequentially. So basically parallel tool calling
  can be safe but also be sequential depending on the circumstances of the tool call. Then after that well tested added
  that functionality to fns in harness." aeye owns the rule (`claimWaits`); the hub's agent loop applies it to the
  child runs of each iteration (**Parallel claims** under **Fns**). Static claims use the status words' `{args.x}`
  tokens, checked against the args at compile time; a system that can't answer for its dynamic claims makes the call
  run alone; held calls a stopped agent no longer waits for are skipped, never started later.
- **Ollama system** (2026-11-23, hitloop `todo-2026-11-23`). Phil: "Actually installs and runs ollama and can get
  models listed and installed etc." and "An admin offers, a person picks per chat". The system runs Ollama per
  instance and offers an admin's chosen models as a runtime provider named after the instance; the hub's built-in
  Ollama provider stays for servers it doesn't manage (**The Ollama system** under **LLM calls and budgets**).
