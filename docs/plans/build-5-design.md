# Build 5 design (binding)

Spec: [build-5.md](build-5.md). Status per item is at the end ("Status at the end of build 5"). The shared contracts are in `@harness/core` now and typecheck is green. The new web
endpoints answer 501 from `packages/hub/src/api/web/build5.ts`; the new system link endpoint `preview` throws from
`sdk/src/server/runtime.ts` (`buildFiveStub`); the SDK's fake hub answers `decide` with `off` and throws on
`propose`; the hub serves neither `propose` nor `decide` yet. The lanes replace all of these.

## Lanes

| Lane | Owns |
|---|---|
| **platform** | `aits` (`@aeye/query` dialects and DDL; rebuild dist), `packages/sdk/**` (+ `scripts/docs/outline.ts` for new exports), `systems/**` (new `database`; `input` may use `ctx.decide`), `scripts/` (dev restarts, dev pairing of the database system) |
| **hub** | `packages/hub/**` (replace `api/web/build5.ts` freely), `e2e/**` |
| **web** | `packages/web/**`, `ui-tests/**` |

Ask the design lane for any other core change in your report.

## Shared contracts (done, in core)

| File | What |
|---|---|
| `registries.ts` | `RegistryDecl` (`Manifest.registries`), `ContributionDecl` (`Manifest.contributes`), `ContributionView`, `VisualFit` (`fits`, `score` 0..1), `TABLE_VISUAL_SCORE` (0), `ColumnKind`, `ResultColumn`, `ResultSort`, `ResultTable` (columns once, rows as arrays, `offset`, `limit`, `total`, `truncated`, `sort`) |
| `approvals.ts` | `FnApproval` (`FnDecl.approval`: `preview`, `remember`), `PreviewPart` (`text`, `code`, `table`, `type-diff` with `breaks`), `ApprovalPreview` (`title`, `parts`, `irreversible`), `PreviewRequest` / `PreviewAnswer` (system link `preview`), `ProposalApprover` (`person`, `admins`), `ProposeRun` / `ProposedRun` (hub link `propose`) |
| `decisions.ts` | `DecideCandidate`, `DecideRequest`, `DecideAnswer` (`decision` with picks and reasons, `off`, `failed`) for hub link `decide` |
| `config-secrets.ts` | `ConfigPath`, `ConfigSecrets` (`Manifest.configSecrets`, `PairingInfo.configSecrets`), `SECRET_KEPT`, `SealedConfigSecret` (`{ $secret }` in the stored config) |
| `manifest.ts` | `TypeDecl.instance`, `FnRouting` (`{ to: 'instance', instance }` or `{ to: 'any' }`) as `FnDecl.routing`, `FnDecl.approval`, `Manifest.registries` / `contributes` / `configSecrets` (all optional) |
| `records/actors.ts` | `Approval.preview`, `Approval.proposed` |
| `link.ts` | hub link `propose` (`po`), `decide` (`de`); system link `preview` (`pv`) |
| `web.ts` | `approvalsSlice` (`approvals`: the approvals of up to 200 runs, with previews), `registriesSlice` (`contributions` to a registry) |

The database system's own shapes (config, query kind payload, the fn results the model reads) are gin types in
`systems/database/shared`, specified below. The result attachment's data is core's `ResultTable`; pin the gin type to
it with an `Equal` test, as the hub does for `ContentRef`.

## Per item

1. **Native approval runs.** Exists: policies put runs in `awaiting-approval` with an `Approval` (`approve` in
   `runsSlice`, `waiting` per session, notifications to approvers); a denied run settles and its reason reaches the
   caller. Changes:
   - **hub** (`execution/`): a fn with `approval` waits every time, whatever the policies say (a policy `deny` still
     wins). With `approval.preview`, call `preview` on its system before making the approval; `refused` fails the run
     as invalid input with that text; store `preview` on the approval. `remember: false` ignores a `remember` other than
     `once` in `approve`. A decline settles the run `cancelled` and the model's tool result says "declined by <name>:
     <reason>" (check the current wording says who and why).
   - **hub** (`link/`, `execution/`): serve `propose`: make the run (child of `parent`, in its turn and session, approver
     the run's person; or, with no parent, a run owned by the system actor in a system turn the hub makes, approver
     every admin), with `Approval.preview` and `proposed: true`, idempotent by `key`; notify approvers. Approved, it runs
     like any queued run. Serve `approvalsSlice.approvals` (only runs the asker may see).
   - **platform** (SDK): `fn({ approval, preview })` where `preview(args, ctx)` returns `ApprovalPreview` (served on
     `preview`); `ctx.propose(fn, args, { approver, preview })` returning `ProposedRun`.
   - **web**: one `ApprovalPreview` view (parts: markdown, highlighted code, a result table, a type diff of two gin
     type views side by side with the change list and the fns it breaks) on the chat's approval card and on a run's
     page. The admin Runs list already filters `status = awaiting-approval`; add an "Needs approval" quick filter and
     approve/decline on the run page. A system's admin page shows its waiting runs (the same list, filtered).

2. **Fleet-owned fns and types.** Exists: fleets (`instances: 'many'`), `FleetRouter`, one manifest per system.
   Changes: **hub** (`catalog/`): an entry with `instance` belongs to that instance: a manifest or patch from another
   instance never updates or removes it; removing the instance removes its entries. **hub** (`link/router.ts`):
   `routing.to = 'instance'` always goes there (waits like the default instance when it is offline); `any` takes the
   first of `on`, the session pin, the default instance, any connected one, never refusing as ambiguous.

3. **Config secrets.** Exists: secrets table (`AesSecretVault`), config in `instances`. **hub**: seal each
   `configSecrets` path on save (keep `SealedConfigSecret` in the stored value; `SECRET_KEPT` keeps the old one;
   removing a value removes its secret), send plain values only in `configure`, `SECRET_KEPT` to the web, leave them
   out of exports without `withSecrets`. **platform**: SDK `system({ configSecrets })` (checked against the config type:
   each path must be a text field). **web**: secret fields as password inputs reading "Saved" when `SECRET_KEPT`.

4. **Decision model for systems.** Exists: `SuggestDecision` (admins) and the `SuggestionDecider`. **hub**: serve
   `decide` with that model (`off` when not enabled; `failed` on error), the call recorded as a model call of `run`.
   **platform**: `ctx.decide(question, candidates, { max })`.

5. **Visual registry.** **platform**: SDK `system({ registries, contributes })`; `client()` takes a `visuals`
   section: `{ [registry]: { [name]: { match(table: ResultTable): VisualFit, component } } }`; the client runtime gets
   `visuals(registry, table)`: every loaded contribution that fits, best score first, table last. **hub**: serve
   `contributions` from the connected systems' manifests. **web**: before a registry renders, load the client bundles
   of the systems `contributions` names (cached). The database system hosts `database/query-visuals` (and has no client
   bundle); the app's one result view draws its `result` attachment with its own `table` (score 0, always fits) and `bar` (one text or date column plus one number column, 2 to 50 rows: score 0.8)
   and `value` (one row, one column: score 0.9). The result view shows the best fit and a segmented switch of the
   valid ones (hidden when only the table fits); the choice is kept per message in the URL-free view state.

6. **@aeye/query dialects and DDL.** Exists: base and Postgres dialects, no DDL. **platform** (aits `harness`): a SQLite
   and a SQL Server dialect (quoting, `LIMIT`/`OFFSET` vs `OFFSET … FETCH`, `ILIKE` as `LOWER … LIKE`, booleans, JSON),
   with conformance tests; DDL on the dialect: `createTable(type)` and `alterTable(current, wanted)` giving ordered
   steps, each with its SQL and whether it is irreversible (drops, narrowing type changes). Schema reading stays in the
   system (one `SchemaReader` per driver).

7. **The database system** (`systems/database`, **platform**). `instances: 'many'`; one instance per database.
   - **Config** (gin): `label`, `connection` (`sqlite-new` path under its data dir, `sqlite-file` path, `postgres` URL,
     `sqlserver` host/port/database/user/password/encrypt), `data: 'read-only' | 'read-write'`, `schema: 'none' |
     'allowed'`, `enrich: { on, model? }`, `audience` (a `ShareRule` for its fns). `configSecrets`: the Postgres URL and
     the SQL Server password. Drivers behind one `Database` interface (`read`, `write` in a transaction, `schema`):
     better-sqlite3, pg, mssql (install them in the system's package).
   - **Tables are types.** On configure and start: read the schema, make a gin type per table (columns, nullability,
     defaults, primary key, foreign keys as refs), hash each table's schema; enrich new or changed ones when on (an LLM
     call per table through `ctx.llm` with the configured model: enums, formats, ranges, descriptions, examples; cached
     by hash in the instance's data dir). Types are named `<instance>.<Table>` with `instance` set. Added types and
     compatible changes are patched straight away; a dropped table, or a change that breaks a saved query fn, becomes
     one `ctx.propose('apply_type_changes', …, { approver: 'admins' })` with a `type-diff` part per type.
   - **Query kind** `database/query`: payload `{ instance, query (the @aeye/query QueryDef JSON), description, sorters
     (fields a caller may sort by), list }`. `check` parses it against the instance's types; describe derives args
     (the query's params, plus `limit`/`offset` when `list`, plus `sort` from `sorters`), returns (`QueryResult` below),
     `types` (the tables it reads or writes), `operations`, and for a write `approval: { preview: true, remember: false }`.
     Saved query fns are `<instance>.<name>`, `routing: { to: 'instance' }`, shared by the instance's `audience`
     (`ctx.shareFn`), kept in the instance's store with an embedding and their version history.
   - **Fns.** `get_query(detailedDescription, database?)` (`routing: any`): pick the database (the only one; else by
     embedding of the description against each instance's types, `ctx.decide` when close, else `input` `ask_choice`),
     forward with `on` when it is another instance; search its saved query fns (embedding + names; `ctx.decide` when
     on, else a score threshold env tunable), reuse or have the query agent write one against the types (retries on
     problems, capped), save it, run it. `edit_query(name, instructions)`: the agent changes it, the old version stays
     in history, run it. With `schema: allowed`: `create_table(type)` and `alter_table(type)` (approval with preview:
     the DDL and the type diff). Writes and DDL only run after approval; with `read-only` no write query is saved.
   - **What the model reads** (gin types in `shared`): every row result is a `QueryResult`: `shown` (a sentence: "These
     N rows are shown to the person as a table; they can switch to another view. Don't repeat them; summarize or point
     out what matters."), `columns` (name, kind, nullable), `rowCount`, `total` when known, `truncated` with `nextPage`
     (`offset`, `limit` and the exact call), `sort`, `sample` (first rows up to a token budget tunable), and `fn` (its
     qualified name and one-line signature). `get_query` / `edit_query` return `QueryAnswer`: `database` (instance,
     label, dialect), `fn` (name, signature, `reused` | `created` | `edited`, why), `query` (readable SQL, structured
     form, params, `writes`), and `result` (a `QueryResult`) or `approval` (run, `approved` then its result, or
     `declined` with the reason). The full rows go to the person as a `database/result` attachment (`ResultTable`,
     capped by a tunable row count; paging is calling again with `offset`).
   - **Tests**: SQLite for real (scan, enrich with a fake model, get/edit/reuse, a write through approval, DDL through
     approval); Postgres and SQL Server against Docker when `docker` runs, else dialect output tests and live tests that
     skip.

8. **Carry-overs.**
   - **hub** (`index/`): embed the catch-up in bounded batches (env `HARNESS_INDEX_EMBED_BATCH`, default 64), save each
     batch as it lands, back off on failure (env base and max delay), resume from the first unsaved item.
   - **platform** (`scripts/dev.ts`): restart a crashed hub or system after a short delay (tunable), logging why to
     `<HARNESS_DATA>/logs/crashes.log`; pair the database system with a new SQLite file when asked
     (`HARNESS_DEV_ONLY` component `database`).
   - **hub** (`e2e/`): pull `qwen2.5:3b` and use it for the contextor suite; a build 4 suite (visibility for two people,
     crawl into resources, `get_input` with a hidden answer and `save_form`, a validation refusal and retry, a system
     provider serving a call); a build 5 suite over a SQLite database (get_query, reuse, a write approved and one
     declined, a proposed type change).
   - **platform** (SDK): keep the run's undo through a validation `retry`.

## Status at the end of build 5

The stub sentence at the top is history: `build5.ts` serves every endpoint and the SDK's `preview`, `propose` and
`decide` are real. `npm run check` is green. `npm run e2e`: 62 of 63 pass; the one failure (`runs` › the index's embedding
calls) is because the embedder service on 8760 was not running during the run.

| Item | Status |
|---|---|
| 1. Native approval runs | Done: `approval` always waits, `preview` from the system, `propose` (with and without a parent), `approvalsSlice`, one preview view on the chat card and the run page; approving runs it (no separate Run button). |
| 2. Fleet-owned fns and types | Done: instance-owned catalog entries, `routing` `instance` / `any`. |
| 3. Config secrets | Done: sealed on save, `SECRET_KEPT` to the web, password inputs. |
| 4. Decision model for systems | Done: hub link `decide`, `ctx.decide`. |
| 5. Visual registry | Done: `contributions`, client bundles loaded before a registry renders. The database system contributes nothing: the app draws `table`, `bar` and `value` itself (labels in `systems/database/client/visuals.ts`). A visual another system contributes shows by its name (`VisualOption` carries no label). |
| 6. `@aeye/query` dialects and DDL | Done in aits (`harness` branch): SQLite and SQL Server dialects, `createTable` / `alterTable`. |
| 7. Database system | Done for SQLite (tested for real); Postgres and SQL Server have dialect output tests, and their live tests skip without Docker. Saved query fns, types and examples live in the hub (no local store). |
| 8. Carry-overs | Done: bounded embed catch-up, dev restarts with `crashes.log`, the build 5 e2e suite, undo kept through `retry`. Not done: a build 4 e2e suite (visibility for two people, crawl, `get_input` with `save_form`, a validation retry, a system provider), and pulling `qwen2.5:3b` for the contextor suite (it uses the first listed model that is present). |

Owner feedback ([build-5-feedback.md](build-5-feedback.md)):

| Item | Status |
|---|---|
| Hub fn/context search, examples table and `fn_examples`, fn facts (mode, types, freedom, costs, run times) | Done (`packages/hub/src/fns/`). |
| `get_input`, `get_query`, `edit_query` as agents (prompt with tools), no local stores or in-memory vectors | Done. |
| Chat fn mode (`none` … `auto`) and the admin classifier model | Done. |
| Runtime add/update/remove of everything a contract declares | Types at runtime done (database tables); the full uniform API is build 6. |
| A context brings its fns (fs authoring: bash, read, write, edit) | Partly: see `system-install-flow.md` part 1, carried to build 6. |
| fs file explorer (browse live, not saved as resources) | Not done. |
| Web system on `@aeye/resources` | Partly: links come from `extractLinksFromHtml`; the crawl walk stays the system's own (library gap, build 6 item 4). |
| Self-contained system builds | Done: the server bundle inlines every JS dependency; only `server.external` (native addons) stays out. |
| Browser logs and traffic as per-person hub resources | Done (the web app's own log client, not `@ayepi/log`). |
| UI fixes (resources width and tree sidebar, dead opens, `bum` error, missing fn calls, order, collapsing, fn modal, cursor) | Done by the web lane and its reviews; not re-checked in a browser at the end. |
| Systems use aeye through the hub anywhere (`ctx.ai()`, `hubAi()`, real models) | Not done: `harnessAi` / `harnessAiOf(ctx.llm)` work inside runs only. Build 6 item 3. |
| Hub surface departures (`docs/reference/hub-surface.md`) | Not re-audited at the end; build 6 item 2 closes what is left. |
