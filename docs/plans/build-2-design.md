# Build 2 design

**Binding.** This is the design every build 2 lane builds to. It turns the owner's request ([build-2.md](build-2.md))
and the research ([contextor](../research/contextor.md), [resources](../research/resources-2.md),
[MCP and packaging](../research/mcp-packaging.md)) into contracts, owners and checks. Where the research and this
document differ, this document wins. A lane that finds the design wrong says so in its report (what, why, the
change it wants); it does not quietly build something else.

The contracts named here **exist already**: the zod schemas and ayepi slices in `@harness/core`, the hub module
interface files, the stub web plugins and the wired module factories. `npm run typecheck` and `npm test` pass with
every new service answering `501 NOT_BUILT`. Each lane replaces its own stubs.

Read in this order: section 1 (lanes, directories, sequence), section 2 (the contracts already made), your items in
section 3, sections 4 to 8 (hub fns, the UI, tests, dependencies, library asks).

Words: **raw** is a resource's bytes as served or uploaded; a **form** is something made from them (a converted
version from `@aeye/resources`, or a model-made description, text-in-image, transcript or thumbnail). An
**instance** is one attached copy of a system (`fs@laptop`). **Detail** is how much of a fn or context item the
model sees (`listed`, `signature`, `full`).

---

## 1. Lanes, directories and sequence

### 1.1 Who owns what

| Lane | Owns (may edit) | Builds |
|---|---|---|
| **template-docs** | `systems/template/**`, `scripts/docs/**`, the generated `packages/sdk/AUTHORING.md`, `systems/fs/server/authoring.ts` (new) and the one context entry it adds to `systems/fs/shared/index.ts` | the template system, the docs generator and its `--check`, the fs `system-authoring` context |
| **packaging** | `packages/cli/**` (new workspace), `packages/hub/src/link/**` (pairing, connections, supervisor, process, installer, resources router's instance routing), `api/web/packaging.ts`, `systems/*/system.json` and `systems/fs/package.json` / `systems/fs/server/main.ts` (data dirs), `scripts/hub-client.ts` (moves into the CLI), `scripts/dev.ts` / `scripts/stack.ts` (instances, data dirs) | the `harness` CLI, `system.json`, zip install, data dirs, data export, QR pairing (hub side), fleets |
| **contextor** | `packages/hub/src/contextor/**`, `api/web/contextor.ts`, and these hooks only: `execution/agent.ts`, `execution/tools.ts`, `execution/models.ts` (limits in the resolver), `execution/providers.ts` + the `providerVariants` entry in `core/src/records/spend.ts` (the Ollama provider), `chat/enrich.ts` and `chat/turns.ts` (graph mode, `/command` forcing, carry-over C1), `catalog/catalog.ts` (calling `graph.derive`) | chat modes, contextors, budgets, limits and calibration, the context graph, the static toolset fns |
| **resources** | `packages/hub/src/resources/**`, `api/web/resources.ts`, `api/web/context.ts`, these hooks: `index/sectioners.ts`, `index/sectioning.ts`, `index/indexer.ts` (sectioning from forms, `hub/tables`), `link/resources.ts` (the hub root as a local provider, coordinated with packaging: resources lane adds the provider, packaging the instance routing), `api/files.ts` (the database `FileStore` choice), `systems/fs/server/resources.ts` and `systems/fs/server/documents.ts` (fs returns bytes) | raw storage, forms, readers, message content, hub resources and imports, context from resources, memory |
| **web-system** | `systems/web/**` | the web system: Tavily search, reading pages into hub resources, the puppeteer page renderer |
| **hub-platform** | every other file of `packages/hub/**` (`api/**` except the slice files above, `boot/**`, `bus.ts`, `catalog/**` except the one hook, `chat/**` except the hooks, `execution/**` except the hooks, `index/**` except the hooks, `store/**`, `mcp/**`, `metrics/**`, `models/**`) | hub MCPs, `ModelCall` for every modality, fn metrics, `invalid-input`, model roles (transcription, dictation), the full hub fn surface's implementations outside the other lanes, `@ayepi/push` |
| **sdk** | `packages/sdk/**` | the hub contract's new fns and payload fields, `fn({ examples })`, context graph fields, `ctx.invalid` / `ctx.expose`, data dirs and instances in ctx, `system.json` checks, the QR pairing display, every modality in the forwarding provider, `client()` extensions, the `export` link handler |
| **web** | `packages/web/**`, `ui-tests/**` | the UI for all of it, the gin editors and viewers, the viewers and browser, carry-overs C2 to C4 |

**Core files after the design.** `packages/core` was made in the design phase; from now on each file has one lane
that may change it (others ask in their report):

| Core file | Lane |
|---|---|
| `modes.ts`, `context-graph.ts` | contextor |
| `resource-forms.ts`, `resources.ts`, `records/content.ts` | resources |
| `model-calls.ts`, `metrics.ts`, `records/mcps.ts`, `records/runs.ts`, `records/spend.ts` (except `providerVariants`: contextor), `records/actors.ts`, `run.ts`, `status.ts`, `admin.ts` | hub-platform |
| `package.ts`, `records/systems.ts`, `link.ts` (except the `export` endpoint: sdk) | packaging |
| `manifest.ts` (`FnDecl.examples`, `ContextDecl` graph fields) | sdk |
| `web.ts` | the lane of the slice being changed (`resourcesSlice` → resources, …); a new slice is asked for |
| `primitives.ts`, `records/tables.ts`, `index.ts`, `core.test.ts` | the lane adding the id kind or table (a one-line edit), listed in its report |

### 1.2 Sequence

0. **Design (done).** Contracts, interface files, stub plugins, wired module factories, env slices, and migration
   **M1**: the `invalid-input` run status and outcome (core, plus the exhaustive maps in hub, sdk, web and fs).
1. **First steps, before others need them** (each lane does its own first; nobody else edits those files meanwhile):
   - **sdk S1**: the hub contract's new fns (section 4) and `LlmPayloadType`'s `mode`, `contextor`, `maxOutput`
     (gin from the core zod schemas with `ginOf`, pinned by an `Equal` test). Every lane registers hub fn
     implementations against these refs.
   - **packaging M2 (fleet identity)**: `Hello.instance` (today a per-process nonce) is renamed `boot` everywhere
     (`Hello`, `LinkSession`, `SystemInfo`, `SystemTokenClaims`, the SDK's host and fake hub, the hub's link and test
     rigs), and `Hello` gains `instance: InstanceName` (default `main`). Packaging makes the core and hub edits and
     the sdk's mechanical renames in `server/host.ts`, `server/testing.ts`, `server/mcp.ts` (one commit-free step,
     announced in its report); the sdk lane does not touch those three files until M2 is in.
   - **contextor M3**: the `ollama` provider variant (`providerVariants` + its builder in `execution/providers.ts`).
2. **Parallel build** of everything else, each lane in its own files.
3. **Integration**: `npm run check`, `npm run test:live`, `npm run e2e` with the new suites, `npm run ui-tests` for
   the new features, fixes found there.

### 1.3 Ports and data for anything a lane starts

Servers bind `0.0.0.0`, use their lane's ports, keep data under `.harness-test/<lane>/` and are stopped before the
lane finishes. Never touch 4300, 4181, 4182, 8760, 11434 or `.harness`.

| Lane | Ports |
|---|---|
| template-docs | 4410–4419 |
| packaging | 4420–4429 |
| contextor | 4430–4439 |
| resources | 4440–4449 |
| web-system | 4450–4459 |
| hub-platform | 4460–4469 |
| sdk | 4470–4479 |
| web | 4480–4499 |

---

## 2. Contracts made in the design phase

### 2.1 `@harness/core`

| File | What it holds (new or changed) |
|---|---|
| `primitives.ts` | id kinds `modelCall` (`mdl_`) and `mcp` (`mcp_`); `ADMIN_TAG`; `RESERVED_SYSTEM_NAMES` (`hub`, `memory`, `resource`) and `isReservedSystemName`; `InstanceName`, `MAIN_INSTANCE`, `InstanceRef`, `instanceLabel`; `NameGlob`; `ActorKind` gains `mcp` |
| `gin.ts` | `GinExprDef` (gin's `ExprDef` on the wire) beside `GinTypeDef` |
| `run.ts` | `InputProblem`, `InputProblemSource`, `InvalidInput`, `INVALID_INPUT_CODE`; `RunStatus` gains `invalid-input` (settled, words "Retried", phase `retry`); `OutcomeWire` gains `{ status: 'invalid-input', invalid }` and `done.expose` |
| `modes.ts` | `Detail`, `Exposure`; `ToolsMode`, `StaticMode`, `ChatModeConfig`, `ChatModeType`, `STATIC_TOOLS`; `PlainContextor`, `SuggestContextor`, `GraphContextor` (`GRAPH_METRICS`, `MetricWeight`, `BudgetShares`), `ContextorConfig`, `ContextorType`, `DEFAULT_CHAT_MODE`, `DEFAULT_CONTEXTOR`; `ModelLimits`, `ResolvedModelLimits`, `LimitSource`, `ModelLimitsView`, `ModelLimitsRecord`, `ModelCalibration`; `PoolUse`, `BudgetReport`, `SelectedItem`, `SelectionReport`, `GraphSelection` |
| `context-graph.ts` | `MemoryScope`, `ContextCopy`, `ContextOrigin`, `ContextTokens`; `LINK_RELATIONS`, `HARD_RELATIONS`, `DeclarableRelation`, `LinkTarget`, `linkTargetKey`, `DeclaredLink`, `LinkSource`, `ContextLink`; hub fn shapes `RememberArgs`, `ContextFromResourceArgs`, `ContextFromResourceResult` |
| `resources.ts` | `ConvertedKind` (read off `@aeye/resources/versions`), `MADE_FORM_KINDS`, `FormKind`; `Section.form`, `SectionMatch.form` |
| `resource-forms.ts` | `ConvertedVersion` (= the library's `resourceVersionSchema`), `isConvertedKind`, `CONVERTED_VERSION_MIME`, `FormRecord`, `FormOffer`, `ResourceSource`, `HUB_RESOURCE_ROOT`, `FORMAT_FAMILIES`, `FORMAT_FAMILY`, `familyOf`, `ResourceGrouping`, `ResourceFacet`, `ResourceQuery`, hub fn shapes `ResourceReadArgs`, `ResourceReadResult`, `ResourceImportArgs` |
| `model-calls.ts` | `Modality`, `ModelUnits`, `ModelUsage`, `SpeechFormat`, `ModelCallStatus`, `ModelCall` (a union on `modality`), `ModelCallFilter`, `ModelCallQuery`, `ModelForward`, `ModelForwardResult`; `ModelRole`, `ModelOnlyRole`, `RoleModel`, `DictationEngine`, `RoleChoice`, `ModelRoleRecord` (keyed by `choice.role`), `RoleResolution`, `ModelRoleView` |
| `metrics.ts` | `RunOutcome`, `OutcomeCounts`, `DURATION_BUCKETS`, `DurationStats`, `FnMetricsDay`, `FnMetrics`, `FnMetricsQuery` |
| `records/mcps.ts` | `McpSlug`, `ResourceSelector`, `McpSelector`, `McpRules`, `McpToolMode`, `HubMcp`, `HubMcpInput`, `McpTokenClaims`, `McpScopePreview`, `McpSessionView`, `HubMcpView` |
| `package.ts` | `PACKAGE_FORMAT`, `SemVer`, `PackagePath`, `SystemPackageManifest`, `PACKAGE_MANIFEST_FILE`, `InstanceDirs`, `InstanceRecord`, `PairingInfo`, `SystemDataExport` |
| `manifest.ts` | `FnExample`, `FnDecl.examples`; `ContextDecl.weight`, `.summary`, `.parent`, `.next`, `.links` |
| `records/systems.ts` | `PairingRequest.description`, `.instance`, `.configType`; `FnStats.outcomes` (an `OutcomeCounts`, replacing `runs` and `failures`), `.p95`, `.averageQueued`, `.tokens` (the shapes `FnMetrics` has); `ContextRecord.origin`, `.tokens`, `.disabled` |
| `records/chat.ts` | `Session.mode`, `.contextor`, `.selection`; `ChatCapabilities.dictation` |
| `records/runs.ts` | `Run.tokens`, `.approvedAt`; `LlmInteraction.selection`, `.modelCall` |
| `records/spend.ts` | `LedgerEntry.modelCall` |
| `records/content.ts` | `ResourceRecord.source`, `.raw`, `.forms`, `.primary` |
| `records/actors.ts` | `McpActor` in the `Actor` union |
| `records/tables.ts` | tables `instances`, `contextLinks`, `modelLimits`, `modelCalibration`, `forms`, `modelCalls`, `modelRoles`, `fnMetrics`, `mcps` |
| `link.ts` | `hubLinkSpec` gains `model` (`ModelForward` → `ModelForwardResult`, under `linkSession`) and `pairingInfo` (`PairingInfo`, in the handshake group: only the socket that started the pairing may send it) |
| `web.ts` | new slices (below); `chatSlice.updateSession` takes `mode` and `contextor` (nullable); `systemsSlice.approvePairing` takes `instance` and `config`; `UserEvent` gains `resource` and `context` |

New fields on existing records are optional, so build 1 data still parses. Each owning lane tightens a field to
required when its writer always sets it and a migration fills old rows (`ContextRecord.origin`, for instance).

**Web slices** (each served by a stub plugin today; `api/web/index.ts` installs them):

| Slice | Endpoints | Plugin file | Lane |
|---|---|---|---|
| `resourcesSlice` | `browseResources`, `resourceForms`, `readResource`, `convertResource`, `downloadResource`, `importResource`, `renameResource`, `deleteResource`, `contextFromResource` | `api/web/resources.ts` | resources |
| `contextSlice` | `contexts`, `contextItem`, `remember`, `forget`, `linkContext`, `unlinkContext` | `api/web/context.ts` | resources |
| `contextorSlice` | `modelLimits`, `previewSelection`; admins: `setModelLimits` | `api/web/contextor.ts` | contextor |
| `modelsSlice` (admins) | `modelRoles`, `setModelRole`, `clearModelRole` | `api/web/models.ts` | hub-platform |
| `metricsSlice` (admins) | `modelCalls`, `modelCall`, `fnMetrics`, `fnMetricsDays` | `api/web/metrics.ts` | hub-platform |
| `mcpsSlice` (admins) | `mcps`, `mcp`, `createMcp`, `updateMcp`, `rotateMcpSecret`, `deleteMcp`, `previewMcp`, `mcpSessions` | `api/web/mcps.ts` | hub-platform |
| `packagingSlice` (admins) | `pairing`, `instances`, `installPackage`, `removeInstance`, `exportSystemData` | `api/web/packaging.ts` | packaging |

`packages/web/src/api/manifest.gen.ts` is regenerated (`npm run web:manifest`), so the web lane has typed callers
for every endpoint now; until a lane replaces its stub, a call answers 501 `NOT_BUILT`.

### 2.2 Hub module interface files

| File | Interfaces | `HubServices` key | Lane |
|---|---|---|---|
| `contextor/index.ts` | `TokenEstimator`, `TokenEstimates`, `ModelLimitsService`, `BudgetPlan`, `FnView`, `ChosenContext`, `ChosenFn`, `ExchangeSummary`, `Selection`, `RenderedIteration`, `ModelCallOut`, `CallPlan`, `ChatMode`, `ContextorInput`, `Contextor`, `ContextorDeps`, `ChatModeFactories`, `ContextorFactories`, `PlannedPrompt`, `PlanInput`, `PromptPlanner`, `ModeChoice`, `ContextGraph`, `ContextorServices`, `Overflow` | `contextor` (`planner`, `limits`, `tokens`, `graph`) | contextor |
| `resources/index.ts` | `Asking`, `ResourceLibrary`, `Converters`, `FormService`, `ResourceReader`, `MessageContent`, `ContextLibrary`, `ResourceServices` | `resources` (`library`, `forms`, `reader`, `content`, `context`) | resources |
| `mcp/index.ts` | `McpRegistry`, `McpScope`, `McpScopes`, `McpEndpoints`, `McpTokens`, `McpServices` | `mcp` (`registry`, `scopes`, `endpoints`, `tokens`) | hub-platform |
| `metrics/index.ts` | `CallSiteInfo`, `OpenModelCall`, `ModelCallLog`, `FnMetricsService`, `MetricsServices` | `metrics` (`calls`, `fns`) | hub-platform |
| `models/index.ts` | `ModelRoles`, `ModelSite`, `ModelGateway`, `ModelServices` | `models` (`roles`, `gateway`) | hub-platform |

Each module has a `create.ts` whose factory (`contextorModule`, `resourcesModule`, `mcpModule`, `metricsModule`,
`modelsModule`) builds `notBuiltService` stubs (`boot/not-built.ts`, the one justified cast; it goes when the last
stub does). `boot/modules.ts` installs them as `BUILD_2_MODULES`; the test rig (`api/testing/rig.ts`) fakes every
new service like the old ones. A lane replaces its `create.ts` with the real factory and keeps the interfaces.

**Env slices** (merged into `HUB_SETTINGS`; `.env.example` regenerated): `contextorEnv` (`contextor/env.ts`),
`resourcesEnv` (`resources/env.ts`), `mcpEnv` (`mcp/env.ts`). Hub MCP keys are `HARNESS_HUB_MCP_*` so they never
clash with the SDK's own `HARNESS_MCP_*` (the system MCP face).

---

## 3. The items

Each item: the ask, the design, who builds what, the contracts, and the checks that say it is done.

### 3.1 Template system and generated docs (template-docs)

**Ask.** A template system with placeholder comments and no example code; docs of every type an author needs,
rebuilt by a script from the TypeScript sources, complete enough that an LLM writing a system reads only them; the
fs system offers this as context so the chat can make systems itself.

**Design.**

- `systems/template/` is a real system folder in the build 2 layout (3.12): `system.json` (`name: "template"`,
  `version: "0.1.0"`), `package.json`, `shared/index.ts` (`system('template', { description })` with an empty
  `.with({})` and a comment above each section naming what goes there and which SDK builder declares it),
  `server/main.ts` (`serve(contract, {})` with a comment per implementation section), `client/index.ts`
  (`client(contract, {})` with a comment per renderer kind), `README.md` (how to run it, pair it and pack it). It
  typechecks and builds as is (it is in the root `tsconfig` references), declares nothing, and is the source
  `harness system new` copies (3.12).
- `scripts/docs/authoring.ts` (`npm run docs:authoring`, and `--check` in `npm run check`) uses the TypeScript
  compiler API over `@harness/sdk`'s public entry points (`index.ts`, `server/index.ts`): every exported value and
  type with its TSDoc, its signature printed by the checker, the members of each interface, and the core types they
  reach, followed by the template files verbatim, the fs contract as the worked reference, the list of mistakes
  that must not compile (read from `packages/sdk/typetests`), the `system.json` schema (from
  `SystemPackageManifest` with `z.toJSONSchema`), and the CLI commands. It writes **`packages/sdk/AUTHORING.md`**,
  one file, so it ships with the SDK like aeye's and ayepi's package docs. Generated sections are ordered by the
  path an author follows (contract → types → fns → kinds → context → server → ctx → client → packaging); the order
  is a list in the script, and an export the list doesn't place fails the script, so nothing new goes undocumented.
- fs gets a dynamic context item **`fs/system-authoring`** (`command: { name: 'new-system' }`, `fns: [write, edit,
  bash, read]`, `alwaysFor: []`), implemented in `systems/fs/server/authoring.ts`: its text is `AUTHORING.md`
  (resolved with `import.meta.resolve('@harness/sdk/AUTHORING.md')`) followed by where the template lives and the
  command that copies it. The chat agent reaches it through suggestions, `/new-system`, or the graph contextor.

**Checks.** `npm run docs:authoring -- --check` passes and fails when an SDK export changes without a rerun (a
unit test runs the generator over a fixture package). The template typechecks and `harness system build
systems/template` builds it. A live test: a free OpenRouter model given only `/new-system` and "make a system with
one fn that reverses text" produces a system that typechecks (marked live; it may retry twice).

### 3.2 Transcription and dictation models (hub-platform backend, web UI)

**Ask.** A way in the UI to choose which models and providers do transcription and dictation.

**Design.** **Model roles** (`ModelRole`: `chat`, `transcribe`, `dictate`, `speak`, `describe`, `ocr`), one
`ModelRoleRecord` per role (table `modelRoles`). Every role but dictation chooses a model (`ModelChoice`) and
optionally pins a configured provider; dictation chooses an engine: the browser's speech recognition (no model call)
or a model. `ModelRoles.resolve` picks the model and provider; without a record a role falls back to its env default
(`HARNESS_TRANSCRIBE_MODEL` for `transcribe` and a model-engine `dictate`, `HARNESS_DEFAULT_MODEL` for `chat`) or is
off. `ChatCapabilities.voiceInput` is true when `dictate` resolves; `ChatCapabilities.dictation` says which engine.
`contentSlice.transcribe` and every transcription the hub does (audio forms, dictation recordings) go through
`ModelGateway.forward({ modality: 'transcribe' })` with the role's model, each a `ModelCall`.

**UI.** `/admin/models` gains a **Roles** section: one row per role with a model picker (models from every
configured provider, filtered by capability: hearing for transcribe and dictate, speech for speak, vision for
describe and ocr), a provider pin, a language, and for dictation the engine switch. The composer's mic follows
`capabilities.dictation`. URL: `/admin/models?section=roles&role=dictate`.

**Checks.** Unit: role resolution order, capability filtering, `voiceInput` following the role, the transcribe
endpoint using the role's model and recording a `ModelCall`. ui-tests feature `model-roles`: set dictation to a
model, see the mic, set it to the browser.

### 3.3 Chat modes: strict tools and the static toolset (contextor)

**Ask.** Two modes to experiment with: today's strict tools, and a static toolset where results can expose fns,
loaded fns are shown at the end as instructions, signature and examples, and the model runs any fn with `run`.

**Design.** `ChatModeConfig` is chosen on the agent payload (`mode`, default `tools`) and overridden per session
(`Session.mode`, set with `updateSession`). Both modes implement `ChatMode`; `CHAT_MODES` is typed by
`ChatModeFactories`.

- **`tools`**: each selected fn at `signature` or `full` is a native tool (build 1's `fnTool`); `listed` fns are a
  `<more_fns>` list so the model can load them. With `plain` this is exactly build 1's request (golden test).
- **`static`**: five fixed tools: `find`, `inspect`, `load`, `unload` (hub fns `hub/find`, `hub/inspect`,
  `hub/load`, `hub/unload`, so they have policies, runs and metrics) and `run`, which is **not** a fn: `interpret`
  turns `run(fn, args)` into a run of `fn` itself (the tree, approval card and chat card show `fs/read`). Args are
  checked with the fn's gin type first; a failure or an unknown fn is an immediate `invalid-input` reply (`CallPlan`
  `invalid`) carrying the fn's card at `full` or the three nearest names. Loaded fns are **cards**, one renderer
  `fnCard(view, detail)` used by `inspect`, the reply and the prompt: `listed` is `name — description`, `signature`
  adds `run("fs/read", { … }) → { … }` from gin's `toCode()`, `full` adds instructions, `FnDecl.examples` and the
  `toCodeDefinition()` of each referenced type once per prompt. Cards go at the end of the system prompt
  (`placement: 'system-end'`) or in a trailing system message (`tail`).
- **Results expose fns.** `OutcomeWire.done.expose` (`ctx.expose(ref, detail)` in the SDK): the reply ends with the
  cards, and the fns get a `used` boost so they stay near the top next iteration. `hub/find` exposes its hits at
  `listed`, `hub/inspect` at the asked detail.
- **Text protocol** (`protocol: 'text'`, or `auto` for a model without aeye's `tools` capability, as
  `deepseek-r1:7b` on Ollama): no tools are sent; the instructions explain `<run fn="…">{…}</run>`. The stream is
  watched for `<run`: prose streams to the chat, the block is held, and `parseRunBlocks` parses it at the end; each
  block is a run with a synthetic call id, its result goes back as `<result fn="…" status="…">…</result>`.
- **Fleets**: for a system with more than one connected instance, `run` takes `on` (`run fs/read on=laptop`) and
  native tools get an `on` enum (3.14).

**Checks** (contextor research §10 is the full list): `tools` + `plain` sends build 1's request byte for byte;
`static` sends exactly five tools; `run` makes a run of the named fn with its policy; bad args give an invalid-input
reply with the card and no fn run; `load` shows the card next iteration; `expose` appends cards; the text protocol
turns blocks into runs and never streams a block; `CHAT_MODES` fails to compile without a factory for a new variant
(typetest). Live: `deepseek-r1:7b` (text protocol) answers "how many lines does README.md have?" through a
`<run>` block; a free OpenRouter model with `static` + `graph` and native tools does the same.

### 3.4 The graph contextor and small-context budgets (contextor)

**Ask.** A contextor where the full conversation is not sent: each message starts a new prompt with the relevant
history rebuilt and the likely related context and fns in the system prompt, chosen by weights; aware of the
model's context and output limits so it never sends too much to a small model.

**Design.** As the contextor research §6 and §7, with these decisions:

- **Limits** resolve per field: an admin's `ModelLimitsRecord` → a provider probe (Ollama `/api/show`: `num_ctx` from
  the Modelfile parameters, else `HARNESS_OLLAMA_DEFAULT_CTX`, never the trained length) cached
  `HARNESS_MODEL_PROBE_TTL` → aeye `ModelInfo` → `HARNESS_DEFAULT_CONTEXT_WINDOW` / `HARNESS_DEFAULT_MAX_OUTPUT`.
  Reasoning models reserve half their output for thinking unless set. `ModelLimitsView.sources` says where each
  came from.
- **Tokens**: `est = ceil(chars / charsPerToken) + 4` per message, times the model's calibration ratio (EMA 0.2 of
  measured over estimated input, clamped 0.7–1.6, starting 1.1), kept in `modelCalibration`. Context sizes are kept
  on the record (`ContextRecord.tokens`), fn card sizes cached by fn version and detail.
- **Budget**: `B = W − O − M` with `M = max(64, ⌈HARNESS_PROMPT_MARGIN · W⌉)`; the fixed part (instructions, the
  mode's tools, the current turn) is charged first; the rest is shared by history, context and fns by
  water-filling over `GraphContextor.shares`. When even the fixed part won't fit, the planner trims in order
  (suggestion blocks, old tool results of the turn, the newest tool result) and finally refuses with a plain message
  naming both numbers. `maxTokens` and `contextWindow` are set on every request; aeye's `forget` must never fire (a
  test spies on it; it logs `agent.forget` if it does).
- **Graph cycle** (once per user message, or per iteration): a bounded pool (always-items, loaded items, last
  selection, `HARNESS_GRAPH_POOL` hybrid hits for context and fns, half as many older exchanges of the session, one
  hop of neighbours); base score `w(c) · Σ W_m · rbf(f_m(c), t_m, k_m) / Σ W_m` over the `GRAPH_METRICS` that have a
  signal; spread over links with damping and hops (out-weights normalised); units (an item with its hard links);
  greedy upgrades `none → listed → signature → full` by value per token into each pool, ties to last cycle's items;
  history as exchanges, the floor charged (not free), the contiguous recent tail linear, older selected exchanges as
  `<earlier>` summaries without a model call. The selection is cached on the run's resume per user message, so a
  retried job sends the same prompt.
- **Loaded items** (`session.tools`, `session.context`) are forced at `signature` (fns) / `full` (context) for
  `HARNESS_LOADED_TURNS` turns after their last use, then compete with a `used` boost: that is the LRU the owner
  doesn't want to ask the model for.
- **Every contextor** is budgeted: `plain` trims oldest exchanges (and reports it) instead of letting a provider cut;
  `suggest` is build 1's suggestion blocks plus `autoInject` in tokens.
- **What the owner sees**: `LlmInteraction.selection` (`SelectionReport` with its `BudgetReport`) in the run
  inspector ("4,096 window: 1,024 reply, 246 margin, 612 fixed, 1,230 history, 640 context, 344 fns"), and
  `previewSelection` from the session settings ("what would this message get?").
- **Where it plugs in**: `HubAgentLoop.#iterate` calls `hub.contextor.planner.plan` after the model is resolved and
  `interpret` for each call; `#tools` and `#context` move into the `tools` mode and the `plain` contextor. The
  enricher skips suggestion blocks in graph mode; a `/command` forces its item for the turn.

**Checks**: the research's pure-part tests (tokens, budget, score, choose — including the 500-case seeded property
that the chosen total never exceeds `R` and no fitting upgrade is left — history, render, `linksOf`), and the loop
tests (window 2048 / output 256 with a 60-exchange transcript: every request ≤ `B`, `forget` never runs, the report
saved; a message larger than `B` fails with the plain message). Live (`ollama pull qwen2.5:3b`, window 4096 /
output 512): 40 seeded items and a 30-exchange session, five messages, every request's estimate ≤ `B`, Ollama's
`prompt_eval_count` ≤ 3584, and the one item that answers the question is selected.

### 3.5 Context links (contextor; resources writes resource and memory edges)

**Ask.** Does context link to other context or fns? Context can be skills, memory, from a resource, injected into
an llm kind by name, loadable with `/command`, and can pull in fns.

**Design.** Yes: context is a graph (decided). `ContextRecord` is the one record for every origin (`origin`:
`system`, `memory`, `resource`); `ContextLink` edges (table `contextLinks`, key `from` + `toKey` + `relation`) point
at context, fns, types or resources. The owner's words map to fields: skill = `fns` (`brings`) and `imports`;
memory = `origin.memory`, names `memory/…`; from a resource = `origin.resource`, names `resource/…`; injected into an
llm kind by name = `alwaysFor`; `/command` = `command`; pulls in fns = `fns` (hard) and `suggestFns` (soft,
`suggests`). Edge sources: `declared` and `mentioned` (derived from the record by one pure `linksOf(record)` and
rewritten by `ContextGraph.derive` in the same write the catalog makes), `resource` (3.6), `learned` (co-use per
turn, `weight = 0.6(1 − e^(−n/4))`, halving every `HARNESS_LINK_HALF_LIFE`), `authored` (a person, in the context
view). `memory` and `resource` are reserved system names (`isReservedSystemName`; pairing refuses them).

**Checks**: `linksOf` maps every field to its relation and weight; changing a decl rewrites exactly its derived
edges; learned weights follow the formula and decay; the graph contextor brings a skill's fn card without the fn
matching the query. ui-tests feature `context-graph`: open a context item, see its links both ways, add one.

### 3.6 Raw and converted storage, forms, resource to context (resources)

**Ask.** Raw data stored in the hub's files or optionally its database; converted data for LLMs (markdown, or
structured tables for spreadsheets); both viewable; sectioning uses the converted form by default; converting a
resource to context.

**Design.**

- **Raw** goes in the content store (`ContentStore` over an ayepi `FileStore`, content-addressed, presigned
  downloads with Range): files by default, the hub's SQLite database when `HARNESS_CONTENT_AT=database` (a
  `SqliteFiles implements FileStore` over the hub's connection, table `content_blobs` with a BLOB column, kept
  outside `HUB_TABLES` because it is a file store, not a record table; recorded as an `@ayepi/sqlite` ask). Hub
  resources (`hub://resources/…`) live only there; system resources keep a snapshot evicted by total bytes
  (`HARNESS_SNAPSHOT_MAX`) while their forms stay. fs returns `bytes` (a content ref) for every file up to the
  import cap, and its text as a form for text and code.
- **Forms** (`FormRecord`, table `forms`, key raw hash + kind + converter): converted versions come from one shared
  `@aeye/resources` registry (`createDefaultResourceRegistry`, `registry.convert`), stored as the library's
  `ResourceVersion` JSON (`CONVERTED_VERSION_MIME`) so `ConvertedVersion.parse` reads them back; model-made forms
  (`description`, `ocr`, `transcript`, `thumbnail`) go through the hub provider with the role's model (3.2) as a
  `ModelCall`, made on demand (or while indexing with `HARNESS_DESCRIBE_ON_INDEX`). One job per key on
  `@ayepi/work` (`HARNESS_FORM_CONCURRENCY`), so two readers never pay twice. `ResourceRecord.forms` and `.primary`
  keep the browser's badges current; `UserEvent` `resource` announces a new form.
- **Primary form** by family: markdown for html, docx and pptx; `table` for spreadsheets and csv; `pages` for pdf;
  the text itself for text and code; description + ocr for images; transcript for audio and video.
- **Sectioning reads the primary form** (`Section.form`): the hub's sectioners run over its text, `hub/headings`
  works on web pages, `hub/pages` on the library's `\f` page breaks, and a new **`hub/tables`** sectioner gives one
  section per table (large tables in row groups with the header repeated), keys from structure
  (`registry.sectionVersion`). A user's section rule may choose the form (`SectionMatch.form`).
- **Context from a resource** (`ContextLibrary.fromResource`, hub fn `hub/context_from_resource`, endpoint
  `contextFromResource`, a button in the viewer): one item per section (a `next` chain above
  `HARNESS_CONTEXT_PIECE_TOKENS`), a resource-level parent holding the outline, `about` links to the resource,
  `related` links to context of linked resources, names from the uri and section key so a rerun updates; `live`
  items read the current section on load, `snapshot` items keep their text and turn stale on a section diff.
  **Memory** (`hub/remember`, `hub/forget`) writes `memory/…` items with `about` links; writing to `user` or
  `everyone` scope asks the person (not read-tagged).
- **Resource → message content** (`MessageContent.parts`): per part and model-aware, never failing (resources
  research §8).
- The hub's own root `hub://resources/` is a local provider in the resource router (`link/resources.ts`).

**Checks**: both stores pass one `FileStore` contract suite; the same bytes at two URIs convert once; a converter
version change reconverts only its forms; an html page sections over its markdown; a two-sheet workbook gives one
section per table; context from a three-heading markdown file gives three items, a parent, `next` order and `about`
links, and a rerun updates; a changed section marks its live context stale and leaves snapshots alone; an image
attached for a text-only model is described once and sent as text.

### 3.7 The web system (web-system)

**Ask.** A web system with Tavily search, pulling down a URL, rendering script-built HTML with puppeteer and
extracting it; `@aeye/resources` handles turning http data into resources.

**Design.** `systems/web` in the build 2 folder layout, its own process (Chromium never runs in the hub).

- Contract `web`: config `{ tavilyKey: secret text, render: 'auto' | 'always' | 'never', allowPrivate: bool,
  maxBytes: num, timeout: duration }`.
  - **`web/search`** (`read`): `{ query, limit?, depth?: 'basic' | 'advanced', topic?: 'general' | 'news', days?,
    include?: text[], exclude?: text[] }` → `{ answer?, results: { title, url, snippet, score, published? }[] }`
    through `@tavily/core`.
  - **`web/read`** (`read`): `{ url, render?, maxChars? }` → `{ uri, title, finalUrl, text, truncated, rendered }`:
    imports the page as a hub resource (dep `hub/resource_import`) and reads its primary form (dep
    `hub/resource_read`), so the LLM gets clean markdown and the page is kept.
  - **`web/fetch_raw`** (visibility `none`, used by the hub's `ResourceLibrary.import` for URLs when the web system
    is connected): `{ url, render? }` → `{ content: ContentRef, mime, finalUrl, status, rendered, title? }`.
- Fetching is `@aeye/resources`' `fetchResource` (type detection, charset, redirects, byte cap, timeout, injectable
  `fetch`) with **`PuppeteerRenderer implements PageRenderer`** (one shared browser, a page per fetch with bounded
  concurrency, `networkidle2` with a cap, images, fonts and media blocked) under `render: 'auto'`
  (`looksScriptRendered`). Private and loopback addresses are refused unless `allowPrivate`. Credential-bearing
  query parameters are stripped from names and titles.
- The hub converts (resources lane) with its shared registry; the web system only fetches and renders.
- Renderers (`client/`): a search results card (title, domain, snippet, open) and a page card (title, final URL,
  rendered badge, a `ResourceViewer` compact preview).

**Checks**: unit tests with an injected `fetch` and a fake renderer (auto renders an empty app root, keeps a plain
page, refuses `127.0.0.1`), search shaping over a recorded Tavily response; one live Tavily test and one live
render test (marked). `npm run dev` gains `web` in `HARNESS_DEV_ONLY` when `TAVILY_API_KEY` is set.

### 3.8 The resource browser: groups, folders and thumbnails (web; facets by resources)

**Ask.** Ways to look at resources that group and folder them automatically, besides the plain list or thumbnails.

**Design.** A top-level **`/resources`** page (and the admin link goes there), everything in the URL:
`?view=list|grid|groups&group=type|source|path|date&in=&under=&q=&system=&family=&form=&missing=&uri=&mode=`.
List (sortable, a two-line row on phones), grid (thumbnail form, else the image itself lazily, else a type glyph
with the first lines; size slider), groups (collapsible sections with counts from `ResourcePage.facets`; "show
all" narrows with `in`), a folder tree rail for `group=path`. Filters, bulk select and the action menu (open,
download, rename and delete for hub resources, make context, describe or transcribe, re-fetch, reprocess, copy URI,
run a fn on it). The uploader takes files, a pasted image or a URL (`importResource`). Grouping keys come from one
place: `familyOf` and `FORMAT_FAMILY` in core, used by the hub's facets and the web's icons and viewers.

**Checks**: unit tests of the URL state, grouping and facet merging; ui-tests feature `resource-browser` at every
layout, light and dark: each view, each grouping, the tree, a filter, an upload.

### 3.9 Viewers for every common type (web)

**Ask.** See images, syntax-highlighted code, markdown and mermaid, and a preview mode for some types.

**Design.** The resources research §11 table is the spec: `viewerFor(stat, forms)` (pure, one table) picks the
viewer and its modes; the panel shows a mode switch (`Preview` / `Source`, then one tab per form, then Info), in the
URL (`mode=`). Shiki (fine-grained core, JS regex engine, grammars loaded lazily, `codeToTokens` drawn as spans so
nothing is HTML, the `css-variables` theme mapped to design tokens) behind `highlight(code, language)`; mermaid
lazily with `securityLevel: 'strict'` and the theme following light/dark; `pdfjs-dist` lazily with page numbers in
the URL; sandboxed `<iframe sandbox srcdoc>` for html; svg as `<img>` from a blob URL; a table grid from the
`table` form with paging through `readResource`; a JSON tree; audio and video with transcripts. `ResourceViewer`
replaces `chat/components/ResourceView.vue` and is provided under `RESOURCE_VIEWER` (compact mode for cards).
Code lives in `packages/web/src/resources/` (`logic/`, `state/`, `api/`, `viewers/`).

**Checks**: unit tests of `viewerFor` and the mode lists; component tests in happy-dom; ui-tests feature
`viewers`: open a fixture of each type, switch modes, at every layout in light and dark.

### 3.10 QR pairing (packaging hub side; sdk display; web page)

**Ask.** A system started with a hub URL prints a QR code; scanning opens the hub, where the admin sets config and
finishes pairing.

**Design.** After `hello` answers `pairing`, the SDK sends `pairingInfo` (description, instance, config type) and
shows the pairing through an injected `PairingDisplay`: `TerminalPairingDisplay` prints a UTF-8 QR of the URL
(`qrcode`, `toString(url, { type: 'terminal', small: true })`) and the code in large text, when
`HARNESS_PAIRING_QR=auto` (a TTY) or `always`; a log-only display otherwise. The URL is **`/pair/:pairing?code=`**,
built from `HARNESS_PUBLIC_URL` when set, else from the `Host` the system used to reach `/link` (never a guessed
name). The page (web lane, phone-first; signs in first and comes back) shows the system, instance (editable),
version, address, key fingerprint, expiry, and the config form from `configType` with the gin value editor (3.15);
**Pair** calls `approvePairing { approve, instance, config }`: the hub checks the config, pairs, presets the config
and tells the socket `paired`; the system's welcome carries the config, so it is usable in one step. The page then
follows the system live to connected and links to its admin page. `packagingSlice.pairing` loads it.

**Checks**: SDK: the display is called with the URL and code, QR text only on a TTY; hub: `pairingInfo` refused
from another socket, approval with an invalid config refused, the welcome carrying the config; ui-tests feature
`qr-pairing`: open the URL, fill config, pair, see connected.

### 3.11 Hub MCPs (hub-platform; web UI)

**Ask.** Admin-made MCP endpoints with their own routes and private auth, and include/exclude control over systems,
fns, types, context and resources, so (for example) a Claude system's sessions get an MCP into the hub.

**Design.** As the MCP research §1, with `@ayepi/mcp`'s new pieces: `McpRouter` mounted at `/mcp` on the hub's
HTTP front (`MCP_PATH`), one `mcpSourceServer` per enabled MCP rebuilt when its record changes, an authorizer that
accepts the endpoint secret (`hmcp_…`, looked up by sha-256 digest, `HubMcp.secretDigest`) or a session token
(`McpTokenClaims`, an `@ayepi/auth` JWT minted by `hub/mint_mcp_token` for grantee systems), the caller info
(`McpCaller`) labelling runs, tool annotations from fn tags (`read` → `readOnlyHint`), and `notifications/cancelled`
cancelling the run. Scope resolution is live on every list and call (`McpScopes`): `admin`-tagged fns are never
exposed; a type an exposed fn needs is exposed (and a warning when excluded); context brings only exposed fns.
`toolMode: 'each'` names tools `<system>_<local>` (one shared helper with the system MCP face); `static` serves the
chat's static toolset scoped to the MCP. Runs: `user` = the MCP's person, `caller` = its `mcp` actor (policies can
target `{ kind: 'mcp' }`), priority interactive. Outcome mapping and the approval wait as the research's table.
Admin fns for every `mcpsSlice` write (tagged `admin`). Rate per MCP with `@ayepi/rate` (`HARNESS_HUB_MCP_RATE`).
The CLI's `harness mcp <slug>` is the stdio bridge (3.12).

**UI.** `/admin/mcps` (list: name, route, enabled, sessions now, calls today) and
`/admin/mcps/:id/(rules|preview|connect|activity)`: the rules editor (include and exclude selector editors with
pickers fed by the catalog), the live preview beside it on wide screens and below on phones, connect snippets
(`claude mcp add --transport http …` and `.mcp.json`), activity (runs filtered to the MCP's actor). The secret is
shown once in a dialog with copy.

**Checks**: scope tables (include/exclude, closure, admin tag, a listed-then-hidden tool refused at call); the
server over `McpMemoryClientTransport` against a fake run service: done, invalid input, failed, approval wait and
timeout, cancel on abort, `list_changed` after a catalog change, bad bearer, rotated secret, expired token. One live
e2e (`McpClient` → a hub MCP → `fs/read` on one of two fs instances), ports 4460+, data `.harness-test/hub-platform`.

### 3.12 System packages, data, CLI (packaging; sdk checks; fs and embedder adopt it)

**Ask.** Where systems keep their data, how portable that is, a standard folder for server, client, data and config
that can be zipped and installed, and commands to build and pack systems to run alongside the hub.

**Design.** As the MCP research §2, decided:

- A system folder: `system.json` (`SystemPackageManifest`, the one source of a system's name, version, entries,
  instances), `package.json` (dev only), `shared/`, `server/`, `client/`, `dist/` (what is packed). The contract's
  name must equal `system.json`'s (`harness system build` and `serve()` check). `Installer.describe` reads
  `system.json`; `SystemPackageJson` (the `harness` block in `package.json`) goes.
- **Config lives in the hub DB** (per instance, `InstanceRecord.config`), never in a file. **Data**: the hub gives
  each installed instance `<HARNESS_DATA>/systems/<name>/instances/<instance>/{state,data,cache}` outside
  `versions/<version>/`, so upgrades and rollbacks keep it; the SDK exposes `ctx.dataDir`, `ctx.cacheDir` and
  `ctx.instance` (`SYSTEM_ENV.data`, `.cache`, `.instance`; outside the hub they default to
  `.harness/systems/<name>/<instance>/…`). What a system stores in `data` is its own business; portability comes
  from the folder being known. fs moves its snapshots to `dataDir` and its client build to `cacheDir`.
- **Export**: `exportSystemData` asks the instance to quiesce (`systemLinkSpec.export`, the SDK runs a new
  `lifecycle.exporting`), zips `data/`, `config.json` (secret fields only with `withSecrets`, confirmed) and
  `export.json` (`SystemDataExport`), and returns a content ref; `harness system install --data <zip>` restores.
- **Zip install**: `installPackage { zip }` (uploaded with `upload`): unzip to staging (`fflate`), parse
  `system.json`, check `format`, `protocol` and every file hash, refuse paths that leave the folder, refuse an
  installed name (upgrade is `upgradeSystem`) unless it adds an instance, `npm install` only `server.external`,
  place under `versions/<version>`, pair with a hub-made key, preset config, start. The install dialog gets a drop
  zone (web lane) and says a package is code that runs as the hub's user.
- **`packages/cli`** (`@harness/cli`, `bin: harness`), `node:util` `parseArgs` checked with one zod schema per
  command, each command a class implementing `CliCommand` with injected io (hub client, files, cwd):
  `system new <name>` (copies `systems/template`, fills the name), `system build [dir]` (typecheck, name check,
  Vite SSR bundle of `server/main.ts` with only `server.external` left out, `buildClient` for `client/`,
  `dist/system.json` with built entries), `system pack [dir]` (builds if stale, hashes into `files`, zips `dist/`
  to `<name>-<version>.zip`), `system install <zip|dir|npm> [--config] [--instance] [--data]`, `system
  export-data <name> [--instance] [--out]`, `system list|start|stop|upgrade|uninstall`, `mcp <slug>` (stdio ↔ HTTP
  bridge with `McpClient` and `serveStdio`). It signs in with `--token`, `HARNESS_TOKEN`, or the admin from `.env`
  (`scripts/hub-client.ts` moves here; scripts import it from the CLI).

**Checks**: pack → install round trip; a tampered file refused; a path escape refused; export → restore round trip;
every command unit-tested with fake io; the fs and embedder systems build and pack with the CLI and install from
the zip in the e2e restart suite.

### 3.13 Invalid input versus errors (hub-platform; contextor for static `run`; sdk; web)

**Ask.** Tell an LLM's tool-call mistakes (bad JSON, schema, failed validation) from real errors, and show them
differently.

**Design (M1 done).** `invalid-input` is a run status and an outcome (`InvalidInput`: `source` `json` | `schema` |
`validation`, `problems` by path, `raw`). The hub makes it when a tool call's arguments don't parse or don't fit the
fn's gin type (tools mode: before the fn runs, the run is created and settles `invalid-input` at once; static mode:
`CallPlan` `invalid`); a fn makes it with `ctx.invalid(problems)`. The agent gets the problems (and in static mode
the fn's card) as the tool reply and retries; it does **not** count toward `HARNESS_TURN_ERRORS`. A code caller
hears `failed` with `code: INVALID_INPUT_CODE`, class `caller` and the `InvalidInput` as data. The chat shows such a
run softly ("Retried", neutral tone, collapsed), never as a failure; the run inspector shows the problems. Metrics
count it apart (`OutcomeCounts`, `FnStats.outcomes['invalid-input']`).

**Checks**: a tool call with bad JSON, one with a wrong type and one refused by `ctx.invalid` each settle
`invalid-input`, feed the problems back and don't stop the turn; `failed` still does; the web shows the soft row
(component test) and ui-tests feature `invalid-input` with a scripted model.

### 3.14 Fleets: many fs instances (packaging; sdk; contextor for `on` in tools; hub-platform for routing calls)

**Ask.** Several fs instances attached at once.

**Design.** As the MCP research §4: one system, many instances (`InstanceName`, `InstanceRef`, `InstanceRecord`
keyed `[system, instance]`); `system.json` `instances: 'many'` for fs. M2 renames the per-process nonce to `boot`
and adds `Hello.instance`. A second connection replaces only its own instance. Pairing, config, status and installed
systems move to instance keys (`instances` table; `SystemRecord` keeps the per-system facts). A run's instance is a
hub-owned option, never an fn arg: `ctx.call(ref, args, { on })` in the SDK; an `on` property added to tool schemas
(and `run … on=`) when a system has more than one connected instance, stripped before checking args; otherwise the
hub picks the instance a resource URI in the args belongs to (`file://<instance>/…`, the SDK's `fileUri`), the
session's pinned instance (`/on laptop`), the system's default instance, or the only connected one, else
`invalid-input` "fs has several machines: say on=laptop or on=desk". The link module answers the pick
(`InstanceRouter` in `link/index.ts`, packaging) and the run service asks it once per run (hub-platform, one call
site). Mentions and dynamic context ask every connected instance and label options by instance.

**UI**: `/admin/systems/:system` lists instances; `/admin/systems/:system/instances/:instance` is one (config,
process, logs, data export, remove); run chips read `fs/read · laptop`; the resource browser's `source` grouping
splits by instance.

**Checks**: two fs instances connected at once; reads routed by `on`, by URI host and by session pin; the ambiguous
case `invalid-input`; a replaced connection replaces only its instance; e2e with two fs processes (ports 4420+).

### 3.15 Gin type, expression and value editors and viewers (web; sdk for system components)

**Ask.** A type editor/viewer, an expression editor/viewer and a value editor/viewer, each one component that
edits or views by a flag; systems add types and custom components to render them.

**Design.** `packages/web/src/gin/`: `GinTypeView.vue` (a `GinTypeDef`: tree of the type with its options,
constraints and docs; editing adds, removes and changes fields, kinds and options, checked live with the registry),
`GinExprView.vue` (a `GinExprDef`: the expression as readable code with an editor for each node kind gin has,
`typeOf` showing the result type), `GinValueView.vue` (a value of a type: the existing `chat/forms` inputs moved
here and extended, so every gin type has an editor and a viewer). Each takes `modelValue` and `readonly`; one
registry (`gin/registry.ts`) maps type names to components, so a system's component for its named type
(`client({ inputs })`, whose props gain `readonly`) is used everywhere a value of that type is drawn: forms, run
cards' args and results, mention cards, the pairing config form, the MCP rules editor's `FnMatch.when`. State and
gin calls are in `gin/state.ts` and `gin/logic/`, components only draw. The design page (`/design`) shows all three
in both modes.

**Checks**: unit tests of the registry fallback (system component, then built-in, then JSON), round trips
(edit → value parses with gin); component tests for each type kind in both modes; ui-tests feature `gin-editors`.

### 3.16 Every model call tracked (hub-platform; sdk forwarding provider)

**Ask.** All model calls from systems go through the hub and are recorded, chat or not (images, embeddings,
audio), with enough detail for performance.

**Design (decided: not a fn kind).** One `ModelCall` record per call of any modality (table `modelCalls`), written by
`ModelCallLog` around every provider call: the chat gateway (`LlmGateway`, beside its `LlmInteraction`, which gains
`modelCall`), `ModelGateway.forward` for the `model` link endpoint, embeddings the index makes through a provider,
forms, transcription and dictation. Attributed to the run (and turn, session, system, fn) or, for the hub's own
work, a `purpose`; the ledger line points at it. The SDK's `HarnessProvider` implements aeye's embed, image,
transcribe and speech capabilities over `model` (`ctx.llm.image|transcribe|speak`), so nothing a system does reaches
a provider directly. Admin's **Model calls** page (`/admin/model-calls`, replacing LLM calls, with a modality filter;
a chat call opens its interaction) and the run inspector list them.

**Checks**: a forwarded embed, image, transcription and speech each make one record with units, cost and timings
(fake provider); a chat call makes a record and an interaction pointing at each other; the ledger refers to it.

### 3.17 Systems add resource views (sdk; web)

**Design.** `client({ resources: { <format>: Component | { component, mode: 'replace' | 'tab', label } } })`:
`replace` draws instead of the hub's preview for that format; `tab` adds a mode beside the hub's. `ResourceView`
props gain `forms` and `text(form?)`. The web's `viewerFor` merges system viewers by format.

**Checks**: a test system's `tab` viewer appears as a mode beside Source; a `replace` viewer replaces the preview.

### 3.18 Fn metrics (hub-platform; web)

**Design (decided).** Every run records queue wait (created to started, without approval), approval wait
(`Run.approvedAt`), run time, cost, tokens, outcome, retries; `FnMetricsService.settled` folds each settled run into
its fn's day (`FnMetricsDay`, table `fnMetrics`) with histograms over `DURATION_BUCKETS`; rollups give p50 / p95.
`FnRecord.stats` gains the new fields; the `fn` user event carries them. `hub/fn_metrics` gives them to the LLM. The
admin fn pages show a metrics strip and a per-day chart (follow the dataviz rules: one accent, light and dark).

**Checks**: folding is idempotent per run; percentiles from histograms within one bucket; ui-tests feature
`fn-metrics`.

### 3.19 Systems add type inputs (sdk; web)

**Design.** `client({ inputs: { <Type>: Component } })` (existing) with `InputView.readonly`, so one component is
the editor and the viewer; the gin registry (3.15) uses it everywhere values of the type are drawn.

**Checks**: the fs `Entry` input draws in a `!` form and, read-only, in a run card.

### 3.20 Hub fns for everything (sdk declares; each owner implements)

**Ask.** Systems call hub fns for resources and context, and the chat LLM can do and see everything.

**Design.** Section 4 is the list. Read fns mirror web endpoints through one map (`HUB_READ_ENDPOINTS`, like
`ADMIN_ENDPOINTS`): the fn's args and result **are** the endpoint's body and response, and the fn runs the same
operation as the handler, as the run's person. New admin writes join `ADMIN_ENDPOINTS` (tagged `admin`). Each
module registers its fns from its own file (`contextor/fns.ts`, `resources/fns.ts`, `mcp/fns.ts`,
`metrics/fns.ts`, `models/fns.ts`); `boot/hub-fns.ts` composes them.

**Checks**: a test that every fn in the hub contract is registered after boot; every read fn tagged `read`; every
admin fn tagged `admin` and refused for a member.

### Carry-overs from build 1

| # | Item | Lane | Design | Check |
|---|---|---|---|---|
| C1 | Auto-load fns named in a message (`fs/bash`) | contextor | the enricher finds qualified fn names (and `@` fn mentions) in the user's text and forces them at `signature` for the turn (tools: into the turn's tools; static: as cards) | a free model answers "run fs/bash ls" with the tool |
| C2 | Retry catch-up calls after a reconnect | web | the connection store retries each catch-up (session, messages, waiting, runs) with backoff until it succeeds, and marks the view stale meanwhile | a test drops the socket mid catch-up and the missed run shows |
| C3 | Mock-hub fixtures checked against their schemas | web | every fixture is `satisfies z.input<typeof Schema>` (Session, Run, Notification, …); no loose objects | typecheck fails when a schema changes |
| C4 | Mock hub logs 500 for `/signIn` | web | the mock's logger records the real status | the mock test sees 200 and 401 |
| C5 | Library asks | — | binary ws frames (ayepi core): still open, recorded; web push: `@ayepi/push` exists now, hub-platform replaces `web-push` with it; folder resolver: done in `@aeye/resources` (`folderResolver`), not used yet: fs's own listings stand in (see §10) | `web-push` removed from dependencies |

---

## 4. The hub fn surface

Every fn is declared in the hub contract (`packages/sdk/src/hub.ts`, sdk lane, step S1) with args and returns from
the core schema or endpoint named, and implemented by the lane named. Tags: **R** `read`, **A** `admin` (never
exposed through a hub MCP; asks unless a policy allows), none = asks the person unless a policy allows.

| Fn | Args → result (source of truth) | Tags | Implemented by |
|---|---|---|---|
| `hub/find` | `{ query, kinds?, limit? }` → hits with `loaded` flags | R | contextor |
| `hub/inspect` | `{ name, detail? }` → the item's card or text | R | contextor |
| `hub/load`, `hub/unload` | `{ names, detail? }` → loaded / refused | R | contextor |
| `hub/resource_list` | `ResourceQuery` → `ResourcePage` (`browseResources`) | R | resources |
| `hub/resource_read` | `ResourceReadArgs` → `ResourceReadResult` (`readResource`) | R | resources |
| `hub/resource_outline` | `{ uri }` → `Section[]` | R | resources |
| `hub/resource_convert` | `{ uri, kind }` → `FormRecord` (`convertResource`) | — (may spend) | resources |
| `hub/resource_import` | `ResourceImportArgs` → `ResourceRecord` (`importResource`) | — | resources |
| `hub/resource_send` | `{ uri }` → parts shown to the model next step | R | resources |
| `hub/resource_rename`, `hub/resource_delete` | `renameResource`, `deleteResource` | — | resources |
| `hub/context_get` | `{ name }` → `ContextItemView` (`contextItem`) | R | resources |
| `hub/context_from_resource` | `ContextFromResourceArgs` → `ContextFromResourceResult` | — | resources |
| `hub/remember`, `hub/forget` | `RememberArgs` → `{ name }`; `{ name }` → `{ ok }` | — | resources |
| `hub/types_get` | `chatSlice.types` | R | hub-platform |
| `hub/runs_list`, `hub/run_get`, `hub/run_tree`, `hub/llm_call` | `adminSlice.runs` (the person's own runs for members), `runsSlice.run`, `.tree`, `.llmCall` | R | hub-platform |
| `hub/model_calls` | `metricsSlice.modelCalls` | R | hub-platform |
| `hub/fn_metrics` | `metricsSlice.fnMetrics` | R | hub-platform |
| `hub/sessions_list`, `hub/session_messages` | `chatSlice.sessions`, `.messages` | R | hub-platform |
| `hub/systems_list`, `hub/system_get`, `hub/system_fns`, `hub/system_logs` | `systemsSlice.systems`, `.system`, `adminSlice.systemFns`, `.systemLogs` | R | hub-platform |
| `hub/model_roles`, `hub/model_limits` | `modelsSlice.modelRoles`, `contextorSlice.modelLimits` | R | hub-platform, contextor |
| `hub/set_model_role`, `hub/clear_model_role` | `modelsSlice` writes | A | hub-platform |
| `hub/set_model_limits` | `contextorSlice.setModelLimits` | A | contextor |
| `hub/create_mcp`, `hub/update_mcp`, `hub/rotate_mcp_secret`, `hub/delete_mcp`, `hub/preview_mcp` | `mcpsSlice` | A | hub-platform |
| `hub/mint_mcp_token` | `{ mcp, label, ttl? }` → `{ token, expiresAt }`; callable only by a grantee system's runs | A | hub-platform |
| `hub/install_package`, `hub/remove_instance`, `hub/export_system_data` | `packagingSlice` writes | A | packaging |
| existing build 1 fns | unchanged (`search_*`, `load_*`, `drop_fns`, `run_status`, `run_wait`, `ask_user`, the admin fns, which gain the `admin` tag) | | as before |

Sectioner: `hub/tables` (resources). The `hub/chat` agent keeps its tools list; a second agent fn
**`hub/chat_small`** (`static` + `graph`, for small local models) is added by the contextor lane so both modes can
be picked from the agent picker without editing payloads.

---

## 5. The UI (web)

Every page and panel is tied to the URL; state and callers live in `state/` and `api/` files, components only draw;
calm modern look, light and dark, responsive with no overlap, following `packages/web/src/ui`.

| Route | What |
|---|---|
| `/resources` | the browser (3.8) with the viewer panel (3.9) |
| `/context`, `/context/:name` | every context item (filters by origin and system), one item: text, links both ways, add or remove a link, edit or forget memory, "make context from…" |
| `/pair/:pairing` | QR pairing (3.10) |
| `/admin/models` | providers and models (exists) + **Roles** (3.2) + **Limits** per model (window, output, reasoning, chars per token, with sources) |
| `/admin/model-calls`, `/admin/model-calls/:id` | every model call (3.16) |
| `/admin/mcps`, `/admin/mcps/:id/(rules\|preview\|connect\|activity)` | hub MCPs (3.11) |
| `/admin/systems/:system/instances/:instance` | one instance (3.14) |
| `/admin/systems/:system/fns/:fn` | a fn with its metrics (3.18) |
| chat session settings | mode and contextor pickers (each config's fields from its gin type with the value editor), "preview this message" (`previewSelection`) |
| run inspector | the selection and budget report; invalid-input problems; model calls of the run |
| run rows | `invalid-input` soft ("Retried"); instance on chips; static-mode runs show the real fn |
| `/design` | the gin editors and viewers in both modes, the new viewers |

ui-tests features (one script each, every layout, light and dark): `model-roles`, `chat-modes`, `context-graph`,
`resource-browser`, `viewers`, `qr-pairing`, `hub-mcps`, `fn-metrics`, `model-calls`, `invalid-input`,
`gin-editors`, `instances`.

---

## 6. Tests and the gate

- Unit tests beside the code, injected seams, no network; random cases from a seeded generator in a test helper.
- Live tests marked `*.live.test.ts`, minimal: Ollama (qwen2.5:3b pulled by the contextor lane; deepseek-r1:7b for
  the text protocol), one free OpenRouter model, Tavily, a puppeteer render, the embedder.
- e2e (`e2e/`): the existing suite stays green; new files: `mcp.e2e.test.ts` (hub-platform), `fleet.e2e.test.ts`
  and `package.e2e.test.ts` (packaging), `resources.e2e.test.ts` (resources: upload a pdf and a workbook, see forms,
  make context), `contextor.e2e.test.ts` (contextor: static + graph on a free model).
- The gate before the phase commit: `npm run check:full` and `npm run ui-tests` for the new features against a
  fresh stack.

---

## 7. Dependencies to install

| Lane | Package | Where | Why |
|---|---|---|---|
| packaging | `fflate` | `@harness/hub`, `@harness/cli` | zip and unzip, pure JS |
| packaging | new workspace `packages/cli` (`@harness/cli`: `@harness/core`, `@harness/sdk`, `@ayepi/core`, `@ayepi/mcp`, `vite`, `zod`) | root `workspaces` | the CLI |
| sdk | `qrcode`, `@types/qrcode` | `@harness/sdk` | the terminal QR |
| web-system | `@tavily/core`, `puppeteer` | `@harness/system-web` (new workspace `systems/web`) | search, rendering |
| web | `shiki`, `mermaid`, `pdfjs-dist` | `@harness/web` | highlighting, diagrams, pdf pages (all lazy) |
| hub-platform | `@ayepi/push` (`file:../../../ayepi/packages/push`), remove `web-push` and `@types/web-push` | `@harness/hub`, root | web push in the library |
| design (done) | `@aeye/resources` | `@harness/core` | `ConvertedVersion` / `ConvertedKind` from `@aeye/resources/versions` (zod only, browser safe) |

---

## 8. Library asks

Open, recorded here; a lane that needs one says so in its report:

- **@ayepi/core**: binary ws frames (MessagePack or CBOR).
- **@ayepi/sqlite**: `sqliteFiles(db)`, a `FileStore` over a SQLite table, so the database content store lives in
  the library (the resources lane builds `SqliteFiles` in the hub until then).
- **@ayepi/mcp**: server-sent `notifications/progress` for long calls and approval waits; `serveStdio` answering
  requests concurrently (it awaits each line, so `notifications/cancelled` can't reach a call in progress; the CLI
  bridge drives its server with its own concurrent loop until then).
- **@aeye/core**: `forget` should count tool definitions in its input estimate; a provider hook to report the
  served window (Ollama `num_ctx`); the static mode's text tool protocol as a schema fallback, once proven here.
- **@aeye/resources**: `pptx` and `ipynb` converters; an `audio`/`video` type with a `transcribeAudio` callback; a
  thumbnail callback; converter versions on every converter id (the hub keys forms by `converter`, so an id like
  `htmlConverter@2` is what it needs); an address guard and redirect policy in the url loader
  (`fetchResource(..., { allowPrivate, maxRedirects, lookup })`, applied to every hop and to renderer requests) that
  pins the checked address for the connection, so DNS rebinding can't pass it. Until then the hub's own fetch and the
  web system share one set of rules, `addressVerdict` and `followRedirects` in `@harness/sdk/server`
  (`sdk/src/server/address.ts`), which check each hop before it is requested but don't pin the address.

Done since build 1 (on the libraries' `harness` branches): `@ayepi/mcp` caller info, annotations, `McpRouter`,
`BearerAuth`, views and `McpToolSet`; `@ayepi/push`; `@aeye/resources` versions and converters, the url loader with
page renderers, the folder resolver, version sections.

---

## 9. Decisions made here (beyond build-2.md's answers)

- The converted data's word is **form**; `@aeye/resources`' `ResourceVersion` is one kind of form (the converted
  version), stored as the library's own JSON so its schema stays the one source of truth.
- Web pages become **hub resources** (imported), not resources served by the web system at `https://` roots: one
  path for every URL, kept and converted by the hub.
- Zip install is its own endpoint (`installPackage`) rather than a new `InstallSource` variant; the installed
  record's source gains a `zip` variant when the packaging lane builds it (with its handling in `link/process.ts`).
- Hub MCP tunables are `HARNESS_HUB_MCP_*`; the contextor's window margin is `HARNESS_PROMPT_MARGIN` (the existing
  `HARNESS_BUDGET_MARGIN` is the spend reservation's).
- `invalid-input` settles code callers as `failed` with `INVALID_INPUT_CODE`, so `RunSettled` keeps its variants.
- System value components keep the key `inputs` (the owner's word) and gain `readonly`; there is no separate viewer
  registration.
- The generated authoring doc ships in the SDK package (`packages/sdk/AUTHORING.md`).

---

## 10. Changes made in integration

What the build did differently from the sections above, accepted at integration:

- **Zips use `node:zlib`** behind `@harness/hub/package` (`zip`, `unzip`, `readPackage`, `readExport`), not `fflate`
  (§3.12, §7). One small module the CLI imports too; no new dependency.
- **Tavily through its REST API** behind the web system's `SearchProvider` (`TavilySearch`), not `@tavily/core`
  (§3.7, §7): one `fetch` with the injected seam, the same shapes, nothing more to install.
- **Fn cards print types with gin's `toCode()`**, not `toCodeDefinition()` (§3.3): the definition form adds about ten
  built-in methods per type, too costly for small windows.
- **`RawPage`, the `hub/resource_outline`, `hub/resource_send` and `hub/mint_mcp_token` args, `ROLE_CAPABILITY`,
  `CODE_FORMATS` and `SessionPatch` live in `@harness/core`**, each the one source the hub, the SDK contract (with
  `ginAs`), the web system and the web app read.
- **Hub fns are not held to declared deps** (`HubRunService`): see "Hub fns call what the hub's code calls" in
  [harness.md](../harness.md) "Decided".
- **The e2e suites** (§6): `fleet.e2e.test.ts` is two suites, `package.e2e.test.ts` (a packed fleet the hub installs)
  and `pairing.e2e.test.ts` (QR pairing of a second fs instance, routing, and the ambiguous call); beside them
  `runs.e2e.test.ts` (invalid input, errors, fn metrics, embedding model calls), `resources.e2e.test.ts`,
  `web.e2e.test.ts`, `contextor.e2e.test.ts` (static toolset on a free model; graph on the local Ollama with request
  sizes checked) and `authoring.e2e.test.ts` (the agent makes a system from the guide; the CLI packs it; the hub
  installs and runs it).
- **Defaults outside the hub** (§3.12): an instance's data and cache folders default to `data/` and `cache/` in its
  state folder (`placeFolders`), and fs reads them from there like `ctx.dataDir` and `ctx.cacheDir`.
- **The authoring guide is offered in parts** (§3.1): one file is about 105k tokens, more than most windows. fs's
  `fs/system-authoring` (`/new-system`) is the start item (the guide's intro, every part with its size, the template
  note), and each section of the guide is a dynamic context item of its own (`fs/authoring-<topic>`) under it, each
  naming the next; the runtime internals and core types are reference parts, never suggested. `npm run
  docs:authoring` writes the parts list beside the guide (`systems/fs/shared/authoring.gen.ts`, checked by `--check`),
  the one source of fs's declarations and implementations of them.
- **`harness mcp`'s bridge** (§3.12) is an `McpClient` to the hub MCP offered again by an `mcpSourceServer` whose
  tools, resources and prompts are the client's (`proxySources`), so the stdio client's ids stay its own and a
  `notifications/cancelled` from it aborts the local call, whose signal makes the client cancel its own request at the
  hub. The stdio lines are driven by `serveLines`, which answers requests as they finish: `serveStdio` answers one
  line at a time, so a cancel could not reach a call in progress (a library ask, §8).
- **Folder listings stay fs's own** (C5): fs lists folders itself (`systems/fs/server/resources.ts`, `files.ts`) and
  the hub has no `folder` form; `@aeye/resources`' `folderResolver` and `FolderListing` are not used yet. Moving fs's
  folder resources onto them is open work for the resources and fs lanes.
- **Table rows past `HARNESS_TABLE_ROWS`** (§3.6, §3.9): the hub keeps the first rows of each table (the library
  converts a workbook whole, with no row window) and refuses a range that starts past them (`ROWS_NOT_KEPT`) instead of
  answering empty. A row-window option for the library's table converters is a library ask (§8).

---

## 11. Status at the end of build 2 (2026-11-08)

Checked at the end of the build: `npm run typecheck`, `npm run lint`, `npm test` (207 files, 2180 tests), `npm run
build`, the staleness checks (`docs:authoring`, `web:manifest`, `env:example`, all `--check`) and `npm run e2e` (all ten
files, 50 tests; `authoring` now puts back the root `tsconfig.json` and `package.json` if the agent edits them, which
had broken the later suites' transform). The
`ui-tests` suite was not run in the final round (see "Which tests run in a browser" in
[architecture.md](../architecture.md)).

| Item | Status | Proven by |
|---|---|---|
| 3.1 Template system and generated docs | built | `scripts/docs/*.test.ts`, `docs:authoring --check`, `authoring.e2e` (the agent makes a system from the guide; it packs, installs and runs) |
| 3.2 Transcription and dictation models | built | hub `models/` tests, web admin store tests, `ui-tests/features/model-roles.ts` |
| 3.3 Chat modes: tools and static | built | contextor tests, `contextor.e2e` (static toolset on a free model) |
| 3.4 Graph contextor and budgets | built | contextor tests, `contextor.e2e` (graph on the local Ollama, every request inside the served window; skipped without Ollama) |
| 3.5 Context links | built | contextor and resources tests, `resources.e2e` (context from a resource linked back to it) |
| 3.6 Raw and converted storage, forms, resource to context | built; folder listings stay fs's own (§10) | resources tests, `resources.e2e` (page, workbook, pdf) |
| 3.7 The web system | built (Tavily over REST, §10) | `systems/web` tests, `web.e2e` (runs only with `TAVILY_API_KEY`) |
| 3.8 Resource browser | built | web component and store tests, `resources.e2e` (grouped by type), `ui-tests` `resource-browser` |
| 3.9 Viewers for every common type | built | web viewer tests, `ui-tests` `viewers` |
| 3.10 QR pairing | built | sdk pairing tests, `pairing.e2e` |
| 3.11 Hub MCPs | built | hub `mcp/` tests, `mcp.e2e` (an MCP client, secret rotation), CLI `mcp.test.ts` (stdio bridge) |
| 3.12 Packages, data, CLI | built | `link/package` and CLI tests, `package.e2e`, `authoring.e2e`, `restart.e2e` |
| 3.13 Invalid input versus errors | built | hub, sdk and web tests, `runs.e2e`, `pairing.e2e` (the ambiguous call) |
| 3.14 Fleets | built | `FleetRouter` tests, `pairing.e2e`, `package.e2e` |
| 3.15 Gin editors and viewers | built | web component tests, `ui-tests` `gin-editors` |
| 3.16 Every model call tracked | built | hub `metrics/` tests, sdk forwarding provider tests, `runs.e2e` (embedding model calls) |
| 3.17 Systems add resource views | built | sdk client and web renderer tests, `ui-tests` `renderers` |
| 3.18 Fn metrics | built | hub `metrics/` tests, `runs.e2e` |
| 3.19 Systems add type inputs | built | sdk client and web form tests |
| 3.20 Hub fns for everything | built | hub fn tests (`boot/hub-fns`), the e2e suites' agent turns |
| C1 Auto-load named fns | built | `namedIn` tests (`contextor/render.test.ts`) and the contextor planner tests |
| C2 Retry catch-up after reconnect | built | connection store tests, `ui-tests` `reconnect` |
| C3 Mock fixtures checked against schemas | built | `npm run typecheck` |
| C4 Mock hub sign-in status | built | `packages/web/src/test/mock-hub.test.ts` (401 and 200) |
| C5 Library asks | binary ws frames still open; web push on `@ayepi/push`; folder resolver unused (§10) | §8 |

Open after build 2: the library asks in §8 and in [architecture.md](../architecture.md) "Library asks"; moving fs's
folder listings onto `@aeye/resources`' folder resolver; moving the `ui-tests` checks that need no browser into
component and API tests (the table in architecture.md).
