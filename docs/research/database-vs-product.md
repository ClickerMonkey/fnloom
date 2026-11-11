# Databases as typed, queryable data: harness vs product

Research note, 2026-11-11. This compares harness's database system (build 5) with product's types-as-ORM and query
work, then recommends how to bring them together.

**Sources.**

- **Harness:**
  - `systems/database/**`, `packages/sdk/src/results.ts` and `packages/sdk/src/server/results.ts`, `packages/hub/src/fns/search.ts`.
  - The plans: `docs/plans/build-5*.md` and `build-6.md`.
- **aits, `harness` branch:** `packages/query` and `packages/gin`.
- **Product:** `design/*.md`, `packages/core/src/kinds/{query,type,type-configure}.ts`, `packages/core/src/query-types.ts`, `packages/server/src/db/type-tables.ts`, `packages/app/src/widgets/*`.

**Citations.** Paths are relative to each repo. TAO means `product/design/types-as-orm.md`, QTU means
`product/design/query-type-updates.md`, and QV means `product/design/query-visuals.md`.

---

## 1. The two approaches in short

### A. Harness: one system instance per external SQL database

- **Connections.** Each `database` system instance connects to one existing database. It can be a new SQLite file,
  an existing SQLite file, Postgres or SQL Server (`shared/shapes.ts:17-39`). The config also sets:
  - `data`: `read-only` or `read-write`
  - `schema`: `none` or `allowed`
  - `enrich`: on or off, with an optional model
  - `audience`: who may use it (`shapes.ts:56-66`)
- **Tables become types.** On start and on every configure, the system reads the schema with its own SQL per
  driver (`server/drivers/*.ts`). It turns each table into two types:
  - a hub gin type, `database/<instance>.<table>`, made with `@aeye/query`'s `tableToGinType` (`server/types.ts:374-380`)
  - an `@aeye/query` engine `TypeDef`, built by harness's own `engineTypeOf` (`server/types.ts:423-461`)
- **Enrichment.** An optional LLM pass adds descriptions, closed value sets, formats, ranges and examples
  (`server/author.ts:35-73`). The result is stored on the hub type's `meta` under its schema hash
  (`server/types.ts:295-299`, `server/catalog.ts:88-92`).
- **How a rescan reaches the hub.**
  - New types and compatible changes go to the hub at once.
  - Changes that break saved queries, and dropped tables, wait. The system proposes one `apply_type_changes` run
    for admins to approve, with a type-diff per table (`server/instance.ts:210-250`, `server/impl.ts:211-218`).
- **Saved queries are hub fns** of kind `database/query`.
  - **Payload:** `{instance, description, query (QueryDef JSON), sorters, list}` (`shapes.ts:75-86`).
  - **Args:** the kind's `describe` derives them as the params, plus `limit`/`offset` when the query is a list, plus
    `sort` over the sorters (`server/compile.ts:129-148`).
  - **The rest of `describe`:** effects (reads and writes per type), readable SQL, and `approval` for writes
    (`server/impl.ts:435-452`).
- **The query agents.** `get_query` and `edit_query` are `agent()` fns, a prompt with tools (`shared/index.ts:322-367`).
  - **System tools:** `databases`, `tables`, `check_query`, `save_query`, `run_query`.
  - **Hub tools:** `fns_search`, `fn_get`, `fn_examples`.
  - **Output check:** a validator sends the agent back if it answers without having saved and run a query
    (`index.ts:141-154`).
- **Results.**
  - The person gets the full page as a `result` attachment (`ResultTable`).
  - The model gets a `ResultBlock`: a "shown to the person, don't repeat" sentence, the columns, counts, the exact
    call for the next page, and a sample that fits a token budget (`packages/sdk/src/server/results.ts:72-136`).
- **Writes and DDL** (`create_table`, `alter_table`) always wait for a person's approval. The preview carries:
  - for writes: the SQL, the affected-row count from a rolled-back dry run, and the rows it matches
    (`server/queries.ts:230-241`)
  - for DDL: the steps, the DDL itself and a type diff (`server/impl.ts:123-167`)
- **Visuals.** A visual registry (`database/query-visuals`) holds `table`, `bar` and `value`, each with
  `match(table) -> {fits, score}`. The result view offers a switch between the visuals that fit
  (`client/visuals.ts:33-41`).

### B. Product: types are tables in product's own Postgres, the type agent is the DBA

- **One database.** Product has a single Postgres pool (`server/src/db/config.ts:22-31, 127`). It has no other
  dialect and no external connections. The only dialect it emits is `'postgres'` (`core/src/kinds/query.ts:1028`).
- **Table-backed types.**
  - The type agent authors a `SystemTypeDef`: a gin `code` object where each prop is a column.
  - `query_configure` then declares the identity (required, and it can never change), indexes, `defaultOrder`, audit
    stamps, owner scope and search documents (`core/src/kinds/type-configure.ts:1-40`, `design/type-agent.md:31-44`).
  - The platform makes a real table per type, through its own idempotent DDL:
    - `create table if not exists`
    - `add column if not exists`
    - defaults, foreign keys, CHECK constraints and search indexes
    - never `drop column` (`server/src/db/type-tables.ts:1-50, 854, 1767`)
- **Breaking edits** are a typed problem union (`type-configure.ts:2203-2215`). The answer is one of:
  - an agent-written `type_migrate` fn that runs once
  - a `populate` expression
  - an empty table
- **No approval for DDL or migrations.** This is an owner decision of 2026-08-13 (`type.ts:3592-3616`, QTU:3417-3419).
- **Auto-CRUD.** Every type gets generated `_list`, `_get`, `_insert`, `_update` and `_delete` fns, plus relation
  fns. They are refreshed without breaking callers when the type is edited (`query.ts:6031, 6606, 7296-7655`).
- **Writes** go through:
  - owner and audit binds that a caller can't forge
  - cascade in the application
  - one DataHistory row per row written (`query.ts:9695-9837`)
- **Platform records are queryable.** 20 core record types are hand-written `@aeye/query` types with RLS and FLS, and
  they are read-only (`core/src/query-types.ts:1-40, 1375-1461`; `design/queryable-system-types.md:16, 177-226`).
- **The query agent** is an agent fn whose tools appear as they become usable (`query.ts:4067-4790`). Its tools are:
  - `query_search` and `query_load`
  - `query_set`: a strict dynamic schema built from the engine. It prints the SQL, and auto-runs only a safe query
    with no params.
  - `query_test`, `query_examples`
  - `query_return`, `query_reuse`, `query_decline`
- **Fn signature** (`querySignature`, `query.ts:3524-3565`), in order:
  - the query's params
  - `limit`/`offset` when the query pages
  - one equality arg per filterable column
  - `sort` as an enum of the sorters
  - a search term
- **Results.** The model gets the full envelope, `{rows, row?, fields, outputType, total{known|atLeast}, limit, offset}`.
  The kind's `resultInstructions` has two versions (`core/src/catalog-kinds.ts:157-167`):
  - `rendered`: "the user can already see these results"
  - `headless`: "you are their only reader"
- **Visuals.** A rich widget registry: table, kpi, gauge, part-to-whole, category, distribution, cross-tab,
  time-series, calendar and raw (`app/src/widgets/registry.ts:164-175`).
  - **Ranking:** a hard gate, then coverage, then priority bands, then catalog order. A withheld visual is shown
    greyed, with its reason (QV:499-670).
  - **Memory:** the person's choice is kept per result shape (QV:685-695).
  - **Server side:** `list_widget_types` and `configure_widget` (`core/src/catalog-psf-fns.ts:65, 75`).

---

## 2. Side by side

| Area | Harness (build 5) | Product |
|---|---|---|
| **Connections and dialects** | Many instances, one database each: SQLite (new or existing), Postgres, SQL Server (`shapes.ts:17-53`). Secrets sealed in hub config (`shapes.ts:70`). Drivers: better-sqlite3, pg, mssql. | One Postgres pool from env (`db/config.ts:22-31`). Postgres SQL only (`query.ts:1028`). No external databases (TAO and QTU design none). |
| **Schema introspection, tables as types** | Its own reader per driver (sqlite pragmas, `pg_catalog`, `sys.*`) into `TableSpec` (`drivers/sqlite.ts:72-87`). Hub gin type via `tableToGinType`; engine type via its own `engineTypeOf` (`types.ts:423-461`). Two type models kept by hand. | No introspection. Types are authored first and the table follows. The only type over an existing table is `user` → `auth_user` through `TypeBacking.name` (QTU:4313-4317). Core records are hand-written query types (`query-types.ts`). |
| **Type enrichment** | Optional LLM pass per table, cached by schema hash on the hub type's `meta` (`instance.ts:196-207`). Adds description, `values`, a format as a regex, min/max, examples (`types.ts:257-299`). Hand-parsed JSON answer with retries (`author.ts:13-25, 49-73`). | None. Labels fall back to `humanize` (QTU:1441-1447). The type agent writes rich types on purpose instead: identity, per-field labels, options, defaults. |
| **Table-backed types, DDL and migrations** | Only on an external database with `schema: allowed`. `create_table` / `alter_table` take a gin row type → `ginTypeToTable` → `dialect.ddl.createTable/alterTable` → ordered steps marked `irreversible` (`impl.ts:123-167`). No data steps, no identity rules, no populate, no auto-CRUD. | Full ORM lifecycle in product's own database: `query_configure` (identity, indexes, audit, owner), its own DDL (`type-tables.ts`), compatibility problems with escapes, `type_migrate` / `populate`, logical-only drops, cascade (QTU:346-376, 1022-1074, 2740-2983). |
| **Query representation and the query kind** | Payload `{instance, description, query: QueryDef, sorters, list}` (`shapes.ts:75-86`). Args: params (all optional, a missing one binds NULL), `limit`/`offset` when a list, `sort` over the sorters (`compile.ts:129-148`). The page is capped (`env.ts:265-267`). | Implementation `{query, params, sorters, filters, drilldownName?}` (QTU:877-903). Signature: params, `limit`/`offset`, equality filter args (at most 12), `sort` enum, search term; owner/audit params are left out (`query.ts:3524-3565, 2104-2139`). A single-row read returns `row: optional<X>`. Drill-down fns for aggregates. |
| **Creating, finding and reusing queries** | `get_query` searches the hub (`fns_search` by kind and instance), reuses a match or writes, checks, saves and runs a query. `edit_query(name, instructions)` saves a new version (`index.ts:96-131`). The answer carries the fn name and signature, `how`/`why`, the SQL and the result (`shapes.ts:186-209`). The decision model (`ctx.decide`) is never used; with several databases it answers `{ask}` (`index.ts:104-105`) instead of using input's `ask_choice` as build-5-design 7 said. | `query_agent` with `query_search` / `query_load` (load switches to edit mode), `query_set` (strict schema), `query_test`, `query_return` / `query_reuse` / `query_decline` (`query.ts:4067-4790`). Hybrid `ts_rank_cd` + cosine search in the database (`server/src/db/search.ts`). Single system per query (`fns.md:33`). |
| **Agent design** | Prompt with tools (owner note met). The model writes raw QueryDef JSON against a `Json` arg (`shapes.ts:145`), with the syntax taught in the prompt (`index.ts:71-84`). The library's `buildSchemas` / `buildQueryTool` are not used. Sequential tools, 14 iterations at most (`index.ts:329-330`). | Prompt with tools; each tool's schema appears only once it is usable. `query_set` takes a schema built from the engine, so the model can't name a field that doesn't exist (`query.ts:4266`). |
| **Examples** | Static `examples` on every fn (`index.ts:207-390`). A saved query's first example is its creation args plus `askedFor` (`queries.ts:159`). `hub/fn_examples` pages them. | `query_examples` / `query_failures` replay recorded runs (`kinds/authoring.ts:1055-1093`). Static tool examples (`query.ts:3992-4063`). Instructions must hold worked examples (`fns.md:9`). |
| **What the LLM sees in results** | `ResultBlock`: `shown` sentence, columns, `rowCount`, `total`, `truncated`, `nextPage.call`, sort, a sample within a token budget, `fn` (`sdk/src/results.ts:32-43`). Always says "shown to the person". | Full rows (QV:1872-1880). `resultInstructions` in `rendered` and `headless` versions (`catalog-kinds.ts:157-167`). Tool results are cut at a character cap (`sdk/src/fn-error-text.ts:187`). `total` is `{known}` or `{atLeast}`. |
| **Approvals for writes and DDL** | Every write and every DDL change waits for a person, with a preview (dry-run count, matched rows, SQL, DDL, type diff). A rescan that breaks queries waits for admins (`impl.ts:211-218`). Approving runs it. | Query writes ask when `affected.types` is non-empty (`query.ts:10002`) or the user has no grant (`server/src/ai/dispatch.ts:277`). DDL and migrations: no approval (`type.ts:3592-3616`). |
| **Visibility and permissions** | `audience` (a ShareRule) per instance, checked at every run and preview (`queries.ts:60-63`, `impl.ts:458`). Saved fns shared to the audience. Types carry `audience` (`catalog.ts:144-157`). No row- or field-level security. | RLS/FLS on core types (`query-types.ts:1375-1461`). Owner-scoped business types whose binds can't be forged (`query.ts:9677-9705`). Field `visible` is a rendering hint only. |
| **Visuals** | Registry plus `match → {fits, score}`: table 0, bar 0.8, value 0.9. A switch between the visuals that fit; the choice is kept per message (`client/visuals.ts`). Other systems can contribute. | Gate, then coverage, then priority, then catalog index. Withheld visuals shown greyed with a reason. 10 families, choice per result shape in localStorage, server-side configure (QV:499-695; `widgets/registry.ts:59-118`). |
| **Where data lives** | Rows stay in the external database. Types, saved queries, examples and embeddings are in the hub; enrichment is on the hub type's `meta`. The instance keeps only pending changes, in memory (`instance.ts:148-156`). | Everything in product's Postgres: `system_type` rows, one table per type, `fn` rows with search columns (`db/tables.ts:307, 420-463`). |
| **Use of @aeye/query and gin** | Uses: `QueryEngine`, `parseQueryRequest`, `describeEngine`, `autoPaginate`, `toSQL`, `references`/`affected`/`parameters`, dialects and DDL, `tableToGinType` / `ginTypeToTable`. Re-does by hand: the engine type (`tableToQueryType` exists, `ddl/query-type.ts:23`), param checks (`argProblems`, `compile.ts:158`, where `engine.checkParams` exists, `engine.ts:476`), the field → gin mapping (`compile.ts:93-120`), the signature, and schema readers. | Uses much more: `parseQueryTool`, `buildSchemas`, `describeType`, `drillDown`, `makeResult`, filters, `SemanticEmbeddings`, `cost` / `outputCost` / `changeInterval` (`query.ts:19-72, 3607-3640`). Not the library's DDL: it writes its own. 20 library asks raised, all but A7, A11 and A20 shipped (`design/query-library-asks.md:1515-1519`). |
| **Test coverage** | 34 unit tests in `systems/database` (instance 10, link 8, drivers 3, live 2 skipped without Docker, renderers 11). 5 e2e tests in `e2e/build5.e2e.test.ts`. SQLite is tested for real; Postgres and SQL Server only on dialect output. No real-LLM test of the query agents. | Hundreds: `query-autocrud` 121, `type-configure` 121, `type-tables` 145 (DDL text), `search` 108, `query-types` 96, `widgets` 55, scoring 43, and more. Env-gated real-LLM suites: `type-agent` 15, `query-agent` 7. No live Postgres in the default run. |

---

## 3. Pros and cons

### Harness

**Pros**

- **Real external databases in three dialects** behind one `Database` interface (`drivers/database.ts:364-375`).
  - **Reads can't write:** SQLite refuses a statement that isn't read-only (`drivers/sqlite.ts:47-50`), and Postgres
    reads run in `BEGIN READ ONLY` (`drivers/postgres.ts:87`).
  - **Dry runs** roll back a write to preview it (`sqlite.ts:57-69`).
- **Approval is designed in.** Every write and DDL change shows what it will do, including the rows a delete removes
  (`queries.ts:230-273`) and the saved queries a narrowing schema change breaks (`impl.ts:146-149`). This is stronger
  than product, where DDL and migrations run unapproved.
- **No state in the system.** Types, enrichment (keyed by schema hash), saved queries, examples and versions are all
  in the hub. A fresh data folder still finds the drift (`instance.ts:209-250`; test `instance.test.ts:178`). This
  follows the owner's "hub stores everything" rule.
- **The model's view is designed and bounded.** It gets a token-budgeted sample, the exact next-page call and the fn
  signature (`sdk/src/server/results.ts:72-136`), with the full rows going to the UI. This is what the owner's build 5
  request asked for. Product still sends every row (QV:1872-1899).
- **Arg derivation is small and exact,** matching the request: params, paging when a list, sort
  (`compile.ts:129-148`). A query with its own top-N isn't paged (`compile.ts:84-90`).
- **Reads and writes per type are fn facts,** so the hub can search "queries that read X" (`impl.ts:176-179`,
  `impl.ts:108-117`).
- **Visuals can come from other systems** through the hub's registry and contributions, which product's browser-only
  registry can't do.

**Cons**

- **Two type models kept by hand.** `engineTypeOf` (`types.ts:423-461`) repeats the library's `tableToQueryType`
  (`aits/packages/query/src/ddl/query-type.ts:23`).
  - **The engine type loses most of the enrichment.** It keeps only descriptions and a "Usually one of" hint
    (`types.ts:430-432`), so the query checker never enforces the enriched value sets, formats or ranges that the hub
    type shows.
  - **It goes against the owner's "use the libraries" rule.** The mismatch was never reported as a library gap.
- **Hand-written pieces the library already has:**
  - **Param checking:** harness has `argProblems` (`compile.ts:158-168`); the library has `engine.checkParams`.
  - **Field → gin mapping:** harness has `ginOfField` (`compile.ts:93-120`).
  - **Signature:** harness has `signatureOf` (`compile.ts:182-186`).
  - **Enricher JSON parsing:** harness has `readAnswer` and a retry loop (`author.ts:13-73`) instead of aeye
    structured output.
- **The agent writes raw JSON with nothing to guide it.**
  - `QueryDraft.query` is `Json` (`shapes.ts:145`). The prompt teaches the syntax by hand (`index.ts:71-84`), and
    mistakes only show up through `check_query` round trips.
  - Product's strict engine-built schema (`query.ts:4266`) and the library's `buildSchemas` / `buildQueryTool` would
    stop invalid fields before the model sends them.
- **Run args are typed as any JSON.** `run_query`'s args are `ParamValues = record<any>` (`shapes.ts:120`), so the
  tool schema can't show the saved query's real args, and the prompt has to warn "never a string holding JSON"
  (`index.ts:134`, `impl.ts:173`).
- **The "shown to the person" sentence is unconditional** (`results.ts:101`). That is wrong when no person sees the
  result: a nested agent, an MCP call, or a background run. Product has a headless version
  (`catalog-kinds.ts:164-166`).
- **No filter args, no drill-down, no single-row `row` result, no `total.atLeast`.**
  - **Missing params:** they bind NULL silently (`compile.ts:205`), so a forgotten filter compares with NULL and
    returns no rows instead of being refused.
- **Tables-as-types stops at "type".**
  - There's no identity or natural-key handling beyond the primary key, and no owner/RLS.
  - There's no auto-CRUD, so every insert means writing a query.
  - `alter_table` can't migrate or fill data: a new NOT NULL column on a table with rows just fails.
- **Enrichment outside a run is refused.** It is put off to the next run (`instance.ts:153-156, 360-373`): a
  workaround for the missing `ctx.ai()` outside runs (build 6 item 3).
- **The design asked for the decision model and input's `ask_choice`, but neither is used.**
  - Picking a database or a saved query is left to the model reading `fns_search` hits (`index.ts:104-107`).
  - Choosing between databases is an `{ask}` answer.
- **`run_query` is marked `mode: 'read', free`** (`index.ts:315`) although it can start a write.
  - The write is still approved, so this is safe.
  - But the chat mode `read` offers a tool whose job may be a write, and the fn's facts under-report.
- **Thin tests.** There is no real-LLM run of `get_query`, and Postgres and SQL Server are never run live without
  Docker (`drivers.live.test.ts`).

### Product

**Pros**

- **A complete ORM lifecycle.**
  - Identity, indexes, audit and owner scope are declared with the type.
  - Edits are diffs where leaving something out is never destructive (QTU:644-689, 2857-2892).
  - Required columns are added in safe phases, and indexes are built `CONCURRENTLY` (QTU:1022-1074, 1308-1320).
  - Fields are dropped logically only (QTU:2902-2913).
- **Auto-CRUD and relation fns** let a model read and write a type with no query writing at all
  (`query.ts:6031-6606`). This is the "treat types like an ORM" intent (TAO:3-28).
- **The model is guided as it authors.** Tools appear in stages, `query_set` has a strict schema, and safe queries
  auto-run, so the model sees real rows while it writes (`query.ts:4067-4500`).
- **Security that holds.**
  - RLS/FLS on queryable core types, and owner/audit binds a caller can't forge.
  - Execution fails closed as non-admin (`query.ts:9677-9705`).
  - Cascade in the application keeps history (QTU:2024-2069).
- **Result instructions depend on whether a person is watching** (`catalog-kinds.ts:157-167`).
- **Visual ranking explains itself.** Coverage ranks first, then priority; a gate hides what can't draw the data, and
  withheld visuals show with a reason (QV:499-670). Choices are kept per result shape.
- **The platform's own records are queryable** (`queryable-system-types.md:16-226`).
- **Very wide test coverage,** plus env-gated real-LLM suites.

**Cons**

- **One Postgres, nothing external.** The design never covers dialects, connections or reading an existing schema
  (first agent's survey; TAO and QTU only mention `Dialect.lateral`, TAO:602).
- **DDL and agent-written migrations run with no person approving** (`type.ts:3592-3616`; QTU:3417-3419). The doc
  admits a migration "runs against real rows with no human approval".
- **Its own DDL instead of the library's** (`type-tables.ts`, 2.7k+ lines). Postgres-only features are spread
  through it (QTU:1509-1511).
- **Full rows go to the model,** a known recurring token cost (QV:1882-1899). The "don't list rows" prompt line was
  never written (QV:1882-1890). (`resultInstructions` covers some of this now.)
- **Query fns have no version history.** Re-describing dependants is only a boot repair (QTU:826-845). "Who
  references X" reads the whole `fn` table (QTU:4458).
- **Filters are equality only** (QV:216-217), and the normalizer is unbuilt: transforms are wired in series at three
  call sites, which is the defect class (`design/query-transforms.md:362-365`).
- **Size and complexity.** `kinds/query.ts` is 10k lines and `kinds/type.ts` 5.3k. Many parts are designed but not
  built: multi-type authoring, type renderers, the migration runtime (`design/multi-type-authoring.md:9`, QTU:3614).

---

## 4. Departures and improvements

### Where harness departs from product's intent or the owner's notes

1. **"Use the libraries fully; report gaps, no workarounds"** (`docs/harness.md` Decided; build-5-feedback.md).
   - Harness re-does by hand:
     - `tableToQueryType` (`types.ts:423`)
     - `checkParams` (`compile.ts:158`)
     - field → gin (`compile.ts:93`)
     - schema readers (`drivers/*`)
     - structured LLM output (`author.ts:13`)
   - None of these is listed as a library gap in build 6 item 4.
2. **"Adds query kind like in product"** (the build 5 request). Product's kind has filter args, drill-down,
   single-row `row` results, `total.atLeast` and a strict authoring schema. Harness has none of them. Its arg set
   matches the request's literal "params, limit & offset, sorters", but not what product had built.
3. **"Table-backed types similar to product"** (the request). Harness builds DDL from a gin type, but only against
   an external database. There's no hub-owned table store, no identity or `query_configure`, no auto-CRUD, and no
   populate or migrate. Product's table-backed types are rows the hub owns.
4. **The decision model** (the request: "Could use decision model"; build-5-design 7: "`ctx.decide` when close,
   else `input` `ask_choice`"). Harness uses neither (no `decide` in `systems/database`).
5. **"Nothing the LLM needs is left out."**
   - The tool schemas for `run_query` and `save_query` carry `any JSON` args (`shapes.ts:120`).
   - The hub type has the enriched value sets, but the engine never enforces them (`types.ts:431`).
6. **Queryable system types.** Product made hub records queryable through `@aeye/query`. Harness serves its lists
   through a separate list-query model (`packages/hub/src/query/index.ts:1-5`). That model is fine for the UI, but
   the chat can't join or aggregate over hub records with the query kind.
7. **build-6.md is partly stale for this system:**
   - "The database system still keeps a local store, `store.ts` … `database.json`": no `store.ts` exists, and
     enrichment and hash already live on the hub type's `meta` (`catalog.ts:88-92`, `types.ts:295-299`).
   - "`QueryResult` uses the SDK's `ResultBlock`": already done (`shapes.ts:99, 133`).
   - The leftover lines should be marked done or reworded. The real remaining piece is that `meta` is readable
     through `ctx.types` and indexed.

### Where product was weaker and harness is better

1. **Approvals.**
   - Harness: every write and DDL change waits, with a concrete preview, and approving runs it.
   - Product: DDL and migrations run unapproved.
   - The owner asked for approval in build 5, so harness's model should win wherever they meet.
2. **External databases and introspection.** Product had none.
3. **What the model reads.** A budgeted sample plus the exact next-page call beats sending full rows.
4. **Version history and hub search for saved queries.**
   - Harness: `save_fn` with `replace` keeps versions, and "who reads type X" is an indexed search
     (`impl.ts:108-117`).
   - Product: a whole-table read (QTU:4458).
5. **Stateless system and schema-hash caching.**
6. **DDL through the library.** Harness's `ginTypeToTable` keeps the physical details of `current` that the type
   doesn't change (aits `ddl/gin.ts:170-182`), and plans steps for three dialects. Product's DDL is Postgres-only
   hand-written text.
7. **Visuals from other systems** through hub contributions.

---

## 5. Recommended reconciliations (by priority)

Sizes: **S** is under a day, **M** is a few days, **L** is a week or more. **B6** means it overlaps
`docs/plans/build-6.md`.

| # | Recommendation | Keep from | Size | B6 overlap |
|---|---|---|---|---|
| 1 | **One type model in the library.**<br>- Add `ginTypeToQueryType` (or `tableToTypes(spec, enrichment)` returning `{gin, query, backing}`) and `fieldTypeToGin` to `@aeye/query`.<br>- Reconcile `tableToQueryType` with harness's `engineTypeOf`: relation names, `casing: 'exact'` for uuid, a `TypeBacking` with physical names and FK keys, db default → optional on insert.<br>- Harness then deletes `engineTypeOf`, `ginOfField` and `fieldTypeOf`, and the enrichment reaches the engine (enforced `values`, ranges). | harness needs, library owns | M | Item 4 (library gaps): add it there |
| 2 | **A typed query schema for the agent.**<br>- `check_query` and `save_query` take a `draft.query` whose tool schema comes from `@aeye/query`'s `buildSchemas`/`querySchema` for that database's engine, as product's `query_set` does (`query.ts:4266`).<br>- A per-instance schema needs a fn whose args depend on the instance; for now `tables` could return the schema.<br>- Drop the hand-taught JSON grammar from the prompt (`index.ts:71-84`). | product | M | none; add to item 2 |
| 3 | **Library helpers for a query fn's signature and checks.**<br>- `@aeye/query` gets `argsTypeOf(query, {sorters, filters, paging})` → gin, `signatureOf`, and `checkParams` for call args.<br>- Harness uses them in `describe` and `run_query`.<br>- Make a missing *required* param an error instead of NULL (`compile.ts:205`). Product's `querySignature` (`query.ts:3524-3565`) is the reference, including the owner/audit param exclusion. | both | M | item 4 |
| 4 | **Result instructions by audience.** `resultBlock({ surface: 'rendered' \| 'headless' })` with product's two texts (`catalog-kinds.ts:157-167`). The hub passes `headless` when no person will see the attachment (nested agent, MCP, background). Keep harness's budgeted sample. | both | S | none |
| 5 | **Fix the misreported facts.**<br>- `run_query` should say `mode: 'write'` when it may propose one, or split into `read_query` / `write_query`.<br>- `save_query` stays read.<br>- Use the kind's `effects` so chat mode `read` doesn't offer what only proposes writes. | harness | S | the "kinds estimate cost" leftover |
| 6 | **Use the decision model and the input system as designed.**<br>- `get_query` calls `ctx.decide` (a tool, or in the reuse step) when `fns_search` returns close candidates.<br>- It asks with `input/ask_choice` instead of the `{ask}` answer. | build-5-design | S | the "fleet listing" leftover |
| 7 | **Schema readers in the library.**<br>- Move `drivers/{sqlite,postgres,sqlserver}.ts` schema reading into `@aeye/query` as `readSchema(dialect, run)` → `TableSpec[]`, next to `readColumnType`/`readDefault` on `DdlWriter`.<br>- Product could then use the library's DDL with `current` from its own database's catalog. | harness → library | M | item 4 |
| 8 | **Enrichment against named gin formats, with aeye structured output.**<br>- Formats become gin extensions (`registry.extend('text', {name: 'email', …})`) that match `@aeye/query` refinements (`{kind: 'text', as: 'email'}`), instead of regex patterns (`types.ts:261-269`).<br>- `ginToColumnType` treats them as their base type.<br>- The enricher uses `ctx.ai()` structured output, so `readAnswer` and the retry loop go. | harness, library | M | item 3 (`ctx.ai()` anywhere) unblocks the run-less enrichment |
| 9 | **Migrations with data steps, under harness's approval.**<br>- Extend `DdlStep` plans with product's phased patterns: add nullable → fill (`populate` expression or default) → `SET NOT NULL`; primary-key acquisition; rename hints instead of `DdlError`.<br>- Every plan still goes through harness's approval preview. | product's phases, harness's approval | L | none |
| 10 | **Hub-owned table-backed types (product's ORM) on the same path.**<br>- A hub-owned store (the hub's SQLite, a `hub` database instance, or a `database` instance flagged as owned) where the type agent authors types and the dialect makes the tables.<br>- Auto-CRUD fns are derived per type (a kind payload `{type, op}` whose `describe` derives args).<br>- Identity and owner scope via `query_configure`-like fields on the type `meta`.<br>- Start with auto-CRUD over the existing external tables: it alone saves most "insert a row" queries. | product | L | none: a new build item |
| 11 | **Visual ranking like product's.** Change `VisualFit` from one score to `{gate, coverage, priority, withheld?, because}`; table at full coverage, priority 0. Keep the choice per result shape (`hash(fn, columns:kinds)`), not per message. Add kpi/time-series/category families as contributed visuals. | product's model, harness's registry | M | the visuals leftover (injection key, labels) |
| 12 | **Filters, drill-down, single-row `row`, `total.atLeast`** in the query kind's `describe`/`run`, using the library's `filters` and `drillDown` (`transforms/drill-down.ts:616`). Filter args beyond equality are a library ask. | product | M | none |
| 13 | **Hub records as queryable types.** Expose hub tables (runs, fns, model calls, resources) as read-only `@aeye/query` types with person-scoped access (backing `access`), as product's `query-types.ts` did, so the chat can aggregate over them with the same kind. | product | L | none |
| 14 | **Tests that match the risk.**<br>- A real-LLM, env-gated `get_query` / `edit_query` suite (reuse vs create, a write approved, a breaking rescan).<br>- Postgres and SQL Server live tests in CI on the self-hosted runner.<br>- Port product's DDL text tests to the library's dialect writers. | product | M | the tests leftovers |
| 15 | **Correct build-6.md:** the `store.ts` and `QueryResult` leftovers are already done (section 4, item 7). | — | S | yes |

### One shared path, in short

`@aeye/query` should own the steps from table to types to query. Then an external database (harness) and a
hub-owned store (product's design) differ only in:

- where `TableSpec` comes from: read from the database, or derived from an authored type
- who approves the DDL plan

The steps the library should own:

1. `TableSpec`, plus an optional enrichment, becomes the gin type, the engine type and the backing (rec. 1).
2. Gin args and the signature come from the query (rec. 3).
3. The model gets a strict authoring schema (rec. 2).
4. DDL plans carry data steps (rec. 9).
5. Schemas are read per dialect (rec. 7).

Harness's approval, hub storage and result block sit on top for both.
