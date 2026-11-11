# Build 7: design (binding)

Spec: `build-7.md`. Owner rules: Decided in `harness.md`. Lanes: **platform** (aits for `@aeye/*`, ayepi), **hub**
(packages/hub, sdk, cli, build, systems/*), **web** (packages/web). Core contracts are in `packages/core` now and
typecheck is green. Stubs for the hub lane say `Build 7 stub (hub lane)`. Only the design lane edits core. A lane that
needs a contract change says so in its report and uses the closest existing shape until then.

## Contracts added to core (zod first, types derived)

| File | Added |
|---|---|
| `checks.ts` (new) | `ScanReport` / `ScanConcern` (moved from `@harness/build`, which re-exports them), `TestCase`, `SystemTestReport`, `PreviewShot` (`PREVIEW_STATES`, `PREVIEW_VIEWPORTS`), `InstallChecks` |
| `grants.ts` (new) | `HubCapability` (groups of link endpoints), `ModelGrant` (roles, models, per-run and per-day caps), `FileGrant`, `SystemGrants`, `ConfigComponentDecl`, `SystemStage` (`installed` \| `live`) |
| `lifecycle.ts` (new) | `ItemSection` / `ItemRef` / `ItemSwitch` (table `itemSwitches`), `LiveContract`, `ContractChange`, `PendingReview`, `SystemReviewRecord` (table `systemReviews`), `RefusalRule` / `RefusalRecord` (table `refusals`, id `rfs_`), `RefusalQuery` / `RefusalPage`, `SystemReview`, `GoLiveRequest`, `TestCallRequest` |
| `graph.ts` (new) | `GraphNodeKind`, `GraphEdgeKind`, `GRAPH_EDGE_VERBS`, `GraphNode` (+`GraphNodeFacts`, `external`, `collapsed`), `GraphEdge`, `GraphMore` ("+N more"), `GraphQuery`, `GraphPage` |
| `manifest.ts` | `Manifest.grants?`, `Manifest.configComponent?` |
| `run.ts` | `RunInfo.watched?` (a person is watching; absent means headless) |
| `records/systems.ts` | `SystemRecord.stage?` (absent counts as live) |
| `approvals.ts` | `InstallSubject.source?` (the hosted source folder), `ApprovalPreview.checks?` (scan and tests on the install card; not bound) |
| `system-parts.ts` | `SystemPart.on?` |
| `web.ts` | `SwitchPart` + `systemsSlice.switchPart`; `reviewSlice` (`systemReview`, `goLive`, `approveReview`, `rejectReview`, `testCall`, `refusals`); `graphSlice` (`graph`) |

The task's other contracts already exist and are unchanged: the query model (`query.ts`: `ListQuery`, `FieldDecl`,
`LIST_FIELDS`, operators, sort, paging and free text), not-used suggestions with reasons (`SuggestionRecord`,
`SkipReason`), the decision model setting (`SuggestDecision`, `decide` on the link), auto-pair secrets
(`auto-pair.ts`), run pause and resume (`control` on the link and on the web), and context options with tied fns
(`ContextDecl.fns`, `ContextOptions`). `FnSearchQuery.order` already says `name`. `SystemEnabled.context` already
exists.

## Items

**1. Authoring fns behave like product's.**
- **Exists:**
  - `get_query` and `edit_query` (database) are prompt-with-tools agents. The model writes raw QueryDef JSON against a
    `Json` arg, with the syntax taught in the prompt.
  - `get_input` (input) has an agent write a gin type.
  - SDK `agent()` runs over `ctx.ai()`.
- **Platform (aits):**
  - `@aeye/query`: `tableToQueryType`, `buildSchemas` and `buildQueryTool` as the typed authoring schema (research
    recs 1–3), and the signature and arg-check helpers.
  - `@aeye/gin`: helpers for writing gin types and expressions (a surface by steps, an arg check).
  - Port product's tests with each piece: `packages/core/src/kinds/{query,disclosure,authoring,type-definition,type-gin-surface}.ts`
    and `server/src/llm-integration/{query,type,disclosure}-agent.test.ts`.
  - Read aeye's docs for per-step tool sets before adding anything; add only what is missing.
- **Hub (sdk):** `authoringAgent()` in `packages/sdk/src/authoring.ts`, built on `agent()` and not a second loop.
  - **Stages:** find → inspect → draft → check → fix → save. Each stage has its own tools, and a stage's tools appear
    only once the stage before it is done.
  - **Disclosure:** each step returns types, schemas, examples and docs a little at a time.
  - **Checks:** a check-and-fix loop with a cap, from the system's env slice.
  - **Save:** a save step that writes the fn.
  - **Result:** a gin result type `authoredFn` (`fn`, `version`, `signature`, `about`, `reused`, `preview?`, `call`).
    The chat model gets this, never the working context.
- **Hub (systems):**
  - database `get_query` / `edit_query` and input `get_input` move onto `authoringAgent`, with real instructions and
    examples.
  - The query draft tool's arg is the typed schema from `buildQueryTool`, not `Json`.

**2. Testing is native.**
- **Exists:** vitest everywhere, `@harness/build`'s `checkContextFolder`, puppeteer in `build/e2e`. There is no test
  kit for system authors.
- **Hub (sdk):** `@harness/sdk/testing` (a new entry point, with its env slice for keys and the preview viewport).
  - `testHub()`: a fake hub and ctx, every call recorded.
  - `callFn(contract, name, args)`: returns `{ result, progress, hubCalls }`, all typed.
  - `mockModel(script | recording)`: scripted or recorded model replies.
  - `realModel.it(...)`: real model calls through a free OpenRouter model, skipped without keys, and marked `real`.
  - `preview(component, states)`: renders a component with happy-dom and shoots it with puppeteer, giving a
    `PreviewShot` per state, viewport and theme, collected into a gallery.
  - `kindProps(kind, payload)`: a kind's derived fn props from a payload.
  - `contextFolder(dir)`: uses `checkContextFolder` and loads the folder's fns.
- **Hub (cli):** `harness test [dir]` runs vitest's node API with a JSON reporter and returns a `SystemTestReport`.
  `--previews` also shoots the gallery.
- **Hub (fs):**
  - `install_system` runs the tests before asking for approval, and puts `InstallChecks` on `ApprovalPreview.checks`.
  - On pairing, the hub copies them to `systemReviews.checks`.
- **Hub (docs):**
  - A "Testing" section in the authoring guide (`scripts/docs`), then `npm run docs:authoring`.
  - The template system ships one test of each sort.
- **Web:** the install card and the review page show the counts, the failures and the preview gallery.

**3. Database recommendations 4–5.** *Hub lane.*
- **Result wording:**
  - The hub sets `RunInfo.watched` only for a chat turn's runs on a session someone has open.
  - `sdk/server/results.ts` and the database and input texts say "shown to the person" only when `watched`. Otherwise
    they use the headless wording.
- **`run_query`:** declares `effects.mode: 'write'`.
- **Missing params:** a missing required param is refused as invalid input, never bound as NULL (database
  `queries.ts`).
- **Picking a database:** `get_query` calls `ctx.decide` when several databases fit, and `input/ask_choice` when it is
  still unclear.

**4. Generated fns from a table type.** *No model involved.*
- **Platform (`@aeye/query`), beside `tableToQueryType`:**
  - **Generators:** `tableFns(type, relations, { depth = 2, cap })` lists entries `{ name, about, signature, writes,
    group, rank }`. They cover CRUD, column helpers, relation-derived fields and normalized comparisons, with each
    derived field recording its table and column. Incompatible numerator and denominator pairs are refused.
  - **SQL:** `tableFnQuery(entry)` builds the QueryDef or SQL for an entry.
  - **Tests:** port product's `query-autocrud*.test.ts`. Test projects/owners end to end on SQLite, enum splits, depth
    2, a refused combination, idempotency and a schema change.
- **Hub (database system):**
  - `table_fns_available(type)` marks the fns that exist, with their version, by `fns_search` names. It groups by
    relation, puts the most useful first, and caps with "more".
  - `table_fns_generate(type, names[])` saves `database/query` fns with instructions and examples. It is idempotent by
    name. The schema hash goes in the payload, and a changed hash regenerates the fns.
  - It declares `registry: [{thing:'fns', action:'create'|'update', kind:'database/query'}]`.
  - Writes go through approval. Visibility is the instance's.
  - `selectPage` accepts derived columns for sorting and filtering.

**5. Installed vs live, review, enforcement.**
- **Lifecycle (hub):**
  - A new pairing makes `SystemRecord.stage = 'installed'`. Rows from before build 7 have no stage and are live.
  - While installed, the catalog, suggestions, `fns_search`, context selection, the resource index and providers all
    skip the system. Only `testCall` runs its fns, as the admin, with the run marked as a test.
  - `goLive(hash, off)` saves `LiveContract` and the off items, then sets the stage to `live`. It is refused when the
    contract hash has moved since review.
- **Changes after going live (hub):**
  - A new contract hash, or a runtime patch outside `LiveContract` and the fns' declared registry effects, writes
    `PendingReview` with its changes.
  - Changed and new items stay off. The live version keeps serving.
  - `approveReview` and `rejectReview` close the pending review.
- **Enforcement** goes in one place, `hub/src/link/grants.ts`, a guard on the link dispatcher plus the run checks:
  - capability by endpoint group (`HUB_CAPABILITIES` doc)
  - mode: a read fn can't call write or delete fns, propose writes, or write through fs
  - types: only the declared reads and writes reach hub queries
  - registry effects (already in build 6)
  - models and spend: roles, models, per run and per day
  - secrets by name
  - calls: deps must fall inside `grants.calls`
  - visibility
  - Each refusal writes a `RefusalRecord`. Past `HARNESS_REFUSALS_PAUSE` refusals in `HARNESS_REFUSALS_WINDOW`, the
    hub turns the system's functions off and notifies admins.
  - Without `grants`, a system gets the base only. Every in-repo system declares its grants in this build (SDK
    `system({ grants })`).
- **Network and files (hub, sdk supervise and fs):**
  - `grants.files` becomes Node `--allow-fs-read` and `--allow-fs-write`.
  - `grants.network` goes through an allowlist proxy that the supervisor starts (`HTTP(S)_PROXY` in the scrubbed env).
  - A refused host or path is sent to the hub as a refusal.
- **Custom config (sdk and web):**
  - `system({ configComponent })` names a client export.
  - The web draws it on the review, system and pairing pages, with `{ config, type, validate, client }`.
  - The hub still checks the value with the gin type.
- **Web:**
  - A review page at `/admin/systems/:name/review`, with tabs tied to the URL:
    - Fns: facts, effects, examples, and a test call.
    - Context, Types, Parts: per-item switches through `switchItem` and `switchPart`.
    - Grants.
    - Config.
    - Checks.
    - Graph.
    - Pending: the diff.
    - Refusals.
  - "Go live" and "Approve changes" are buttons.
  - The system page gets a stage badge, the Refusals tab, and tabs for every kind of part.

**6. System graph and global graph.**
- **Hub:**
  - `hub/src/graph/` builds the graph from stored rows: context links, `fnTypes`, `fnUses`, fn kinds, `FnFacts.registry`,
    `TypeRecord.references`, contributions, and system and instance membership. It answers through the hub database's
    queries, never by loading everything.
  - Filters, focus with hops, collapse, the cap with `GraphMore`, and the asker's visibility are applied.
  - It serves the `graph` web endpoint and the hub fn `hub/graph`. The fn's gin args are pinned equal to `GraphQuery`
    by a compile-time `Equal` test.
  - Tests cover the nodes and edges of a sample system, the filters, and external nodes being greyed.
- **Web:**
  - **Library:** Cytoscape.js (`cytoscape`, exact version, with compound nodes per system and the built-in `cose`
    layout), wrapped in one component, `GraphView.vue`. Its state and callers are in their own files.
  - **System graph:** a Graph tab on the system and review pages.
  - **Global graph:** a page at `/graph`, with every filter, search and hops, and collapse in the URL query.
  - **Hover:** shows a node's facts or an edge's label. Clicking opens the item, and fns open in the fn modal.
  - **Phone:** pan, zoom, and tap for details.
  - **Tests:** one puppeteer check of the rendered graph and its hover.

## Carry-overs (lane)

- **Hub:**
  - supervisor and process move onto the SDK `NodeStarter`, `scrubbedEnv` and `CrashPolicy`.
  - `ChatCapabilities.commands[].unavailable`, with refusals as readable 4xx.
  - The chat mode picker saves the chosen mode.
  - The `models` endpoint, and system budgets charged for `ctx.ai()`.
  - A live OpenRouter test.
  - The hub reads `InstallSubject.source`, never fs's args.
  - The link `content` endpoint runs as the run's person.
  - `checkContextFolder` skips fenced code, then `docs:authoring`.
  - The per-item lists and switches (`switchPart`, `itemSwitches`, `SystemPart.on`).
  - Check that the `SystemEnabled.context` handling is complete.
- **Hub (build and security):**
  - `@harness/build` writes `contract.json` (the built manifest and its hash). It gets them by importing the shared
    contract in a child process with no fs-write, network or child-process permissions.
  - Pairing compares the hello hash to it, so hello additions (events, resources, a context folder, patches) no longer
    refuse.
  - No model-written server code runs before approval.
- **Hub (sdk):**
  - zod-gin top-level choice, so the `{ input }` wrapper goes from configure_provider, remove_rule, set_model_role and
    resource_import.
  - `ProcessGrants.permissions` takes core's `SystemPermissions`.
  - `FnCtx.approved`, `approver`, and `RunningSystem.grantPairing`.
  - `ctx.notifyAdmins`.
  - A `routing` option on `agent()`.
  - The runtime answers `estimate`.
  - `ResourceProvider.read` reaches LocalContent.
- **Hub (cli and fs):**
  - The CLI passes the catalog as `known`.
  - fs `install_system` uses `NodeStarter` and `buildSystem`.
  - fs kills a stale pid at start and prunes a failed update.
  - The needs-config text heuristic is replaced with the hub's `needsConfig`.
- **Web:**
  - A 409 `unavailable` reads as text, and a declined run is cancelled with code `denied`.
  - The "Needs approval" row height.
- **`npm run live` (hub):** proposed as a bundled build. `scripts/live.ts` bundles the hub with tsdown or esbuild, and
  the web with Vite, into `.live/<sha>/`, then runs it with no watching on the main data dir. It never touches `:4320`
  or `:4300`.
- **Not run in build 6:** each lane runs what it touches.
  - Hub: the e2e install scenario, configSecrets after a restart, dialect tests on real SQLite.
  - The build 4 e2e suite and contextor on qwen2.5:3b run once, in the final integration.

## Rules for the lanes

- The `Build 7 stub (hub lane)` handlers to replace:
  - `switchPart` in `hub/src/api/web/systems.ts`.
  - `reviewSlice` and `graphSlice`, which have no hub plugin yet: add `api/web/review.ts` and `api/web/graph.ts`.
- New tunables go in env slices:
  - `HARNESS_REFUSALS_PAUSE`, `HARNESS_REFUSALS_WINDOW`, `HARNESS_GRAPH_LIMIT`
  - the authoring fix cap
  - the kit's real-model id
- Web runs `npm run web:manifest` after any core web change (done for this one).
