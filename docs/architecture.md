# Harness: code architecture

How the code is laid out, who owns what, what everyone shares, and how to work on it. The design itself is
[harness.md](harness.md); the approved type design is in `types/` (kept as the design record, browsable with
`npm run explorer`). Library research is in [research/](research/).

## Rules every lane follows

- **One source of truth.** Wire shapes are zod schemas in `@harness/core`; every TypeScript type is `z.infer` of
  one. Fn signatures, payloads and config are gin types made with `g`; their TS types are gin's `Infer`. Where a gin
  type must equal a core schema (the hub's `ContentRef`, `FnError`), a compile-time `Equal` test pins them together.
  Never write a type by hand that a schema already describes.
- **No `any`, no unchecked casts.** ESLint refuses `as` (except `as const`). The few casts that bridge a runtime loop to
  a mapped type carry an `eslint-disable-next-line ... -- why` comment and live in one helper (`sdk/src/util.ts`,
  `system.ts`). Add a new one only with the same justification.
- **Interfaces for anything with more than one implementation.** Every module's `index.ts` is its interface; the
  implementation is a class in a sibling file, and tests use fakes of the other modules' interfaces.
- **Tunables live in `@ayepi/env` slices** (`packages/hub/src/boot/env.ts`, plus a slice beside each tool that needs
  one). Feature code never reads `process.env`. Durations are milliseconds with no unit suffix.
- **Log with structured keys**: `log.info('run.settled', { run, fn, status })`. The key is a stable dotted literal.
- **Fix libraries in the library.** `@aeye/*` and `@ayepi/*` are linked from the local `harness` branches. A lane
  that is not assigned a library records the need in its report (see "Library asks" below).
- **Only touch what your lane owns.** Shared files (core, this doc, root config) change through the orchestrator.

## Layout

```
packages/
  core/        @harness/core    wire contracts: zod schemas, ayepi specs, records, HUB_TABLES
  sdk/         @harness/sdk     the system author SDK (contract builders, refs, ctx types, manifest, client types)
    src/server @harness/sdk/server   serve() and the SystemHost the SDK lane implements
    typetests/                  compile-time DX tests (ported from types/examples.ts), checked by `npm run typecheck`
  hub/         @harness/hub     the hub: one folder per module, each with an index.ts interface
  web/         @harness/web     Vue 3 + Vite + vue-router chat and admin app
    e2e/                        reusable puppeteer scenarios (every viewport, light and dark, layout checks)
systems/
  fs/          @harness/system-fs        shared/ (contract), server/, client/ (Vue renderers)
  embedder/    @harness/system-embedder  shared/ (contract + service schemas), server/
scripts/       dev.ts (npm run dev), stack.ts (boots the stack), hub-client.ts and session.ts (driving a hub from scripts),
               web-manifest.ts (generated web manifest)
e2e/           the end-to-end suite over the real stack (npm run e2e)
ui-tests/      a puppeteer script per UI feature against a running harness (npm run ui-tests)
types/         the approved type design (design record; not imported by code)
explorer/      the design explorer (npm run explorer)
```

Dependencies point one way: `core` ← `sdk` ← `hub`, `systems/*`, `web`. `core` imports only zod, `@ayepi/core`,
`@ayepi/auth` and `@ayepi/otel` defs (frontend-safe) and gin's `TypeDef` type, so the browser can import it.

## The shared contracts (`@harness/core`)

| File | What it holds |
|---|---|
| `primitives.ts` | `Json`, branded ids (`RunId`, `TurnId`, … all in `IDS`, minted with `mintId`), units, `SystemName`, `QualifiedName`, `Priority`, `page()` |
| `gin.ts` | `GinTypeDef`: a gin type on the wire (outer shape only; `registry.parse` is the full check) |
| `run.ts` | `UserInfo`, `TimeInfo`, `RunInfo`, `ClientInfo`, `Operations`, `ProgressDecl`/`ProgressWire`, `FnError`, `RunStatus`, `RunUpdate`, `OutcomeWire`, `RunSettled`, `UndoOutcome` |
| `resources.ts` | `ResourceUri`, `SectionKey`, `ContentRef`, `ResourceStat`/`Read`/`Link`/`Root`, `Section`, `Link` |
| `llm.ts` | JSON projections of aeye's request/chunk/usage: `LlmMessage`, `LlmRequest`, `LlmChunk`, `LlmForward`, `LlmForwardChunk` |
| `manifest.ts` | `Manifest` and every `*Decl`, `ManifestPatch`, `ImportReport`, `KindDescription`, `HookBlock`, `MentionOption`/`Hover`, `SystemEvent` |
| `link.ts` | `hubLinkSpec` (system → hub) and `systemLinkSpec` (hub → system), the handshake (`Hello`, `HelloReply`, `Welcome`), `RunRequest`, the `linkSession` middleware def |
| `records/*.ts` | everything the hub stores (systems, actors and policies, spend, runs and turns, chat, content and notifications) |
| `records/tables.ts` | `HUB_TABLES`: every table's row schema and key; `RowOf<T>` types the store |
| `web.ts` | `hubWebSpec` (every browser endpoint, the `tel` / `hubAuth` / `adminOnly` middleware defs) and its `session` / `user` events |

The web app gets the zod-free manifest of `hubWebSpec` from `packages/web/src/api/manifest.gen.ts`, written by
`npm run web:manifest`. `npm run check` fails when it is stale.

## The SDK (`@harness/sdk`)

Pure builders, implemented now: `g` (gin's registry; `json()` for untyped JSON), `system().with()`, `fn`, `handler`,
`linear`, `steps`, `type`, `setting`, `attachment`, `kind` (and `kinds.x.fn()`), `context`, `arg`, `hook`, `mention`,
`embedder`, `sectioner`, `sectionKeys`, `action`, `agent`, the hub's own contract `hub` (its `llm` kind, its fns,
mentions, sectioners and the `ContentRef` / `LongText` types), `manifestOf` (contract → core `Manifest`, hashed),
`client()` and the renderer prop types (`FnViewOf`, `AttachmentViewOf`, `InputViewOf`, …), `RESOURCE_VIEWER`.

A type ref (`fs.types.Entry`) is a real gin extension registered in `g` under its qualified name, so it is usable as a
field and serializes by name; its methods' args are `self` plus their own args.

**Built by the SDK lane** (interfaces in `sdk/src/server/index.ts` and `sdk/src/ctx.ts`): `LinkHost implements
SystemHost` (the WebSocket link with ayepi peers, pairing keys via `KeyStore`, `FnCtx` / `ActionCtx` /
`SystemCtx` services, outcome helpers, resume by call key, the outcome journal), the forwarding aeye provider
(`HarnessProvider`), the MCP face, and the chat-side client runtime that provides `SystemClient` and
`RESOURCE_VIEWER`.

## The hub's modules

Each module is a folder in `packages/hub/src` with an `index.ts` of interfaces (TSDoc on every member). Modules talk
through those interfaces, the typed `EventBus` (`bus.ts`) and the `HubServices` container (`boot/index.ts`), never
through each other's implementation files. Each module's handlers are installed as `@ayepi/plugin` plugins over
`hubWebSpec` / `hubLinkSpec` by the api lane's boot code.

| Module | Interfaces to implement | Libraries it uses |
|---|---|---|
| `store/` | `HubStore`, `Table`, `VectorIndex`, `TextIndex`, `AyepiPorts`, `StoreFactory` | better-sqlite3, sqlite-vec (768), Kysely, `@ayepi/sqlite` (work + rate ports) |
| `catalog/` | `Catalog`, `FnSignature`, `KindDescriber` | `@aeye/gin` (`parse`, `compatible`, `typeClosure`, `toValueSchema`) |
| `link/` | `LinkService`, `SystemConnection`, `PairingService`, `ConfigService`, `Supervisor` | `@ayepi/core` peers, `@ayepi/node`, `@ayepi/updown` |
| `execution/` | `RunService`, `PolicyEngine`, `LimitResolver`, `Ledger`, `LlmGateway`, `AgentLoop` | `@ayepi/work`, `@ayepi/rate`, `@aeye/core` (`Prompt`, `PromptSuspend`), `@aeye/ai`, `@aeye/openrouter`, `@aeye/models` |
| `chat/` | `SessionService`, `TurnService`, `ReplyRule`, `MessageEnricher`, `StateService`, `DeliveryService`, `UndoService` | core records |
| `index/` | `Embedder`, `Embedders`, `Indexer`, `Search`, `Suggester` | `@ayepi/work` batches, `@aeye/resources` |
| `api/` | `PasswordHasher`, `Authenticator`, `ContentStore`, `PushService`, `EventRelay` | `@ayepi/auth`, `@ayepi/files`, `@ayepi/otel`, `@ayepi/cache`, `@ayepi/rate` (sign-in), web-push |
| `boot/` | `HubServices`, `RunningHub`, `StartHub`, `COMPONENTS`; env slices in `env.ts` | `@ayepi/env`, `@ayepi/log`, `@ayepi/updown`, `@ayepi/codec` |
| `bus.ts` | `EventBus`, `HubEvents` | — |

## Lanes and what they own

| Lane | Owns | Builds |
|---|---|---|
| **sdk** | `packages/sdk/**` | `serve` runtime (`LinkHost`), ctx services, `HarnessProvider`, MCP face, client runtime; keeps `typetests/` passing |
| **fs** | `systems/fs/**` | the fs server (files, shell, resources, git hook, mentions, restart) and its Vue renderers |
| **data** | `packages/hub/src/store/**`, `packages/hub/src/index/**`, `systems/embedder/**` | SQLite store, vectors and full text, embedders, indexer, hybrid search, suggestions, the embedder system |
| **link** | `packages/hub/src/link/**`, `packages/hub/src/catalog/**` | link handlers and peers, pairing, config, supervisor, manifest import, gin scopes, availability |
| **execution** | `packages/hub/src/execution/**` | runs and queues, agent loop, LLM gateway and the hub as provider, policies, limits, ledger |
| **chat** | `packages/hub/src/chat/**` | sessions, turns, reply rule, enrichment and hooks, session state, deliveries, undo |
| **api** | `packages/hub/src/api/**`, `packages/hub/src/boot/**`, `packages/hub/src/bus.ts`, `packages/hub/src/main.ts`, `scripts/dev.ts` | auth (single admin), web API plugins, realtime relay, files, push, serving the web build, boot and shutdown |
| **web** | `packages/web/**` | the Vue chat and admin app (`api/` callers, `state/` stores, `components/`, `pages/`), e2e scenarios |

`packages/core`, `docs/architecture.md`, root configs and `types/` belong to the orchestrator. A lane that needs a
contract change writes it in its report (the schema, and why); it is made between phases so every lane sees it.

## Dev workflow

| Command | What it does |
|---|---|
| `npm run typecheck` | `vue-tsc -b`: every project reference (core, sdk, sdk typetests, hub, web, systems, scripts, types) |
| `npm test` | vitest `unit` (Node) and `web` (happy-dom) projects; no live network |
| `npm run test:live` | `*.live.test.ts`: OpenRouter with `OPENROUTER_API_KEY` and a free model (`liveEnv`), the local embedder |
| `npm run coverage` | tests with v8 coverage |
| `npm run lint` | ESLint (strict type-checked, no `any`, no casts, Vue) |
| `npm run web:manifest` | regenerate the web app's manifest from `hubWebSpec` |
| `npm run dev` | `scripts/dev.ts` over `scripts/stack.ts`: builds the web app, starts the hub (serving it) on `HARNESS_PORT` (4300) bound to `0.0.0.0`, signs in as the admin from `.env`, pairs fs and the embedder with one-time tokens the first time, configures fs with this repository as its root. Data in `HARNESS_DATA` (`.harness`). `HARNESS_DEV_ONLY=hub,fs` runs a subset |
| `npm run dev:web` | Vite with hot reload on `HARNESS_WEB_PORT` (4310), proxying the hub |
| `npm run e2e` | `e2e/*.e2e.test.ts` (vitest project `e2e`): boots the stack on `HARNESS_E2E_PORT` (4330) and drives it with a free OpenRouter model |
| `npm run ui-tests` | `ui-tests/run.ts`: every UI feature script in `ui-tests/features/` against `HARNESS_UI_URL`, at 1440x900 and 390x844; shots in `ui-tests/shots/<feature>/` |
| `npm run e2e:mock` | the web lane's puppeteer scenarios against its mock hub at phone, tablet and desktop in light and dark; shots in `packages/web/e2e/shots/` |
| `npm run build` | manifest, typecheck, then the web build (`packages/web/dist`, served by the hub) |
| `npm run check` | manifest check, typecheck, lint, tests, explorer build |

Tests sit beside the code as `*.test.ts`. Type-level tests use `expectType<Equal<A, B>>(true)` from `@harness/sdk`
and `@ts-expect-error` for mistakes that must not compile. Ports for anything started while testing: the given port,
or a free one above 4300, bound to `0.0.0.0`, stopped before finishing.

## Library asks found while laying the foundation

- **gin:** `Type.toJSON()` leaves keys whose value is `undefined` (e.g. `props.x.docs`); `Value.encodeLogical()` writes
  an absent optional field as `null`, which the type's own `toValueSchema()` refuses. The SDK works around both in
  `wireType` / `encodeValue`; gin should omit both.
- **gin:** named types are registered under qualified names with a `/` (`fs/Entry`); check that `toCode` renders
  them readably for the LLM.

## Library asks found while integrating

- **@ayepi/core:** a handler's `data` is left out when every field of the request is absent (`{}`; `server.ts`,
  `payload.data` is only set when the merged data has keys), though the handler types say it is there. The hub reads
  such bodies through `bodyOf` (`api/web/access.ts`); the server should always pass the parsed (possibly empty) data.
- **@ayepi/log:** `consoleTransport()` without a `console` writes through the global console at write time, so once
  `interceptConsole()` runs every line goes back into the logger and is dropped. The hub binds the original methods
  (`boot/log.ts`); the transport should capture them when it is made. A string `error` field renders as
  `error=undefined: undefined` because `error` is reserved for a serialized `Error`; `errorFieldFilter`
  (`@harness/sdk/server`) turns such strings into that shape. The logger should accept a string there.
- **@ayepi/work:** `stop()` waits for its poll loop, which sleeps on an unref'd timer, so awaiting `stop()` in a process
  with nothing else alive lets Node exit before it settles. Waking the loop on `stop()` would fix it.
