# The hub's surface

> **Snapshot of commit `20d43144f9ac293120a0b3a02fa7c6878432fd36`** ("Record review notes: context brings and names
> its fns; install systems from chat", 2026-11-10). The working tree was being edited while this was written, so
> everything here is read from `git show HEAD:<path>`, not from the files on disk. Paths and line numbers are at that
> commit.

Four parts:

1. [What a system can call on the hub](#1-what-a-system-can-call-on-the-hub) (the system link), and what the hub
   calls on a system.
2. [The hub's own fns the chat model can see](#2-the-hubs-own-fns).
3. [The web API](#3-web-api-browser) (browser).
4. [Where it departs from the design](#4-where-it-departs-from-the-design).

---

## 1. What a system can call on the hub

The link is one WebSocket per system process (`/link`). Both directions are ayepi request/response. The spec is
`packages/core/src/link.ts`:

- `hubLinkSpec` (link.ts:266) is what a system calls on the hub.
- `systemLinkSpec` (link.ts:285) is what the hub calls on a system.

Every endpoint has a short `ws` id. Large content never rides in a frame: it moves as a `ContentRef`, in chunks.

**Who may call.** `hello`, `prove` and `pairingInfo` are open (the handshake). Every other endpoint runs behind the
`linkSession` guard, which refuses a socket that hasn't finished the handshake (`packages/hub/src/link/handlers.ts:104`).
Inside the guard, most endpoints that name a run check that the run belongs to the calling system. The table says
which ones do.

**Who serves it.** Each hub module serves its own slice:

| Module | Endpoints | File |
| --- | --- | --- |
| link | hello, prove, pairingInfo, manifest, patch, resourcesChanged, resource, embed, log, fleet | `hub/src/link/handlers.ts` |
| link services | upload, content, stateGet, stateSet, setting, attach, types | `hub/src/link/services.ts` |
| execution | call, handle, control, progress, allow, undoWith, llm, propose | `hub/src/execution/link-handlers.ts` |
| models | model | `hub/src/models/create.ts:36` |
| chat | decide | `hub/src/boot/modules.ts:128` |
| access | shareFn, usableFns | `hub/src/access/create.ts:24` |
| connections | connectionUpdate | `hub/src/connections/create.ts:22` |

### 1.1 Handshake and pairing

| Endpoint (ws) | What it does | Body | Returns | SDK |
| --- | --- | --- | --- | --- |
| `hello` (`hi`) | First call. A known key gets a nonce to sign. An unknown name or key starts pairing, unless it brings a valid auto-pair secret. | `protocol: 1`, `name: SystemName`, `version: string`, `instance: InstanceName` (default `main`), `boot: string` (new on every process start), `publicKey: string` (Ed25519 SPKI, base64), `manifestHash: string`, `pairingToken?: string`, `autoPair?: AutoPairProof` | `{kind:'challenge', nonce}` or `{kind:'pairing', pairing, code?, url, expiresAt}` | `LinkHost` on connect (`sdk/src/server/host.ts:387`) |
| `prove` (`pr`) | Checks the signature over the nonce and makes the socket that instance's connection. | `signature: string` | `Welcome`: `instance`, `config?` (`{value, version}`, secret fields in plain text), `start: {first, upgradedFrom?}`, `token` (short-lived HTTP token), `sendManifest: boolean`, `limits: {maxFrame, maxChunk, heartbeat}`, `autoPair?` (new or rotated secret) | host.ts:411 |
| `pairingInfo` (`pi`) | While pairing waits, tells the pairing page about the system so the admin can set config as they approve. Only the socket that started the pairing may send it. | `pairing`, `description`, `instance`, `configType?: GinTypeDef`, `configSecrets?: string[]` (dot paths) | nothing | host.ts:545 |

### 1.2 Contract (manifest, runtime adds and removes)

| Endpoint (ws) | What it does | Body | Returns | Who | SDK |
| --- | --- | --- | --- | --- | --- |
| `manifest` (`mf`) | Sends the whole contract. The hub imports it into the catalog. | `Manifest`: `name`, `version`, `description`, `hash`, the 11 sections (`types`, `settings`, `attachments`, `kinds`, `fns`, `context`, `hooks`, `mentions`, `embedders`, `sectioners`, `actions`), `events`, `resources: boolean`, `client?`, `config: GinTypeDef`, `requires`, `providers?`, `connect?`, `registries?`, `contributes?`, `configSecrets?` | `ImportReport`: `added`, `updated`, `removed`, `refused: [{name, problems}]` | Refused unless `name` is the linked system | host.ts:453, after `Welcome.sendManifest` |
| `patch` (`mp`) | A runtime change to the contract: entries to add or replace, and names to remove, in any of the 11 sections. The hub folds it into the stored manifest and re-imports. | `hash: string`, `upsert: {<section>?: Decl[]}`, `remove: {<section>?: LocalName[]}` | `ImportReport` | Linked system; refused if no manifest was imported yet | `RunningSystem.add(name, def, impl?)`, `.remove(fnRef)` (fns only), `.types(upsert, remove)` (`sdk/src/server/index.ts:64-73`) |

`patch` cannot change the top-level manifest fields (`providers`, `registries`, `contributes`, `connect`, `events`,
`resources`, `config`). The SDK only offers it for fns and types (see [4.2](#42-anything-a-contract-declares-can-also-be-added-at-runtime)).

### 1.3 Runs: calls, progress, control

| Endpoint (ws) | What it does | Body | Returns | Who | SDK |
| --- | --- | --- | --- | --- | --- |
| `call` (`call`) | Calls a fn from inside a run. It is queued like every run, and the reply comes when the run settles or moves to the background. | `parent: RunId`, `fn: QualifiedName`, `args: Json`, `key: string` (names the call within the run, so a resumed run gets the result back), `budget?: {cost?, time?}`, `handlers: string[]` (optional handlers the caller answers), `background: boolean`, `on?: InstanceName` (fleet instance) | `RunSettled`: `done {result}` / `failed {error}` / `cancelled` / `background {run}` | `parent` must be the system's own, unsettled run | `ctx.fns.<dep>(args, {key, budget, background, handlers, on})` returns a `FnCall` |
| `handle` (`ha`) | A run calls one of its caller's handlers. The hub relays it to whoever answers (a system over `handler`, or a person in chat). | `run`, `handler: string`, `args: Json` | `HandlerAnswer`: `{ok:true, value}` or `{ok:false, error}` | Own run | `ctx.handlers.<name>(args)` |
| `control` (`cl`) | Cancels or pauses a child run this system called. | `run`, `action: 'cancel' \| 'pause'` | `{accepted, reason?}` | The run's parent must be the system's own | `FnCall.cancel()`, `FnCall.pause()` |
| `progress` (`pg`) | Reports progress. | `run`, `progress`: `{fraction 0..1, message?}` or `{step, status, detail?}` | nothing | Own run | `ctx.progress` |
| `allow` (`al`) | Narrows what can be done to the run right now. | `run`, `operations: {cancel?, pause?, background?}` | nothing | Own run | `ctx.allow(ops)` |
| `undoWith` (`uw`) | Records the undo payload. The last one wins. | `run`, `undo: Json` | nothing | Own run | `ctx.undoWith(payload)` |
| `propose` (`po`) | Adds a run of one of the system's own fns that waits for approval, with a preview. | `fn: LocalName`, `args`, `key` (makes a retry the same run), `parent?: RunId`, `approver: 'person' \| 'admins'` (`admins` is required when there is no parent), `preview: ApprovalPreview` | `{run, approval}` | Own fn; `parent` must be the system's own | `ctx.propose(fnRef \| localName, args, {preview, approver?, key?})`, in runs and in `SystemCtx` |

What a run reports through its outcome rather than a call: result, error, cost, undo, resume state and `expose`
(`ctx.done/fail/pause/cancelled/invalid/expose`, carried by `OutcomeWire`). `ctx.budget.spend(cost, what)` only adds
to a local counter and logs it. No link endpoint tells the hub (`sdk/src/server/run.ts:425`).

### 1.4 Run services: attachments, settings, session state

| Endpoint (ws) | What it does | Body | Returns | Who | SDK |
| --- | --- | --- | --- | --- | --- |
| `attach` (`at`) | Attaches something to the run's assistant message: a system attachment (its data is checked against the attachment's declared type) or a link. | `run`, `item`: `{attachment: QualifiedName, data: Json, title}` or `{link: Link}` | nothing | Own run | `ctx.attach(ref, data, title)`, `ctx.link(link)` |
| `setting` (`st`) | The value of an actor setting for the run's user: theirs, else their first group's. | `run`, `setting: QualifiedName` | `{value?}` | Own run | `ctx.setting(ref)` |
| `stateGet` (`sg`) | Reads session state. Only the fields the fn or action declared are visible. | `owner`: `{run}` or `{delivery}` | `{values, version}` | Own run, or a delivery to this system | `ctx.state.get()` |
| `stateSet` (`ss`) | Writes session state. Refused as a conflict if another write came in after `version`; the SDK retries. | `owner`, `patch: JsonObject`, `clear: string[]`, `version?` | `{version}` or `{conflict: true}` | as `stateGet` | `ctx.state.set/update/clear` |

### 1.5 Types

| Endpoint (ws) | What it does | Body | Returns | Who | SDK |
| --- | --- | --- | --- | --- | --- |
| `types` (`ty`) | Named type definitions any system declared, with every named type they reference, dependencies first. | `names: QualifiedName[]` (at least one) | `{types: TypeRecord[], missing: QualifiedName[]}` | Any linked system; no run, no visibility check | `ctx.types.definitions(names)` |

Adding and removing types goes through `patch` ([1.2](#12-contract-manifest-runtime-adds-and-removes)).

### 1.6 Models and LLM

| Endpoint (ws) | What it does | Body | Returns | Who | SDK |
| --- | --- | --- | --- | --- | --- |
| `llm` (`llm`, stream) | Chat-model calls, budgeted and recorded against the run. | `run?: RunId`, `request: LlmRequest`, `model?: ModelChoice`, `stream: boolean` | a stream of `LlmForwardChunk` (`descriptors`, `chunk`, `done {usage, cost, interaction, model}`, `error`) | Needs a run of this system that hasn't settled; without one the reply is an error chunk (`execution/gateway.ts:160`) | `ctx.llm.text/object/stream`, and aeye's `HarnessProvider` |
| `model` (`mdl`) | Every other modality: embeddings, images, transcription, speech. Each is one `ModelCall`. | one of `{modality:'embed', texts, model?}`, `{modality:'image', prompt, model?, size?, count?}`, `{modality:'transcribe', audio: ContentRef, model?, language?}`, `{modality:'speech', text, model?, voice?, format?}`; plus `run?` | the matching result (`vectors` / `images: ContentRef[]` / `text, segments?` / `audio: ContentRef`) plus `call`, `cost`, `model` | The gateway is given the system and the run | `ctx.llm.embed/image/transcribe/speak` |
| `embed` (`em`) | Embeds with the index's document embedder, priced at its declared rate. | `texts: string[]`, `run?: RunId` | `{vectors, cost}` | Any linked system. `run` is ignored and no `ModelCall` is recorded (`hub/src/index/embedding.ts:25`). | Not used by the SDK; `ctx.llm.embed` goes over `model` |
| `decide` (`de`) | Asks the admin's decision model to choose between candidates. | `run`, `question`, `candidates: DecideCandidate[]` (1 to 50), `max` (1 to 20) | `{by:'decision', picked:[{id, why?}], note?, call?}` or `{by:'off'}` or `{by:'failed', message}` | Own run (charged to it) | `ctx.decide(question, candidates, {max})`, in runs only |

### 1.7 Resources and content

| Endpoint (ws) | What it does | Body | Returns | Who | SDK |
| --- | --- | --- | --- | --- | --- |
| `resource` (`rs`) | Reads a resource. The hub routes the URI to the system whose root contains it. | `uri`, `want: ('links'\|'text'\|'bytes')[]`, `run?` | `ResourceRead`: `stat`, `links?`, `text?` (inline or a ref), `bytes?` | Any linked system. `run` is ignored and no visibility check is made (`link/handlers.ts:135`, `link/resources.ts:105`). | `ctx.resources.stat/text/links`. `text(uri, sections)`, `sections()` and `search()` throw `LinkGap` (`sdk/src/server/resources.ts:33,47,51`). |
| `resourcesChanged` (`rc`) | Reports changes under the system's watched roots. Changes outside its own roots are dropped. | `changes: [{uri, change: 'added'\|'changed'\|'removed', version?}]` | nothing | Linked system | Sent by the runtime when the hub's `watch` is on |
| `content` (`ct`) | Reads a slice of stored content, base64. | `ref: ContentRef`, `offset`, `length` | `{chunk}` | Any linked system, any ref | Content downloads (long resource text) |
| `upload` (`up`) | Uploads content in base64 chunks. The last chunk returns the ref. | `upload: string` (id), `chunk`, `last: boolean`, `mime` | `{ref?}` | Linked system; size-capped, expires | `ctx.files.share(path)` |

### 1.8 Access and per-person connections

| Endpoint (ws) | What it does | Body | Returns | Who | SDK |
| --- | --- | --- | --- | --- | --- |
| `shareFn` (`sh`) | Gives a fn of this system to the run's person, with who else may use it. | `run`, `fn: LocalName`, `share: ShareRule` | nothing | Own run that is still going; refused if someone else owns the fn | `ctx.shareFn(fn, share)` |
| `usableFns` (`uf`) | Which of the named fns of this system the run's person may use now. | `run`, `fns: LocalName[]` (up to 1000) | `{fns}` | Own run that is still going | `ctx.usableFns(fns)` |
| `connectionUpdate` (`cu`) | Hands the hub refreshed credentials for a person's connection, or says it expired. | `connection: ConnectionId`, `update`: `{credentials, expiresAt?}` or `{expired: string}` | nothing | Linked system | `ctx.updateConnection(update)` |

### 1.9 Fleet, logs

| Endpoint (ws) | What it does | Body | Returns | Who | SDK |
| --- | --- | --- | --- | --- | --- |
| `fleet` (`fl`) | Every paired instance of the calling system, with its config (secrets masked) and its own types. | `{}` | `[{instance, description, online, config, types: [{name, description}]}]` | Own system | `ctx.fleet()` |
| `log` (`lg`) | Forwards a log line to the hub's log and the admin's output view. | `level`, `key`, `fields` | nothing | Linked system | `ctx.log.*` |

### 1.10 Secrets and search: no endpoints

- **Secrets.** No link endpoint reads or writes secrets. A system names its config's secret fields
  (`Manifest.configSecrets`). The hub seals them in its `secrets` table, and the plain values reach the system only in
  `Welcome.config` and `configure`. A person's connection credentials come in `RunRequest.connection`.
- **Search.** No link endpoint searches fns, context or resources. `ctx.resources.search` throws `LinkGap` and tells
  the author to declare `hub.fns.search_resources` as a dep instead (`sdk/src/server/resources.ts:51`).

### 1.11 What the hub calls on a system (`systemLinkSpec`)

| Endpoint (ws) | Purpose |
| --- | --- |
| `paired` (`pd`) | The pairing was approved: say hello again. |
| `run` (`run`) | Run a fn: `RunRequest` (run info, fn, kind, payload, args, budget, handlers, resume, deadline, configVersion, connection?). Returns `OutcomeWire`. |
| `control` (`ctl`) | Cancel or pause a running run. |
| `undo` (`un`) | Undo a finished run with its undo payload. |
| `handler` (`hd`) | Relay a handler call to the system whose run supplied the handler. |
| `child` (`ch`) | A child run of this system's call was created, or changed. |
| `check` (`ck`) | Check a kind payload; returns problems and the `KindDescription`. |
| `context` (`cx`) | Text for dynamic context (a `/command` or a load). |
| `roots` (`ro`), `list` (`ls`), `stat` (`sa`), `read` (`rd`), `sections` (`sc`), `watch` (`wa`) | The resource service. |
| `content` (`ct`) | A slice of content the system holds. |
| `embed` (`em`) | Run one of the system's embedders. |
| `hook` (`hk`) | Run a message hook. |
| `mentions` (`mn`), `mentionHover` (`mh`), `mentionText` (`mt`) | `@` mention search, hover card and LLM text. |
| `event` (`ev`) | A hub event the system subscribed to. |
| `action` (`ac`) | Deliver a stored action from a renderer. |
| `form` (`fm`) | Deliver a form submission to the run waiting in `ctx.form()`. |
| `restart` (`rt`), `stop` (`sp`) | Restart, or stop for a reason within a timeout. |
| `configure` (`cf`) | The config changed (plain secret values included). |
| `export` (`ex`) | Get ready for a data-folder export; returns the data folder. |
| `validate` (`vl`) | Run a fn's input or output validation hook. |
| `preview` (`pv`) | What a run that needs approval would do. |
| `providerChat` (`pc`, stream), `providerEmbed` (`pe`) | Calls to an aeye provider the system hosts. |
| `connectStart` (`cs`), `connectFinish` (`cn`), `disconnect` (`dc`) | A person connects their account (OAuth or form), or disconnects. |

### 1.12 Where the SDK's contexts come from

| Context | Has | Link calls behind it |
| --- | --- | --- |
| `FnCtx` (a run) | `fns`, `handlers`, `progress`, `state`, `form`, `allow`, `undoWith`, `onPause`, `done/fail/pause/cancelled/invalid/expose`, `budget`, `llm`, `files`, `fetch`, `resources`, `types`, `attach`, `link`, `setting`, `log`, `connection`, `updateConnection`, `shareFn`, `usableFns`, `propose`, `decide`, `fleet` | everything in 1.3 to 1.9 |
| `SystemCtx` (hooks, mentions, dynamic context, events, lifecycle) | `config`, `llm`, `resources`, `types`, `log`, `propose`, `fleet`, folders | `llm` refuses without a run (gateway.ts:160), so `ctx.llm.text` outside a run fails |
| `ActionCtx` | `SystemCtx` plus `state`, `attach`, `link`, `setting`, `files`, `fetch` | as above |
| `RunningSystem` (the serve handle) | `add`, `remove`, `types`, `restart`, `stop`, `ready`, `onStatus` | `patch` |

---

## 2. The hub's own fns

The hub is itself a system named `hub`. Its contract is `packages/sdk/src/hub.ts`, and its fns are implemented in
`hub/src/boot/hub-fns.ts`, `execution/hub-fns.ts`, `boot/read-fns.ts`, `boot/admin-fns.ts`, `resources/fns.ts`,
`contextor/fns.ts` and `mcp/fns.ts` (all registered by `registerHubContract`, `boot/modules.ts:142`).

**Shared facts.**

- **Visibility.** Every hub fn has `visibility: 'both'` (the SDK default, `sdk/src/fn.ts:290`). None has
  `instructions` or `examples`.
- **Tags.** `read` means no approval unless a policy says otherwise. Untagged means it asks the turn's user. `admin`
  means it asks, runs only for an admin (`boot/admin-fns.ts:19`), and is never exposed through a hub MCP
  (`mcp/scopes.ts:50`).
- **Display.** `message` means it shows as a plain message once done. `hidden` means it is not shown.
- **Endpoint fns.** For the fns that stand for a web endpoint, the args are the endpoint's body and the result is its
  response (`endpointFn`, hub.ts:132). A body that isn't an object (a union) becomes `{ input: <body> }`
  (`toolArgsOf`, `sdk/src/zod-gin.ts:88`).

### 2.1 When the chat model sees them

The chat agent is `hub/chat`: tools mode, plain contextor. `hub/chat_small` uses the static mode and the graph
contextor (hub.ts:447-479). Both list eight "always" fns (hub.ts:444): `search_fns`, `load_fns`, `search_context`,
`load_context`, `search_resources`, `run_status`, `run_wait` and `ask_user`.

| Situation | What the model gets |
| --- | --- |
| Tools mode (`hub/chat`) | The eight always fns as native tools at `signature` detail, plus fns the session loaded, plus fns the message names by qualified name or `@` mention (`contextor/planner.ts:208`, `:300`). |
| Static mode (`hub/chat_small`, or a session set to static) | Five fixed tools: `find`, `inspect`, `load`, `unload` (hub fns) and `run` (not a fn: it runs the fn it names). The always fns appear as listed cards, minus the five build-1 fns static mode replaces: `search_fns`, `load_fns`, `drop_fns`, `search_context`, `load_context` (`contextor/modes.ts:32`). |
| Any other hub fn | Only once it is loaded (`load_fns`, `load`), named in the message, suggested in the message's `<suggested_fns>` block (the enricher), picked by the graph contextor from index hits, or exposed by a result (`ctx.expose`). Hub fns are indexed and suggested like any system's. The `hub` system is always allowed (`index/suggester.ts:35`). |
| Running by name | Static `run`, `load` and `inspect` refuse fns that are switched off, unavailable, outside the session's systems, or of visibility `none`/`user` (`contextor/views.ts:28`). |

### 2.2 Search, load and toolset fns

| Fn | Description the model sees | Args | Returns | Tag, display | Offered |
| --- | --- | --- | --- | --- | --- |
| `hub/search_fns` | Find fns by what they do. | `query: text`, `limit?: 1..50` | `[{fn, description, available: bool}]` | read, message | always (tools mode); hidden in static |
| `hub/load_fns` | Add fns to your toolset for this session. | `fns: text[]` (at least 1) | `{loaded: text[], refused: [{fn, reason}]}` | read, hidden | always (tools); hidden in static |
| `hub/drop_fns` | Remove fns from your toolset. | `fns: text[]` (at least 1) | `{dropped: text[]}` | read, hidden | not in the always list; hidden in static |
| `hub/search_context` | Find context (guides, skills, references) by what it covers. | `query`, `limit?: 1..50` | `[{context, description}]` | read, message | always (tools); hidden in static |
| `hub/load_context` | Load context into this session. | `context: text[]` (at least 1) | `{loaded: text[]}` | read, hidden | always (tools); hidden in static |
| `hub/search_resources` | Search files and other resources by meaning and words. | `query`, `roots?: text[]` (URI prefixes), `limit?: 1..50` | `[{uri, section?, title, preview, score}]` | read, card | always |
| `hub/find` | Find fns, context, resources and types by what they are about. Already loaded items are marked. | `query: text (min 1)`, `kinds?: ('fn'\|'context'\|'resource'\|'type')[]`, `limit?: 1..50` (default 8) | `[{name, kind, description, loaded: bool}]` | read, message | static fixed tool |
| `hub/inspect` | Look at one item at a detail: a fn's card, a context item's text, a type's definition, or a resource's outline. | `name: text`, `detail?: 'listed'\|'signature'\|'full'` (default full) | `{name, kind, detail, text}` | read, message | static fixed tool |
| `hub/load` | Keep fns (as cards) and context (as text) in front of you from the next step on. | `names: text[]` (at least 1), `detail?` (declared but not used by the impl, `contextor/fns.ts:140`) | `{loaded, refused: [{name, reason}]}` | read, hidden | static fixed tool |
| `hub/unload` | Take fns and context out of what you keep in front of you. | `names: text[]` (at least 1) | `{unloaded, refused: [{name, reason}]}` | read, hidden | static fixed tool |

### 2.3 Runs and people

| Fn | Description | Args | Returns | Tag, display | Offered |
| --- | --- | --- | --- | --- | --- |
| `hub/run_status` | The status of a run, with its progress or result. | `run: text` | `{status, progress?: json, result?: json, error?: {class, message, code?, data?}}` | read, hidden | always |
| `hub/run_wait` | Wait for a run (for example one moved to the background) to finish. | `run: text`, `timeout?: duration ms` (default: the call's remaining time) | `{status, result?, error?}` | read, hidden | always |
| `hub/ask_user` | Ask a person a question and wait for the answer. | `question: text`, `user?: text` (declared, ignored: it always asks the run's user, `boot/hub-fns.ts:149`) | `{answer: text}` | read, card | always |

### 2.4 Read fns (web reads as fns; tag `read`, display `message`)

Each runs the same read as its web endpoint, as the run's person (`boot/read-fns.ts`, `resources/fns.ts`,
`contextor/fns.ts`). Admin-only endpoints refuse non-admins in the read itself (`api/reads.ts:51`).

| Fn | Description | Args (endpoint body) | Returns |
| --- | --- | --- | --- |
| `hub/resource_list` | List resources (files, pages, uploads) from every system and the hub, filtered, grouped and paged. | `cursor?`, `limit?: 1..200`, `search?`, `system?`, `family?`, `source?`, `under?` (URI prefix), `form?`, `missing?`, `group?`, `in?`, `query?: ListQuery` | page of `ResourceRecord` plus `facets` |
| `hub/resource_read` | Read a resource as text: its primary form or a chosen form, whole or by sections. | `uri`, `form?: FormKind\|'raw'`, `section?`, `offset?`, `maxChars?: 1..200000`, `rows?: {table, from, to}` | `{uri, form, text, offset, total, truncated, forms, offers}` |
| `hub/resource_outline` | A resource's sections (headings, symbols, pages or tables), each with its key and place in the outline. | `uri` | `Section[]` |
| `hub/resource_send` | Show a resource (or one section) to yourself at the next step as the model can take it: text, an image, audio or a file. Display `hidden`. | `uri`, `section?` | `{parts: [{type, name?, chars}]}` |
| `hub/context_get` | One context item with its text and its links both ways. | `name: QualifiedName` | `{record, links, backlinks, text?}` |
| `hub/types_get` | The definitions of named types and of every type they refer to, dependencies first. | `names: QualifiedName[]` (at least 1) | `{types, missing}` |
| `hub/runs_list` | Runs, newest first, filtered by fn, status, session or system. A member sees their own runs. | `cursor?`, `limit?`, `query?: ListQuery` | page of `Run` |
| `hub/run_get` | One run: its fn, args, status, result or error, cost and timings. | `run: RunId` | `Run` |
| `hub/run_tree` | The tree of runs a turn made. | `turn: TurnId` | `TreeNode` |
| `hub/llm_call` | One LLM call: its whole request and response, tokens, cost and timings. | `id: LlmInteractionId` | `LlmInteraction` |
| `hub/model_calls` | Model calls of every kind, newest first, with cost and timings. | `cursor?`, `limit?`, `run?`, `query?` | page of `ModelCall` |
| `hub/fn_metrics` | How fns have been doing: runs, outcomes, retries, durations, queue waits, cost and tokens. | `fn?`, `system?`, `days?: 1..365` | `FnMetrics[]` |
| `hub/sessions_list` | Chat sessions, most recent first. | `cursor?`, `limit?`, `query?` | page of `SessionSummary` |
| `hub/session_messages` | A session's messages, newest first, paged backwards. | `session`, `cursor?`, `limit?` | page of `ChatMessage` |
| `hub/systems_list` | Every system: connected or not, version, instances, what it offers. | `query?` | `SystemView[]` |
| `hub/system_get` | One system. | `system` | `SystemView` |
| `hub/system_fns` | A system's fns, with whether each can be used now and its running numbers. | `system` | `FnRecord[]` |
| `hub/system_logs` | The end of a system's output, oldest first. | `system`, `limit?: 1..2000` | `OutputLine[]` |
| `hub/model_roles` | Which model and provider the hub uses for each job. | `{}` | `ModelRoleView[]` |
| `hub/model_limits` | Each model's context window, output limit, reasoning reserve and characters per token, with sources. | `model?` | `ModelLimitsView[]` |
| `hub/query` | Any list by the query standard: free text, filters, a sort and paging. | `list: 'resources'\|'fns'\|'runs'\|'modelCalls'\|'llmCalls'\|'sessions'\|'contexts'\|'notifications'\|'systems'`, `query?: {cursor?, limit?, text?, filters? (up to 20), sort? (up to 3)}` | `{items: json[], cursor?, sort, total?, partial?}` |

### 2.5 Write fns (untagged: they ask unless a policy allows)

| Fn | Description | Args | Returns |
| --- | --- | --- | --- |
| `hub/resource_convert` | Make a form of a resource now (convert, describe an image, read text in it, transcribe); may cost a model call. | `uri`, `kind: FormKind` | `FormRecord` |
| `hub/resource_import` | Import a URL or uploaded content as a hub resource. | `input`: `{url, render?, name?, folder?}` or `{content: ContentRef, name, path?}` (a union, so wrapped in `input`) | `ResourceRecord` |
| `hub/resource_rename` | Rename a hub resource. | `uri`, `name` | `ResourceRecord` |
| `hub/resource_delete` | Delete a hub resource; says how many messages, context items and runs still point at it. | `uri` | `{deleted, referencedBy}` |
| `hub/context_from_resource` | Make context items from a resource (one per section, under an outline parent), or update the earlier ones. | `uri`, `sections?`, `copy?` (default `live`), `weight?`, `tags?`, `fns?`, `suggestFns?`, `alwaysFor?`, `command?`, `visible?`, `suggest?` | `{created, updated, links}` |
| `hub/remember` | Remember something as a memory: for this session, the person, or everyone. | `text`, `title?`, `scope?: 'session'\|'user'\|'everyone'` (default session), `about?: LinkTarget[]`, plus the context options | `{name}` |
| `hub/forget` | Forget a memory. | `name` | `{ok}` |

### 2.6 Admin fns (tag `admin`: they ask, run only for an admin, never on a hub MCP)

| Fn | Description (abridged) | Args (endpoint body) |
| --- | --- | --- |
| `hub/configure_provider` | Add a model provider (OpenAI, OpenRouter, Ollama) with its key, or replace its key. | `input`: `{provider:'openai', apiKey, baseURL?}` / `{provider:'openrouter', apiKey}` / `{provider:'ollama', baseURL?, contextWindow?}` / AWS variant |
| `hub/set_model_category` | Add or change a model category. | `id?`, `name`, `description`, `models: string[]` |
| `hub/set_budget` | Add or change a budget (hub, group, user, session, system, fn or model). | `id?`, `target`, `period`, `maxCost`, `maxTokens?`, `maxCalls?`, `maxTime?`, `share?`, `onLimit` |
| `hub/set_priority` | Add or change a priority rule. | `id?`, `target`, `default?`, `max?` |
| `hub/set_policy` | Add or change a policy (allow, deny, ask). | `id?`, `description`, `subject`, `target`, `decision`, `priority`, `expiresAt?` |
| `hub/set_actor_setting` | Set a declared setting for a user, group or agent. | `setting`, `actor`, `value` |
| `hub/add_user` | Add a person who can sign in. | `email`, `name`, `role`, `groups?` |
| `hub/add_group` | Add a group. | `name`, `about`, `members?` |
| `hub/remove_rule` | Remove a budget, priority rule, policy, category or provider. | `input`: `{kind, id}` |
| `hub/approve_pairing` | Approve or refuse a pairing, optionally naming the instance and setting config. | `pairing`, `approve`, `instance?`, `config?`, `autoPair?` |
| `hub/create_pairing_token` | Make a one-time pairing token. | `name?`, `expiresIn`, `autoPair?` |
| `hub/configure_system` | Set a system's config. | `system`, `config`, `instance?` |
| `hub/enable_system` | Turn a system's functions and renderers on or off. | `system`, `functions?`, `renderers?` |
| `hub/remove_system` | Remove a system. | `system` |
| `hub/install_system` | Install a system from a folder, package or git repository, and start it. | `source` (`{path}` / `{package, version}` / `{git, ref}` / `{zip, file}`), `config?`, `autoStart?` |
| `hub/start_system`, `hub/stop_system` | Start or stop an installed system. | `system`, `instance?` |
| `hub/upgrade_system` | Upgrade to a version (the latest when none is given). | `system`, `version?` |
| `hub/set_model_role`, `hub/clear_model_role` | Choose or clear the model for a job. | `input: RoleChoice` / `role` |
| `hub/set_model_limits` | Set or clear a model's limits. | `model`, `limits: {contextWindow?, maxOutputTokens?, reasoningTokens?, charsPerToken?}` |
| `hub/create_mcp`, `hub/update_mcp` | Make or change a hub MCP. | `slug`, `name`, `instructions`, `rules`, `toolMode`, `user`, `grantees`, `origins`, `enabled` (all optional plus `mcp` on update) |
| `hub/rotate_mcp_secret`, `hub/delete_mcp` | New secret; delete. | `mcp` |
| `hub/preview_mcp` | What draft MCP rules would expose. | `rules` |
| `hub/install_package` | Install a package zip, pair, configure, start. | `zip`, `instance?`, `config?`, `data?`, `autoStart?` |
| `hub/remove_instance` | Remove one instance. | `system`, `instance` |
| `hub/export_system_data` | Zip an instance's data folder with its config. | `system`, `instance`, `withSecrets?` |

### 2.7 Other hub fns

| Fn | Description | Args | Returns | Notes |
| --- | --- | --- | --- | --- |
| `hub/mint_mcp_token` | Mint a short-lived token for a hub MCP, for a session this system starts. Only a grantee system's runs may call it. | `mcp`, `label`, `ttl?: ms >= 1000` | `{token, expiresAt}` | Tagged `admin`; refused unless called from a system's fn (`mcp/fns.ts:19`) |
| `hub/chat`, `hub/chat_small` | The chat agents (kind `hub/llm`). | `{}` | text | Agents, callable like any fn |

### 2.8 Hub fns that exist but the chat model doesn't see (or can't use)

| Fn | Why |
| --- | --- |
| `search_fns`, `load_fns`, `drop_fns`, `search_context`, `load_context` | Never shown in static mode: `find`, `load` and `unload` do their jobs (`contextor/modes.ts:32`). |
| `drop_fns` | Not in the chat agents' always list, so tools mode offers it only if it is loaded or found. |
| `find`, `inspect`, `load`, `unload` | Fixed tools only in static mode. In tools mode they are ordinary hub fns, offered only if loaded or found. |
| Admin fns | **Not hidden.** No contextor or mode filters on `admin` (only `mcp/scopes.ts:50` does), so non-admins' models can find, load and call them. The run then fails with "only an admin can change this". |
| `mint_mcp_token` | Visible to the model (visibility `both`), but refused unless a system's fn calls it. |
| `web/fetch_raw` | Not a hub fn (the web system's), visibility `none`, so the model never runs it. The hub's code calls it for `resource_import`. |

---

## 3. Web API (browser)

Served on `/api/*` (HTTP) and `/ws` (WebSocket) from `hubWebSpec` (`packages/core/src/web.ts:604`), one plugin per
slice (`hub/src/api/web/*.ts`). `[admin]` marks a slice behind `adminOnly`.

**Plain HTTP routes, outside the spec** (`api/http.ts`):

- `/healthz`, `/readyz`
- `/_files` (presigned transfers)
- `/docs/*` (API docs, when on)
- `/mcp/<slug>` (hub MCPs)
- `/clients/*` (systems' client builds)
- `/connect/callback` (OAuth return)
- `/link` (the system link socket)

| Slice | Endpoint | Purpose |
| --- | --- | --- |
| auth | `setup` | Whether the admin account still needs making. |
| | `createAdmin` | Make the single admin account. |
| | `signIn`, `refresh`, `signOut` | Tokens. |
| | `me` | The signed-in user. |
| chat | `capabilities` | What the composer may offer. |
| | `types` | Type definitions for browser forms. |
| | `sessions`, `session` | List and get sessions. |
| | `createSession`, `updateSession`, `deleteSession` | Session lifecycle and settings. |
| | `limits` | The next turn's priority and budgets. |
| | `messages` | A session's messages, paged. |
| | `send` | Send a message (starts a turn). |
| | `invoke` | Run a fn by hand (`!fn`). |
| | `control` | Pause, resume or cancel a session's work. |
| | `presence` | Typing and presence. |
| runs | `background` | Move a run to the background. |
| | `undoTurn` | Undo a turn. |
| | `tree`, `run`, `llmCall` | Run tree, one run, one LLM call. |
| | `waiting` | Pending approvals and questions for the person. |
| | `approve` | Answer an approval. |
| | `answer` | Answer a handler question. |
| | `act` | Send a renderer action. |
| | `submit` | Submit a form. |
| | `state` | A run's declared state fields. |
| find | `suggest` | Fns and context matching a draft. |
| | `search` | Hybrid index search (`query`, `kinds?`, `limit?`). |
| | `mentions`, `mentionHover` | `@` search and hover. |
| | `resource` | Raw resource read. |
| inbox | `notifications`, `readNotifications` | The inbox. |
| | `pushKey`, `subscribePush` | Web push. |
| content | `upload`, `uploaded` | Presigned upload, then the ref. |
| | `transcribe` | Voice to text. |
| systems [admin] | `systems`, `system` | List and get. |
| | `pairings`, `approvePairing`, `createPairingToken` | Pairing. |
| | `configureSystem`, `enableSystem`, `removeSystem` | Config and switches. |
| | `installSystem`, `startSystem`, `stopSystem`, `upgradeSystem` | Installed systems. |
| | `reimport` | Re-import a manifest. |
| settings [admin] | `configureProvider`, `providers` | Model providers. |
| | `setModelCategory`, `setBudget`, `setPriority`, `setPolicy` | Rules. |
| | `setActorSetting` | Actor settings. |
| | `addUser`, `addGroup` | People. |
| admin [admin] | `systemFns`, `systemLogs` (+ `systemLog` event) | A system's fns and output. |
| | `models`, `modelCategories`, `budgets`, `priorityRules`, `policies`, `actors`, `actorSettings` | Reads for the admin pages. |
| | `resolveLimits` | Limits a user would get. |
| | `runs`, `llmCalls`, `resources` | Paged lists. |
| | `removeRule` | Remove a rule. |
| events | `session`, `user` (events) | Live session and user streams. |
| resources | `browseResources`, `resourceForms`, `readResource` | Browse and read. |
| | `convertResource`, `downloadResource` | Make a form; presigned download. |
| | `importResource`, `renameResource`, `deleteResource` | Hub resources. |
| | `contextFromResource` | Make context from a resource. |
| context | `contexts`, `contextItem` | Browse context. |
| | `remember`, `updateMemory`, `forget` | Memory. |
| | `linkContext`, `unlinkContext` | Graph edges. |
| contextor | `modelLimits` | Resolved model limits. |
| | `previewSelection` | Dry run of a prompt's selection. |
| | `setModelLimits` [admin] | Set limits. |
| models [admin] | `modelRoles`, `setModelRole`, `clearModelRole` | Model roles. |
| metrics [admin] | `modelCalls`, `modelCall` | Model calls. |
| | `fnMetrics`, `fnMetricsDays` | Fn metrics. |
| mcps [admin] | `mcps`, `mcp`, `createMcp`, `updateMcp`, `rotateMcpSecret`, `deleteMcp`, `previewMcp`, `mcpSessions` | Hub MCPs. |
| packaging [admin] | `pairing` | One pairing request. |
| | `instances` | A fleet's instances. |
| | `installPackage`, `removeInstance`, `exportSystemData` | Packages and exports. |
| query | `query` | Any list by `ListQuery`. |
| | `listValues` | A field's values for the search box. |
| | `fns` [admin] | The global fns catalogue. |
| suggestions [admin] | `suggestDecision`, `setSuggestDecision`, `previewSuggestions` | The suggestion decision model. |
| autoPair [admin] | `autoPairs`, `revokeAutoPair` | Auto-pair secrets. |
| access | `accessInfo`, `access`, `setAccess` | Visibility. |
| connections | `connectPages`, `connect` (HTTP only), `updateConnection`, `disconnect` | Per-person connections. |
| picker | `pick` | Options for search-as-you-type pickers. |
| approvals | `approvals` | Approvals by run, with previews. |
| registries | `contributions` | A registry's entries from all systems. |

---

## 4. Where it departs from the design

Quotes are from `docs/harness.md` (the "Decided" section, including the owner review notes of 2026-11-10) and
`docs/plans/build-5-feedback.md`. Code references are at the HEAD commit.

### 4.1 One fns/context search endpoint

> "The hub has one fns/context search endpoint, available on the web API, the system link and as an LLM fn. It does
> text and semantic search, can order by score, filters by kind, system, instance, visibility, types and mode, and
> pages its results." (harness.md:1047-1049)

- **Not on the system link.** `hubLinkSpec` has no search endpoint (link.ts:187-263). `ctx.resources.search` throws
  `LinkGap` (`sdk/src/server/resources.ts:51`).
- **Not one endpoint.** Instead there are seven overlapping searches:
  - web `search` and `suggest` (web.ts:253-254)
  - fns `hub/search_fns`, `hub/search_context`, `hub/search_resources` and `hub/find` (hub.ts:314, 336, 350, 377)
  - `hub/query` over the `fns` and `contexts` lists (word matching only)
- **Filters are missing.**
  - The index's `SearchQuery` takes only `text`, `kinds`, `limit`, `systems` and a `keep` callback
    (`hub/src/index/index.ts:87-98`).
  - Web `search` takes only `query`, `kinds` and `limit` (web.ts:254).
  - None of them filters by instance, visibility (as a filter), types read/written, or mode.
  - None returns a cursor, so none pages.
  - Ordering by score is fixed, not optional.
- **The consequence the owner objected to is still in the systems.** Because systems have no search call, they load
  their own sets and score in memory:
  - `systems/database/server/queries.ts:282-287`: `embedOne` + `cosine` over every saved query.
  - `systems/database/server/impl.ts:173-174`: embeds each member's summary per request.
  - `systems/input/server/impl.ts:72-80` (`bestMatch` over all records).
  - The SDK still exports `cosine` and `embedOne` (`sdk/src/server/vectors.ts:7,23`). The feedback says: "Remove the
    in-memory stores and the copied `cosine`/`embedOne`" (build-5-feedback.md:58-59).

### 4.2 Anything a contract declares can also be added at runtime

> "This covers fns, types, kinds, resources and roots, context, commands, components (including contributions to
> another system's registry), examples and providers. The SDK and link offer one add/update/remove API for all of
> them. The hub stores each with the system and instance that defined it, its version history and its visibility,
> and tells others live. Static contract entries end in the same records." (harness.md:1050-1056)

**The link side.** There is one generic call, `patch`, which takes an `upsert` and `remove` per manifest section
(manifest.ts:294-298). It covers the 11 sections only. Missing from it:

- **Providers, registries and contributions (components).** These are top-level manifest fields (manifest.ts:281-287),
  and `importPatch` copies only the sections (`hub/src/catalog/catalog.ts:229-235`).
- **Resource roots.** The hub pulls roots with `roots` only on connect, on config change and on manifest
  (`hub/src/link/resources.ts:48-55`, `link/handlers.ts:126`). No call says "my roots changed".
- **Examples.** Examples exist only inline in `FnDecl.examples` (manifest.ts:139), so they can change only by
  replacing the whole fn.

**The SDK side.** It exposes `patch` only for fns and types:

- `RunningSystem.add` (fns), `remove` (fns added at runtime only) and `types(upsert, remove)`
  (`sdk/src/server/index.ts:64-73`, `host.ts:288-320`).
- There is no SDK call to add, update or remove context, commands, kinds, settings, attachments, hooks, mentions,
  sectioners, actions or embedders, though `patch` would carry them.
- `remove` refuses a static contract fn (host.ts:308).

**Storage.**

- **No version history.** `TypeRecord` has `updatedAt` only (`core/src/records/systems.ts:222-231`). `FnRecord.version`
  is the hash of the current decl (systems.ts:200). No table keeps earlier versions (`core/src/records/tables.ts`).
- **No visibility for types.** `AccessTarget` covers system, fn, context, root and connection only
  (`core/src/access.ts:30-36`).
- **"The same records" holds by folding.** Runtime patches are folded into the system's single stored manifest and
  re-imported, so runtime fns get `origin: 'contract'`. `Catalog.declare`, the only path that writes
  `origin: 'runtime'` (`catalog.ts:261-278`), has no caller at HEAD.

### 4.3 The hub stores everything shared

> "Fns (saved queries and forms included), types, examples, embeddings and enrichment results live in the hub. Systems
> keep only their connection config and keys." (harness.md:1044-1045)

- **No link calls to store or read these.** There is no call to store or read examples, enrichment results or system
  vectors. `embed` returns vectors but stores nothing.
- **The database system keeps them in JSON files.** It stores saved queries with their embeddings and versions, table
  enrichments and pending type changes in its data folder (`systems/database/server/store.ts:1-6`, "`FileStore` keeps
  them as JSON files").
- **The input system does the same.** It keeps saved forms in `FileForms(dataDir)` (`systems/input/server/main.ts:24`).

### 4.4 Fns: instructions and examples

> "Fns carry real instructions for the model. Fns can have any number of examples, in their own searchable table. A
> setting picks how many go into the prompt, and `fn_examples` pages through the rest." (harness.md:1058-1060)

- **No `fn_examples`.** There is no `hub/fn_examples` fn, no examples table (tables.ts), and no setting for how many
  examples a prompt takes. The card renderer prints every inline example at `full` detail
  (`hub/src/contextor/render.ts:45`).
- **No instructions on the hub's own fns.** None of the hub's 70-odd fns has `instructions` or `examples`; each has a
  one-line `description` (hub.ts:158-222, 314-426). Only the two agent payloads have instructions.

### 4.5 Fn facts and chat modes

> "Each fn records the types it reads and writes … It also records its mode (read, write or delete) and whether it's
> free." (harness.md:1063-1064) "`none`, `read`, `write`, `delete` and `auto`." (harness.md:1068)

- **No fn facts.** `FnDecl` and `FnRecord` have no reads, writes, mode, free or cost-estimate fields (manifest.ts:111-146,
  systems.ts:196-211). The "mode" is still the `read` tag.
- **The chat modes are something else.** `ChatModeConfig` is `tools | static` (`core/src/modes.ts:59`), which is how
  fns reach the model, not the owner's none/read/write/delete/auto.
- **No classifier model.** There is no admin setting for an auto-mode classifier (no web endpoint, no admin fn).

### 4.6 A context brings the fns its work needs

> "the hub adds them to the turn" (harness.md:1075-1076)

- **Only the graph contextor adds them.** It adds `ContextDecl.fns` through `hardClosure` (`contextor/contextors.ts:454-468`).
- **The default chat doesn't.** The plain and suggest contextors, which `hub/chat` uses, take fns only from asked,
  always and loaded (contextors.ts:172). Loading a context does not bring its fns.
- **Neither do the load fns.** `hub/load` and `hub/load_context` add only the context names (`contextor/fns.ts:140-165`,
  `boot/hub-fns.ts:121-130`).

### 4.7 The LLM can see and do everything

> "Hub fns cover everything a person can see or do in the browser … and, with approval, every admin setting. A read fn
> and its web endpoint are one operation with one shape." (harness.md:778-781)

- **Admin and person operations with no hub fn:**
  - `setSuggestDecision`, `revokeAutoPair` and `reimport`
  - `setAccess` (visibility)
  - `updateMemory`, `linkContext` and `unlinkContext`
  - `approve`, `answer`, `undoTurn` and `background`
  - `createSession`, `updateSession` and `deleteSession`
  - `updateConnection` and `disconnect`
- **Admin reads with no hub fn** (only partly reachable through `hub/query`):
  - `budgets`, `policies`, `priorityRules` and `providers`
  - `actors` and `actorSettings`
  - `mcps` and `mcpSessions`
  - `pairings`, `autoPairs`, `instances` and `suggestDecision`
- **The same operation in two shapes.** The web `remember` turns scope `session` into `user`
  (`api/web/context.ts:32`). `hub/remember` passes the scope through as given (`resources/fns.ts:167`).

### 4.8 Every model call is recorded; nothing bypasses the hub

> "every model call of every modality is a `ModelCall` record attributed to its run … nothing bypasses the hub"
> (harness.md:1127-1128). The link itself says of `model`: "Nothing a system does reaches a provider any other way"
> (link.ts:232).

- **The link `embed` bypasses this.** It calls the index embedder directly, ignores its `run` field and records no
  `ModelCall` (`link/handlers.ts:136`, `index/embedding.ts:25-32`).
- **It duplicates `model {modality:'embed'}`,** and the SDK doesn't use it. Its doc comment refers to a `ctx.embed`
  that doesn't exist (`index/embedding.ts:2`).

### 4.9 Visibility on the link

Build 4's visibility model says the hub enforces visibility everywhere (web.ts:552, `accessSlice`). On the link:

- **`resource` has no check.** It ignores `run` and routes the read without any check of the run's person
  (`link/handlers.ts:135`, `link/resources.ts:105-107`). `ctx.resources` says it reads "Resources from any system the
  actor may see" (`sdk/src/ctx.ts:99`).
- **`types` and `content` have no check either.** They answer any linked system for any name or ref
  (`link/services.ts:129-133,172-174`).

### 4.10 Things declared but not done

- **`hub/ask_user` declares `user?`.** The implementation always asks the run's user (`boot/hub-fns.ts:148-150`).
- **`hub/load` declares `detail?`.** The implementation never reads it (`contextor/fns.ts:140-165`).
- **`SystemCtx.llm` is offered to hooks, mentions, dynamic context and lifecycle code.** The hub refuses an `llm`
  call without a run (`execution/gateway.ts:160`).
- **`ctx.budget.spend` never reaches the hub** (`sdk/src/server/run.ts:425-428`), though its doc says it keeps
  "budgets … exact" (`ctx.ts:289`).
- **`ctx.resources.text(uri, sections)` and `ctx.resources.sections()` throw `LinkGap`,** though `systemLinkSpec`
  has `sections` and the hub fn `resource_outline` exists (`sdk/src/server/resources.ts:33,47`).
- **The install plan is missing.** harness.md:1077-1078 says "The plan is in `docs/plans/system-install-flow.md`",
  and that file isn't in the commit. The `hub/install_system` admin fn does exist.

### 4.11 Duplicated or overlapping calls

| Overlap | Where |
| --- | --- |
| Two search and load toolsets: `search_fns` / `search_context` / `load_fns` / `load_context` / `drop_fns` (build 1) and `find` / `load` / `unload` (static). They differ: `load_fns` doesn't check the fn is meant for the model (`boot/hub-fns.ts:94-102`); `load` does (`contextor/fns.ts:151`). | hub.ts:314-349, 377-404 |
| `run_status` and `run_get` both read one run, in different shapes. | hub.ts:356, 38 |
| `resource_list`, `runs_list`, `sessions_list` and `systems_list` repeat `hub/query` over the `resources`, `runs`, `sessions` and `systems` lists. | hub.ts:33-52 |
| Link `embed` and link `model {modality:'embed'}`. | link.ts:234-235 |
| Web `resource` (find slice) and `readResource` (resources slice). | web.ts:257, 386 |
| Web per-list endpoints (`sessions`, `runs`, `llmCalls`, `resources`, `contexts`, `fns`, `notifications`, `systems`) and the generic `query`. | web.ts |
| Three copies of type lookup: link `types`, web `types`, `hub/types_get` (same shape, three endpoints). | link.ts:226, web.ts:199, hub.ts:37 |

### 4.12 Inconsistent naming

- **Hub fn word order is mixed.**
  - Noun first: `resource_list`, `context_get`, `types_get`, `run_get`, `system_fns`, `model_roles`.
  - Verb first: `search_fns`, `load_fns`, `set_budget`, `add_user`, `mint_mcp_token`, `export_system_data`.
  - Plurality differs too: `types_get` but `run_get`.
- **Link names are mixed.**
  - Noun then verb: `stateGet` / `stateSet`, `connectionUpdate`.
  - Verb then noun: `shareFn`, `usableFns`, `undoWith`.
  - The SDK renames `connectionUpdate` to `ctx.updateConnection`, and `types` to `ctx.types.definitions`.
- **Opposite directions share a name with different meanings.**
  - Hub `embed` embeds with the hub's embedder; system `embed` runs the system's embedder (both ws `em`).
  - `content` and `control` exist both ways.
  - Hub `resource` corresponds to system `read`.
- **Some endpoint-backed fns take `{ input: … }`.** A union body is wrapped as `input` (`sdk/src/zod-gin.ts:88-91`), so
  `configure_provider`, `remove_rule`, `set_model_role` and `resource_import` take `{ input: … }` while every other fn
  takes its fields directly.
