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
  cli/         @harness/cli     the `harness` CLI: system new|build|pack|install|export-data, mcp (build 2, packaging lane)
    e2e/                        reusable puppeteer scenarios (every viewport, light and dark, layout checks)
systems/
  fs/          @harness/system-fs        shared/ (contract), server/, client/ (Vue renderers)
  embedder/    @harness/system-embedder  shared/ (contract + service schemas), server/
  web/         @harness/system-web       Tavily search, page reading and rendering (build 2, web-system lane)
  template/    the template system `harness system new` copies: system.json, shared/, server/, client/ (build 2)
scripts/       dev.ts (npm run dev), stack.ts (boots the stack), hub-client.ts (the CLI's `@harness/cli/hub-client`) and
               session.ts (driving a hub from scripts), web-manifest.ts (generated web manifest), env-example.ts
  docs/        the authoring guide generator (`npm run docs:authoring`, `--check` in `npm run check`): the TypeScript
               compiler over the SDK's entry points (`extract.ts`), the section order every export must have a place in
               (`outline.ts`), the prose (`prose/`), and a compiled example system (`example/`) the guide quotes; it
               writes `packages/sdk/AUTHORING.md` and its parts (`systems/fs/shared/authoring.gen.ts`), which fs serves
               as context: the start item `fs/system-authoring` (`/new-system`) and one item per section (`parts.ts`)
e2e/           the end-to-end suite over the real stack (npm run e2e)
ui-tests/      a puppeteer script per UI feature against a running harness (npm run ui-tests)
types/         the approved type design (design record, frozen; not imported by code: the zod schemas in core and the
               generated packages/sdk/AUTHORING.md are the sources)
explorer/      the design explorer (npm run explorer)
```

Dependencies point one way: `core` ← `sdk` ← `hub`, `systems/*`, `web`. `core` imports only zod, `@ayepi/core`,
`@ayepi/auth` and `@ayepi/otel` defs (frontend-safe), gin's `TypeDef` and `ExprDef` types, and
`@aeye/resources/versions` (zod only), so the browser can import it.

## The shared contracts (`@harness/core`)

| File | What it holds |
|---|---|
| `primitives.ts` | `Json`, branded ids (`RunId`, `TurnId`, … all in `IDS`, minted with `mintId`), units, `SystemName`, `QualifiedName`, `Priority`, `page()` |
| `gin.ts` | `GinTypeDef`: a gin type on the wire (outer shape only; `registry.parse` is the full check) |
| `run.ts` | `UserInfo`, `TimeInfo`, `RunInfo`, `ClientInfo`, `Operations`, `ProgressDecl`/`ProgressWire`, `FnError`, `RunStatus`, `RunUpdate`, `OutcomeWire`, `RunSettled`, `UndoOutcome` |
| `resources.ts` | `ResourceUri`, `SectionKey`, `ContentRef`, `ResourceStat`/`Read`/`Link`/`Root`, `Section`, `Link` |
| `llm.ts` | JSON projections of aeye's request/chunk/usage: `LlmMessage`, `LlmRequest`, `LlmChunk`, `LlmForward`, `LlmForwardChunk` |
| `manifest.ts` | `Manifest` and every `*Decl`, `ManifestPatch`, `ImportReport`, `KindDescription`, `HookBlock`, `MentionOption`/`Hover` |
| `system-events.ts` | `SystemEvent` (what systems subscribe to), `MessageView`, `HeardSystemStatus` and its guard |
| `link.ts` | `hubLinkSpec` (system → hub) and `systemLinkSpec` (hub → system), the handshake (`Hello`, `HelloReply`, `Welcome`), `RunRequest`, the `linkSession` middleware def |
| `records/*.ts` | everything the hub stores (systems, actors and policies, spend, runs and turns, chat, content and notifications) |
| `records/tables.ts` | `HUB_TABLES`: every table's row schema and key; `RowOf<T>` types the store |
| `web.ts` | the web API slices (`authSlice`, `chatSlice`, …, one per hub plugin, each under its middleware chains), `hubWebSpec` joining them with `mergeSpecs`, the `tel` / `hubAuth` / `adminOnly` middleware defs and the `session` / `user` events. Build 2 adds `resourcesSlice`, `contextSlice`, `contextorSlice`, `modelsSlice`, `metricsSlice`, `mcpsSlice`, `packagingSlice` |
| `modes.ts` | chat modes (`ChatModeConfig`), contextors (`ContextorConfig`), `Detail`, model limits and calibration, `BudgetReport`, `SelectionReport`, `GraphSelection` |
| `context-graph.ts` | `ContextOrigin` (system, memory, resource), `ContextLink` and its relations and targets, the memory and context-from-resource fn shapes |
| `resource-forms.ts` | `FormRecord`, `ConvertedVersion` (the library's schema), `ResourceSource`, format families (`familyOf`), `ResourceQuery`, the resource read and import fn shapes |
| `model-calls.ts` | `ModelCall` (every model call of every modality), `ModelForward` / `ModelForwardResult` (the `model` link endpoint), model roles (`RoleChoice`, `ModelRoleView`) |
| `metrics.ts` | `RunOutcome`, `FnMetricsDay` (daily rollups with duration histograms), `FnMetrics` |
| `package.ts` | `SystemPackageManifest` (`system.json`), `InstanceRecord`, `PairingInfo`, `SystemDataExport` |
| `records/mcps.ts` | `HubMcp`, `McpRules` / `McpSelector`, `McpScopePreview`, `McpSessionView`, `McpTokenClaims` |

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
| `api/` | `PasswordHasher`, `Authenticator`, `ContentStore`, `PushService`, `EventRelay` | `@ayepi/auth`, `@ayepi/files`, `@ayepi/otel`, `@ayepi/cache`, `@ayepi/rate` (sign-in), `@ayepi/push` |
| `boot/` | `HubServices`, `RunningHub`, `StartHub`, `COMPONENTS`; env slices in `env.ts`, merged as `HUB_SETTINGS` (`mergeEnvs`; `.env.example` is generated from it by `scripts/env-example.ts`); the hub fns (`hub-fns.ts`) and the admin fns (`admin-fns.ts`), which run the same `AdminOperations` (`api/admin-ops.ts`) as the web admin endpoints | `@ayepi/env`, `@ayepi/log`, `@ayepi/updown`, `@ayepi/codec` |
| `bus.ts` | `EventBus`, `HubEvents` | — |
| `contextor/` (build 2) | `PromptPlanner`, `ChatMode`, `Contextor`, `TokenEstimates`, `ModelLimitsService`, `ContextGraph` (factories typed by `ChatModeFactories` / `ContextorFactories`) | `@aeye/core`, `@aeye/gin` (`toCode`, `toCodeDefinition`), `@aeye/models` |
| `resources/` (build 2) | `ResourceLibrary`, `Converters`, `FormService`, `ResourceReader`, `MessageContent`, `ContextLibrary` | `@aeye/resources` (registry, converters, `sectionVersion`, `fetchResource`), `@ayepi/files`, `@ayepi/work` |
| `mcp/` (build 2) | `McpRegistry`, `McpScopes`, `McpEndpoints`, `McpTokens` | `@ayepi/mcp` (`McpRouter`, `mcpSourceServer`, authorizers), `@ayepi/auth`, `@ayepi/rate` |
| `metrics/` (build 2) | `ModelCallLog`, `FnMetricsService` | core records |
| `models/` (build 2) | `ModelRoles`, `ModelGateway` | `@aeye/ai` and its providers |

Build 2's modules are wired into `HubServices` (`contextor`, `resources`, `mcp`, `metrics`, `models`) and built by
their `create.ts` factories (`BUILD_2_MODULES` in `boot/modules.ts`); each serves its own web slice from its plugin in
`api/web/`.

The `link/` module also owns installed systems and fleets: `system.json` is checked by `checkManifest`
(`link/package/format.ts`, the zip format beside it), the per-instance facts (key, config, status, install, folders)
are the `instances` table while `systems` keeps the per-system ones (`migrateLegacyInstances` moved build 1's rows on
first start), and `FleetRouter` answers which instance runs a call. The CLI (`packages/cli`) drives all of it over the
web API, and its `hub-client.ts` is what scripts and tests sign in with.

## Lanes and what they own

Build 2's lanes, their directories, the order of the first steps and the file-level ownership of `packages/core` are
in [plans/build-2-design.md](plans/build-2-design.md) §1, which is binding. In short:

| Lane | Owns | Builds |
|---|---|---|
| **template-docs** | `systems/template/**`, `scripts/docs/**`, `packages/sdk/AUTHORING.md` (generated), the fs `system-authoring` context | the template system, the authoring docs generator |
| **packaging** | `packages/cli/**`, `packages/hub/src/link/**`, `api/web/packaging.ts`, `systems/*/system.json` | the CLI, packages and zip install, data dirs and export, QR pairing (hub), fleets |
| **contextor** | `packages/hub/src/contextor/**`, `api/web/contextor.ts`, hooks in `execution/agent.ts`, `tools.ts`, `models.ts`, `providers.ts`, `chat/enrich.ts`, `turns.ts`, `catalog/catalog.ts` | chat modes, contextors, budgets, limits, the context graph |
| **resources** | `packages/hub/src/resources/**`, `api/web/resources.ts`, `api/web/context.ts`, hooks in `index/sectioners.ts`, `sectioning.ts`, `indexer.ts`, `link/resources.ts`, `api/files.ts`, fs `server/resources.ts` and `documents.ts` | raw storage, forms, readers, context from resources, memory |
| **web-system** | `systems/web/**` | Tavily search, page reading and rendering |
| **hub-platform** | the rest of `packages/hub/**` (with `mcp/`, `metrics/`, `models/`) | hub MCPs, model calls, fn metrics, invalid input, model roles, the hub fn surface |
| **sdk** | `packages/sdk/**` | the hub contract's new fns, ctx and client extensions, every modality in the forwarding provider, packaging checks, the QR display |
| **web** | `packages/web/**`, `ui-tests/**` | the UI for all of it |

Build 1's lanes (sdk, fs, data, link, execution, chat, api, web) built the first milestone; their files now belong to
the build 2 lanes above. A lane that needs a contract change it doesn't own writes it in its report (the schema, and
why).

## Dev workflow

| Command | What it does |
|---|---|
| `npm run typecheck` | `vue-tsc -b`: every project reference (core, sdk, sdk typetests, hub, web, systems, scripts, types) |
| `npm test` | vitest `unit` (Node) and `web` (happy-dom) projects; no live network |
| `npm run test:live` | `*.live.test.ts`: OpenRouter with `OPENROUTER_API_KEY` and a free model (`liveEnv`), the local embedder |
| `npm run coverage` | tests with v8 coverage |
| `npm run lint` | `scripts/lint.ts`: ESLint (strict type-checked, no `any`, no casts, Vue), one area (each workspace, `scripts`, `e2e`, `ui-tests`) per process so the type-aware rules fit in memory |
| `npm run web:manifest` | regenerate the web app's manifest from `hubWebSpec` |
| `npm run dev` | `scripts/dev.ts` over `scripts/stack.ts`: builds the web app, starts the hub (serving it) on `HARNESS_PORT` (4300) bound to `0.0.0.0`, signs in as the admin from `.env`, pairs fs, the embedder and (with `TAVILY_API_KEY` set) the web system with one-time tokens the first time, configures fs with this repository as its root. Data in `HARNESS_DATA` (`.harness`). `HARNESS_DEV_ONLY=hub,fs` runs a subset; the components are `web` (the build), `hub`, `fs`, `embedder` and `web-system` |
| `npm run dev:web` | Vite with hot reload on `HARNESS_WEB_PORT` (4310), proxying the hub |
| `npm run e2e` | `e2e/*.e2e.test.ts` (vitest project `e2e`): boots the stack (with the web system when `TAVILY_API_KEY` is set) on `HARNESS_E2E_PORT` (4330), data `.harness-test/e2e`, and drives it with a free OpenRouter model; the graph contextor suite uses the local Ollama and is skipped without it |
| `npm run ui-tests` | `ui-tests/run.ts`: every UI feature script in `ui-tests/features/` against `HARNESS_UI_URL`, at each layout (desktop 1440, laptop 1180, tablet 768, phone 390; wide 1920 and phone-landscape 844x390 for the features that ask); shots in `ui-tests/shots/<feature>/` |
| `npm run ui-tests:mock` | `ui-tests/mock.ts`: every UI feature against the web app's mock hub (builds the app, serves it on 4480 beside the mock on 4481) |
| `npm run docs:authoring` | regenerate `packages/sdk/AUTHORING.md` from the SDK's sources (`scripts/docs/`); a new SDK export needs a place in `scripts/docs/outline.ts` first |
| `npm run e2e:mock` | the web lane's puppeteer scenarios against its mock hub at phone, tablet and desktop in light and dark; shots in `packages/web/e2e/shots/` |
| `npm run build` | manifest, typecheck, then the web build (`packages/web/dist`, served by the hub) |
| `npm run check` | the web manifest, `.env.example` and authoring guide staleness checks (`--check`), typecheck, lint, tests with coverage, explorer build |
| `npm run check:full` | `check`, then `test:live` and `e2e`: the gate before a phase commit (needs `OPENROUTER_API_KEY` and the embedder) |

Tests sit beside the code as `*.test.ts`. Type-level tests use `expectType<Equal<A, B>>(true)` from `@harness/sdk`
and `@ts-expect-error` for mistakes that must not compile. Ports for anything started while testing: the given port,
or a free one above 4300, bound to `0.0.0.0`, stopped before finishing.

### Which tests run in a browser

A browser test (puppeteer: `ui-tests/`, `packages/web/e2e/`, the e2e suite's page checks) is only for behaviour that
can only be checked by rendering: layout and overlap at a screen size, focus and keyboard order, scrolling and
following, motion, and the real rendering of components (highlighting, diagrams, pdf pages, a system's renderer in the
built bundle). Everything else is a unit test, a component test (`@vue/test-utils` in the `web` project's happy-dom)
or an API-level test (a hub over its web API, as the e2e suite's API checks do). A browser check costs seconds per
screen size; the same fact checked in a component test costs milliseconds.

`ui-tests` checks that need no browser, to move in a later build (not converted yet):

| Feature scripts | What they check | Move to |
|---|---|---|
| `admin-runs`, `admin-llm`, `admin-models`, `admin-limits`, `admin-policies`, `admin-actor-settings`, `admin-resources`, `admin-system`, `admin-systems` | lists in order, a record's fields, a setting saved and read back | component tests over a fake caller; API tests for the saves |
| `url-state`, `url-reload` | each page and panel comes back from its address | router unit tests (`createMemoryHistory`) |
| `chat-manage`, `chat-modes`, `model-picker`, `model-roles`, `session-settings`, `settings` | a pick (model, mode, contextor, role) is saved and still shown after a reload | store tests plus an API round trip |
| `context-items`, `context-graph`, `fn-metrics`, `model-calls`, `hub-mcps`, `instances` | links and backlinks, the budget's parts, metric numbers, kind filters, a secret shown once, a fleet's instances | component tests over fixtures; API tests for the hub's answers |
| `invalid-input`, `fn-display`, `run-cards`, `turn-tree`, `message-details`, `timestamps`, `people`, `suggestions` | a run's status and words, whether a finished run keeps a card, tree nodes, date separators, participants, chip counts | component tests over fixture records |
| `mentions`, `undo`, `attachments`, `uploads`, `approvals`, `budget`, `commands`, `inbox`, `qr-pairing` (its answered and unknown pages) | search finds a file, an undo reverts a write, an upload becomes a resource, an approval or budget stop, a pairing's state | API tests, plus a component test for each view |
| `reconnect` | a run missed while the socket was down shows after it comes back | a connection-store test with a fake socket |

The rest stay in the browser: `responsive`, `scrolling`, `accessibility`, `motion`, `themes`, `shortcuts`, `header`,
`chat-shell`, `composer`, `streaming`, `live-runs`, `drawer-live`, `run-drawer`, `turn-controls`, `invoke`,
`markdown`, `viewers`, `renderers`, `resource-browser` (grid and thumbnails), `gin-editors`, `message-actions`,
`reasoning`, `states`, `sign-in`, `pairing`.

## Library asks

Still open (build 2's list is in [plans/build-2-design.md](plans/build-2-design.md) §8):

- **@ayepi/core:** binary ws frames.
- **@ayepi/sqlite:** a `FileStore` over SQLite (the resources lane keeps a `SqliteFiles` in the hub until then).
- **@ayepi/mcp:** server progress notifications.
- **@aeye/core:** `forget` counting tool definitions; a provider hook for the served context window.
- **@aeye/gin:** a secret marker for text fields (the web system's Tavily key is plain text today), so exports can carry
  config without its secrets.
- **@aeye/resources:** `CODE_TYPES` from a browser-safe subpath (core lists the code formats itself and the hub checks
  them against the library's at compile time); versioned converter ids (`htmlConverter@2`); `basenameFromLocation`
  for non-local `file://` URLs on Windows.
- **@ayepi/mcp:** a stdio-to-HTTP proxy helper (the CLI's `harness mcp` bridges by hand).

Done for build 2: `@ayepi/mcp` caller info, annotations, `McpRouter`, `BearerAuth`, views and `McpToolSet`;
`@ayepi/push` (web push, which the hub sends with); `@aeye/resources` converted versions and converters, the url
loader with page renderers, the folder resolver, sections of a version, `inferType` letting a name's extension beat a generic
`text/*` mime (which the hub's `RegistryConverters.typeOf` calls), and a Node ESM dist; `@ayepi/mcp` HTTP session
lifecycle (`idleTimeout`, `onSessionOpened`, `onSessionEnded`).

Settled in the libraries, on their `harness` branches (harness carries no workaround):

- **gin:** `Type.toJSON()` has no `undefined` keys and `encodeLogical()` leaves absent optional fields out, so the
  SDK's `wireType` / `encodeValue` are plain calls; type names may be qualified (`fs/Entry`); a type reports the
  named types it refers to (`references()`, `typeReferences`, `typeClosure`), which the SDK's `referencesOf`
  and the hub's `TypeRecord.references` and `Catalog.typeClosure` use, so a system can load every type it needs
  from the hub.
- **@ayepi/core:** a handler's `data` is always there when its endpoint declares input, even an empty `{}`.
- **@ayepi/log:** `consoleTransport` binds the console's methods when it is made, and a string `error` field
  becomes `{ name: 'Error', message }`.
- **@ayepi/work:** `stop()` wakes its poll loop.
- **@aeye/resources:** structural section keys (`sectionKeys`, `splitMarkdownSections`, `splitCodeBlocks`, which
  the hub's sectioners and the SDK's `sectionKeys` use) and node/TypeScript import resolution (`resolveImportPath`,
  used by the fs system's documents and by its own file resolver).
