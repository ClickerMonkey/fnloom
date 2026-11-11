# Build 6: design (binding)

Spec: `build-6.md`. Owner rules: Decided in `harness.md`. Lanes: **platform** (aits, ayepi), **hub** (packages/hub,
sdk, cli, the new packages/build, systems/*), **web** (packages/web). Core contracts for every item below are in
`packages/core` now (typecheck green). Stubs left for the hub lane are marked `Build 6 stub (hub lane)`. Only the design
lane edits core. If a lane needs a contract change, it says so in its report and keeps to the closest existing shape.

## Contracts added to core (all zod, types derived)

| File | Added |
|---|---|
| `approvals.ts` | `InstallSubject` / `ApprovalSubject`, `ApprovalPreview.subject?`, `FnApproval.approver?` (`ProposalApprover`, default `person`), `ApprovedRun`, `PairingGrantRequest`, `PairingGrant` |
| `link.ts` | `RunRequest.approved?`. Hub link: `grantPairing` (gp), `models` (mo, `HubModelInfo[]`), `examples` (xp, `FnExamplesPatch`), `resourceSections` (rsc), `resource.sections?`. System link: `estimate` (es) |
| `records/systems.ts` | `PairingToken.boundTo? {instance, manifestHash, host, run}` |
| `package.ts` | `SystemPermissions`, `SystemPackageManifest.permissions?`, `HostedBy`, `InstanceRecord.host?` (so `SystemView.host`) |
| `manifest.ts` | `ContextChoice {to, when}`, `ContextDecl.title?`, `ContextDecl.choices?`, `TypeDecl.meta?`, `KindDecl.estimates?`, `ManifestPatch.lists?` (providers, registries, contributes, each replaced whole), `ManifestPatch.roots?` |
| `context-files.ts` (new) | `ContextFileHeader` (strict: `key`, required `summary`), `contextDeclOf`, `CONTEXT_BODY_REFERENCE`, `ContextFileProblem` and its codes, `LoadContextResult` |
| `fn-facts.ts` | `FnExamplesPatch`, `FnExampleRecord.source 'runtime'` + `key?`, `KindEstimateRequest` / `KindEstimateAnswer`, `TypeVersionRecord` (table `typeVersions`) |
| `suggestions.ts` | `SuggestionOutcome.broughtBy?` |
| `admin.ts` | `HubModelInfo` (`ModelInfo` + tier, maxOutputTokens, roles) |
| `web.ts` | `systemsSlice.restartSystem`; `explorerSlice`: `exploreRoots`, `exploreList`, `exploreRead` |

The build 3 contracts the task named (`ListQuery`/`LIST_FIELDS`, `SuggestionRecord` with `SkipReason`,
`SuggestDecision`, auto-pair secrets, `RunControl` pause, `ContextDecl.fns`) already exist and are unchanged.

## Items

**1. Install from chat** (`system-install-flow.md`, all of it; tsx runtime).
- **Part 1 (not done in build 5, so it comes first).** *Hub lane.*
  - `broughtFns(records)` lives in `contextor/`. It is used by plain, suggest and graph, and by `hub/load_context`,
    which returns `LoadContextResult`: unknown names are refused with the closest names, and `name: description`
    input is accepted.
  - The `contextBlock` adds a generated fns line. Suggestions bring their fns (`broughtBy`). `<suggested_fns>` gets
    its instruction line, and the base prompt gets its sentence.
  - fs: authoring parts inherit the start item's fns, and the start text is fixed. Then `npm run docs:authoring`.
  - Test: replay turn 1 against the plain contextor.
- **Part 2.** *Hub lane:*
  - `@harness/build` (new package; the builder, checks and scan move out of the cli).
  - `sdk/server/supervise.ts`: env allowlist, permission flags and backoff. The hub supervisor uses it too.
  - Hub:
    - admins approvers, with notification
    - `ctx.approved` from `RunRequest.approved`
    - `grantPairing`, and `boundTo` checked in `link/pairing.ts`
    - `InstanceRecord.host`
    - `startSystem`, `stopSystem` and `restartSystem` go through the host's fns for hosted instances
    - `auto` mode never decides an `approval` fn
  - fs: `install_system`, `system_status`, `restart_system`, `stop_system` and the hosted folders.
  - The CLI bin runs under tsx.

  *Web lane:*
  - install result card
  - approval card subject (hashes, diff, scan)
  - Systems page: "hosted by fs/main at …" with restart and stop
- **E2E:** the chat scenario of task 9, API-level against a real stack with a scripted model. *Hub lane.*

**2. Build 5 leftovers and hub-surface departures.** *Hub lane* unless marked. The hub lane re-checks every item of
`hub-surface.md` §4 first and lists each one it closes or finds already closed.
- **One search.**
  - Retire `hub/search_fns`, `hub/search_context`, `hub/find`, the web `search` and `hub/load_fns`' duplicate checks
    in favour of `fns_search` / `searchFns`.
  - The chat's default tools: `fns_search`, `load_fns` (with the `load` check), `load_context`, `fn_examples`,
    `run_status`, `ask_user`.
  - When the web `search` goes, the web lane switches the palette to `searchFns`. The hub lane then deletes `findSlice.search`
    from core and runs `npm run web:manifest`.
- **Runtime add/update/remove for everything.**
  - `ManifestPatch.lists` and `roots`, and link `examples`.
  - The SDK: one `RunningSystem.patch` (every section, lists, roots) plus `examples()`. `remove` covers contract
    entries too.
  - Static and runtime entries end in the same records, and `Catalog.declare` keeps `origin: 'runtime'`.
- **Type versions and meta.**
  - Write `typeVersions` on every replaced type, and return `meta` through `types` / `ctx.types`.
  - The database system then drops `store.ts` and keeps only pending changes, in its state.
- **Hub fns.**
  - Every fn in `sdk/src/hub.ts` and every endpoint-backed fn gets `instructions` and at least one example.
  - `fn()` accepts `effects` and `promptExamples`.
  - The `{ input }` wrapper goes: a union body becomes a discriminated object at top level.
  - Naming: noun_verb for new fns, and existing names are left alone unless they are being retired.
  - Every web operation in §4.7 has a hub fn.
- **Kind cost.** `KindDecl.estimates` plus the system link `estimate`, and a `kind({ estimate })` hook in the SDK (the
  runtime stub answers `{}` until then). `database/query` and `input/form` implement it. `FnFacts.cost` uses it with
  basis `payload`.
- **Database.**
  - routing: `FnRouting` (core, done)
  - fleet listing through `fleet`
  - `QueryResult` uses `ResultBlock`
  - previews send `kind` and `payload`, and the kind's approval rule is copied onto the stored fn
- **Visuals.** An SDK client injection key for the visuals runtime, and a label on contributions. *Hub (sdk) and web
  lanes.*
- **Pairing.** `configSecrets` on `SystemView` / `PairingRequest` exists already. Check it is sealed across a restart.
- **Approvals.** The `admins` approver. A declined run settles `cancelled`, with "declined by <name>: <reason>" in the
  run's errors and the tool reply. The policy is checked before the preview is asked for.
- **Link visibility.** `resource`, `resourceSections`, `types` and `content` check the run's person (as the system
  itself without a run). The link `embed` is removed in favour of `model {modality:'embed'}`: the hub lane deletes it
  from core with its handler. `ctx.budget.spend` reaches the hub or is removed. `ctx.resources.text(uri, sections)`
  and `sections()` use the new endpoints. `search` calls `hub/search_resources` as a declared dep.
- **fs file explorer.** `explorerSlice` routes `roots`, `list` and `read` to the serving system as the person, and
  stores nothing (hub lane). The web lane adds the explorer page, `/explore/:system/:instance/*path`, which is tied to
  the URL and has the tree in the left sidebar.
- **Browser logs.** *Web lane.* `packages/web` has its own log client (not `@ayepi/log`): `console.*`, errors and
  traffic, sanitized, sent through `clientLogs`. Check what build 5 left and finish it.
- **UI fixes from build 5.** *Web lane.* Check them first with one browser pass at 390x844 and 1440x900, and fix what
  fails.
- **Tests.** The build 4 e2e suite green; the contextor suite on `qwen2.5:3b` (pull it); the approval card on the runs
  page (component test); dialect tests on real SQLite JSON functions.
- **Docs.** The `architecture.md` rows (the `fns/` module, the build 5 tables, `typeVersions`, `context-files.ts`) and
  the AUTHORING regeneration. These belong to the hub lane at the end.
- **aits `packages/resources` uncommitted changes.** *Platform lane:* review them, then commit them on `harness` or drop
  them.

**3. `ctx.ai()` / `hubAi()`.** *Hub lane.*
- **SDK.**
  - `ctx.ai()` on every ctx (runs, hooks, lifecycle, timers) and a top-level `hubAi(system)` both return an
    `@aeye/ai` instance.
  - `HarnessProvider.listModels` maps the link `models` (`HubModelInfo`) to aeye `ModelInfo`. Capabilities go
    through a typed guard against aeye's names, so there's no cast.
  - Roles become named models.
  - `ctx.llm` stays as a thin helper over `ctx.ai()`.
- **Hub.**
  - `models` lists the models and roles the system may use.
  - `llm` and `model` without a `run` are charged to the system's own budget and limits, and recorded as
    `ModelCall`s attributed to the system.
- **Tests and docs.**
  - A fake with the same type for tests.
  - The AUTHORING example.
  - One live test against a free OpenRouter model.

**4. Library gaps.** *Platform lane.*
- **`@aeye/gin`.** `RefWalker` skips `enum` and `literal` values. Then the hub lane restores `FnSearchQuery.order`'s
  `'name'` (rename `alphabetical` back, in core: the design lane makes the edit when asked).
- **`@aeye/resources`.** Graph nodes carry the bytes (or a content ref), the final URL, the status and whether the page
  was rendered. Rebuild dist. Then the hub lane switches `web/crawl` to `buildResourceGraph` and deletes its own walk.

**5. Context folders.** *Hub lane.*
- **The build checks the folder.**
  - `@harness/build` gets `checkContextFolder(dir, known)`. It reads `context/**/*.md` with `js-yaml` (already a
    resources parser dep) and checks:
    - each header against `ContextFileHeader`
    - duplicate keys
    - links in the header (`fns`, `imports`, `choices`, `links`, `parent`, `next`, `alwaysFor`) and
      `CONTEXT_BODY_REFERENCE` matches in the body, against the system's own contract and the hub's catalog (when one
      is reachable, else own and `requires`d systems' manifests)
    - `imports` cycles

    It returns `ContextFileProblem[]` with file, line and column. `harness system build` fails on any problem.
  - The built manifest's `context` gets `contextDeclOf(header, body)` for each file.
- **Dev.** The SDK watches `context/` and sends `patch({ upsert: { context }, remove: { context } })` keyed by `key`.
- **Hub.**
  - Context updates by name, keeping links, stats and embeddings.
  - `load_context` and every contextor always load `imports` and brought `fns` (the same `broughtFns`).
  - Rendering shows `choices` as decisions with their token sizes.
  - The UI shows `title ?? description`, never the key.
- **fs.** The fs authoring guide becomes such a graph: a shallow index item with `choices`, one idea per item. A test
  checks that a linked context really loads with its fns.
- **The hub and system API** is grouped and indexed the same way: `hub/fns_search` plus an index context item per
  group, never one flat list.

## Rules for this build

- **Tests.** Browser tests only for rendering: install card, explorer, Systems host row. Screenshots of changed
  screens only, at 390x844 and 1440x900.
- **Library gaps.** Anything a library can't do goes in the report as `LIBRARY GAP:`, with no workaround.
- **Generated manifest.** After a `web.ts` change, run `npm run web:manifest`.

## Status (end of build 6)

Checked against the code at the end of the build. **Done** means in the code with tests; the rest is listed under
"Not finished" and carries into build 7.

| Item | Status |
|---|---|
| 1. Install from chat, part 1 | Done: `contextor/brought.ts` (`broughtFns`) for every contextor and `hub/load_context` (closest names, `name: description` input), the fns line, suggestions with `broughtBy`, the fs start item's fns |
| 1. Install from chat, part 2 | Done: `@harness/build` (builder, checks, scan), `sdk/server/supervise.ts` (env allowlist, permission flags, backoff, `STATUS_LOG`), `admins` approvers, `ctx.approved`, `grantPairing` with `boundTo`, `InstanceRecord.host`, hosted start/stop/restart, fs `install_system` / `system_status` / `restart_system` / `stop_system`, the install card, the approval card subject, the Systems host row; e2e `install.e2e.test.ts` |
| 2. One search | Done: `hub/search_fns`, `search_context`, `find` and the web `search` retired for `fns_search` / `searchFns`; the chat's default tools as listed |
| 2. Runtime add/update/remove | Done: `ManifestPatch.lists` / `roots`, link `examples`, one `RunningSystem.patch`, `origin: 'runtime'` kept |
| 2. Type versions and meta | Done: `typeVersions`, `meta` through `types`; the database system's `store.ts` is gone |
| 2. Hub fns | Mostly done: instructions and examples, `effects` and `promptExamples`, a hub fn per web operation (`person-ops.ts`, `person-fns.ts`). Not done: the `{ input }` wrapper is still on `resource_import`, `configure_provider`, `remove_rule` and `set_model_role` |
| 2. Kind cost, database, visuals, pairing, approvals, link visibility | Done (`estimate` with `database/query` and `input/form`; the hub link `embed` and `ctx.budget.spend` are gone) |
| 2. fs file explorer, browser logs, build 5 UI fixes | Done: `/explore/:system/:instance/*path`, `state/client-logs.ts` |
| 2. Tests and docs | Done: build 4 e2e suite, contextor suite on `qwen2.5:3b`, approval card component test; architecture rows and AUTHORING regenerated |
| 3. `ctx.ai()` / `hubAi()` | Done, with the fake and the live test over a free OpenRouter model |
| 4. Library gaps | Done on the `harness` branches: gin `RefWalker` (and `FnSearchQuery.order: 'name'` restored), resources graph nodes (and `web/crawl` on `buildResourceGraph`) |
| 5. Context folders | Done: `checkContextFolder` (build fails on problems), `contextDeclOf` in the built manifest, the SDK's `context/` watch, update by name, `choices` rendered with sizes, the fs authoring guide as an index with choices. Not done: the hub and system API grouped with an index context item per group |
| Owner feedback (2026-11-11) | Done: search pills and sort row, the system page's context switch and "everything it added" tabs, hub-made context commands served by the hub (4xx with the reason, greyed out in the composer), declared effects (shown to the model, filtered in `fns_search`, enforced with `undeclared-change`). Not done: `npm run live` (a pinned stack with no file watching) |

### Not finished

- The hub and system API grouped and indexed with an index context item per group (item 5, last point).
- The `{ input }` wrapper on four hub fns (item 2, Hub fns).
- `npm run live` from the owner feedback; the README's "Running a stable stack" section it refers to is not written.
- The SDK's fake hub (`sdk/server/testing.ts`) still refuses `grantPairing` and answers `resourceSections` with nothing.
- The e2e checks that need embeddings (`runs`: the index's embedding calls; `chat`: suggestions from a draft) failed at
  the end of the build because the local embedder service (:8760) answered `/embed` with nothing for 60 s; the rest of
  the suite passed (`restart` and `package` only when run apart from the full suite on a loaded machine).
