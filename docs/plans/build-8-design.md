# Build 8 design (binding)

The spec is [build-8.md](build-8.md). This page says, per item, what exists, what changes, which files and which lane
owns it. The shared contracts are already in `packages/core` (listed per item); a lane that needs a change to them
writes it in its report. Lanes: **platform** (`packages/core`, `packages/sdk`, `packages/build`, `packages/cli`,
library branches), **hub** (`packages/hub`, `docs/reference/hub-surface.md`), **systems** (`systems/web`,
`systems/database`, `systems/template`, `systems/input`), **fs** (`systems/fs`, `scripts/docs`, the generated
`packages/sdk/AUTHORING.md`), **web** (`packages/web`, `ui-tests`).

Order: platform first (SDK builders and the `flags` / `mentions` link plumbing every system needs), then hub, systems,
fs and web in parallel against the core contracts. Every new table goes through the store's generic layout
(`HUB_TABLES`); the hub lane adds its indexes in `store/schema.ts` and the migrations.

## 1. Widget system

**Exists.** The database system hosts the `database/query-visuals` registry (table, bar, value) with client match
logic (`VisualFit`, `barFit`/`valueFit` in core `registries.ts`); the web app's result view
(`components/results/`) picks the best fit and switches between fits; `ResultTable` is the one result shape. Nothing
saves a widget, nothing declares what data a visual takes, rows have no actions.

**Changes** (contracts in `core/widgets.ts`, `core/registries.ts`):
- **One registry, hosted by the hub:** `hub/visuals` (`HUB_VISUALS`). The hub's manifest declares it; the database
  system's three visuals move to it (`contributes` with registry `hub/visuals`), and `database/query-visuals` goes.
  `ContributionDecl.shape` (`VisualShape`: channels with the column kinds they accept, row range, `whole`) declares the
  data a visual draws, so the hub and the authoring agent judge fits without client code (`declaredFit`). The client
  match logic still scores. The app's built-in table, bar and value get shapes too.
- **A widget is a fn of kind `hub/widget`** (`WIDGET_KIND`), payload `WidgetSpec`: a source fn returning a
  `ResultTable`, the visuals offered with their channel bindings, a control per source arg (label, choices, pinned,
  hidden), the paging args the pager drives, and the row actions kept. The kind's `describe` gives args = the source's
  minus pinned and paging, returns `WidgetResult`, deps = the source, mode = the source's. Its handler calls the
  source as a child run, re-checks bindings against the real columns (problems listed, never a failure), and returns
  `WidgetResult`. Versions, visibility, review and search come free as for any fn.
- **Actions are derived** from the methods of each row's type (`ResultColumn.ref`), labelled by `actionLabel`, with
  a gin form for args left after binding; `WidgetSpec.actions` narrows and relabels; `confirmOf` makes anything above
  `read` confirm (a widget may add a confirm, never remove one). Nothing runs until a click; the action is an ordinary
  `invoke` run, so policies, approvals and the mode gate apply. `then` is `refresh`, `show` or `none`. Web
  `widgetActions` returns `WidgetActionOption`s.
- **Authoring:** `hub/make_widget` (`MakeWidgetArgs`), a prompt with tools on `authoringAgent()` with real instructions
  and examples: tools `widget_source` (the source's args and a sample run with a small limit), `widget_visuals` (the
  visuals whose shapes fit the sample), `widget_check` (`WidgetCheck` → problems), `widget_save` (creates or replaces
  the `hub/widget` fn, declared effect `fns create/update kind hub/widget`). Port product's widget-authoring intent:
  the strict schema is built from the source's args and the fitting visuals at tool time.
- **Chat:** a widget run renders with `WidgetView` (the result view plus the control bar, pager and row action menu);
  any run whose result is a `ResultTable` gets a "Save as widget" action that starts a chat turn asking `make_widget`.
  The chat agent's instructions say results of query-shaped fns draw as widgets (product's routing lesson).

**Files and lanes.** platform: `sdk` (`widget` exports for `kindProps`, `VisualEntry` takes `shape`; `HUB_VISUALS`
in the client runtime). hub: `packages/hub/src/widgets/` (kind describe and handler, `make_widget` agent and its tools,
`widgetActions`), the hub manifest's registry and fns, `api/web/widgets.ts`. systems: `systems/database` moves its
visuals to `hub/visuals` with shapes. web: `components/results/` takes `WidgetResult`, `WidgetView.vue` with
`widget-state.ts` (controls, paging, actions over callers), the action confirm and form, "Save as widget", widgets in
the Data page's list (§2). Tests: kind describe and handler units, `declaredFit` and `confirmOf` units, a
`make_widget` mocked-model test, `WidgetView` component tests, one browser check of a widget at phone and desktop.

## 2. Data system

**Exists.** Nothing: shared data either lives in a system's own folder (the worked example's file store) or in an
external database through the database system. Product's data surface has "manage data" (pieces: `table`, `value`
blob, `secret`) and "browse tables" (records of every stored type, inline edit, history, relation links).

**Definition.** The data system is records of **stored types**, kept and searched by the hub (`core/data.ts`). A type
is stored when its `TypeDecl.records` (`RecordStorage`: `table` or `value`, `shared` or `person` owned, text fields and
`embed` for search) is set, in a contract or at runtime, so stored types get origin, visibility, review, versions and
the graph like any type. Records are rows of `records` (`DataRecord`: value as JSON checked against the type, title
from `display.title`, version, who and which run changed it), every change writes `recordVersions`. Reads are queries
with a page: `ListQuery` filters and sorts on the type's top-level fields pushed into SQL (`json_extract`), text search
through the store's `TextIndex`, semantic search through the `index` table (kind `record`, embedded as a model call).
No load-all, no in-memory filtering. Access: who sees the type sees `shared` records; `person` records only their
owner and admins. Secrets stay sealed secrets, never records.

**Surfaces.**
- Hub link (capability `data`): `records`, `record`, `recordTable`, `saveRecord`, `removeRecord`, as the run's
  person (`run`) or the system outside a run. SDK `ctx.data` over them (`find`, `get`, `table`, `save`, `remove`).
- Hub fns `hub/records_find`, `hub/record_get`, `hub/records_table` (a `ResultTable`, the source a widget draws),
  `hub/record_save`, `hub/record_remove`, declared with the new registry thing `records`; `hub/data_sets`.
- Web `dataSlice` and the **Data page** `/data` (stored types by system with counts) and `/data/:type` (records as the
  result grid with search, filter and sort from the URL, inline edit with gin editors, a record drawer with its
  history, "Show as widget"), `/data/:type/:id` for one record. Saved widgets list under `/data/widgets`.
- Effects enforcement and fn facts know `records`; the graph shows stored types with a records count.

**Files and lanes.** platform: `TypeDecl.records` in the SDK `type()` builder, `ctx.data`, the fake hub in
`@harness/sdk/testing` answers the data endpoints from an in-memory table **only in tests**. hub:
`packages/hub/src/data/` (`index.ts` interface `DataService`, `StoreDataService`), store indexes
`records: [['type','updatedAt'], ['owner']]`, `recordVersions: [['record','number']]`, link handlers, hub fns,
`api/web/data.ts`. web: `pages/DataPage.vue`, `data/` state and callers. fs: the worked example (§10).

## 3. Bash change capture and diffs

**Exists.** fs `bash` returns `{ exitCode, stdout, stderr }` (`server/commands.ts`, `server/shell.ts`); `CliGit`
parses `git status` (`server/git.ts`); `DiffView.vue` draws one before/after diff for `write`/`edit`.

**Changes** (`core/changes.ts`): `bash` returns `CommandResult & { changes?: ChangeSet }` (the fs gin type mirrors the
core schema with a compile-time `Equal` test). Capture (`server/changes.ts`, interface `ChangeCapture` in
`server/index.ts`):
- Inside git: `git status --porcelain=v2 -z` before and after, plus a content hash of every already-dirty file
  before the call (copies of small text ones kept in the snapshots folder). After: files whose status or hash moved
  are the call's; `git diff` for files clean before, `git diff --no-index <kept copy> <file>` for ones dirty before,
  untracked files diffed against nothing. Ignored files are counted (`ignored`), not listed.
- Outside git: a recursive watcher on the call's cwd for the call's life; files listed, `noDiff: 'not-in-git'`.
- Tying: a change counts when seen during the call in its tree; when another fs call ran in the same tree at the
  same time the file gets `certain: false`. Binary (NUL in the first 8 KB), large (`FS_DIFF_MAX_BYTES`) and sensitive
  (§4) files have no diff. Caps `FS_CHANGES_MAX_FILES`, `FS_DIFF_MAX_BYTES` in fs `server/env.ts`.
- Web/fs client: `BashView.vue` gets a "Changes" strip under the output: a tab per changed text file with its diff
  (`DiffView` takes a unified patch as well as before/after), plus a list of files without diffs and why.

**Lane:** fs (server and client). Tests: capture units in a temp git repo (clean, dirty-before, untracked, rename,
binary, ignored, concurrent), `BashView` component test with tabs.

## 4. fs safeguards and the auto-mode classifier

**Exists.** `server/secrets.ts` `DEFAULT_SECRETS` globs keep files out of resources only; the fs fns (`read`, `write`,
`grep`, ...) are not checked. The classifier sees fn, mode, effects line and args (`fns/auto.ts`).

**Changes** (`core/sensitivity.ts`):
- **One list per fs instance:** `SensitivityRule[]` (glob, content pattern, or `gitignored`; `except`; `read` allow
  / ask / refuse; `write` ask / refuse; `why`). Defaults in fs `server/sensitive.ts` (`DEFAULT_SENSITIVITY_RULES`:
  gitignored read ask; `.env*` except `.env.example`, keys, credential files, `.npmrc` / `.netrc` / `.git-credentials`
  read ask; content patterns for private keys, AWS/OpenAI/GitHub-style tokens and `password=` lines read ask; all
  writes ask). fs config `sensitive?: SensitivityRule[]` replaces `secrets` (a config with `secrets` is converted on
  load). The same list decides what is never served as a resource, so `secrets.ts` folds into `sensitive.ts`.
- **Before a run:** `FnDecl.flags` on fs `read`, `write`, `edit`, `remove`, `grep`, `glob`, `list`, `bash`. The hub
  calls `flags` on the system link (body `PreviewRequest`, answer `FlagsAnswer`) before the mode gate and policies,
  then applies `flagsVerdict`: refuse → invalid input with the rules' words; ask → the run waits for the person with a
  `flags` preview part (never remembered, never passed by a policy or by `auto`); pass → as today. In `auto` mode the
  classifier gets the flags (`ClassifyInput.flags`, one line each by `flagLine`, plus an instruction and an example).
  For `bash`, fs flags paths it finds in the command line (`certain: false`); after the call, changed sensitive files
  show in `ChangeSet` without a diff. `grep`/`glob`/`list` leave sensitive files out of results unless the person
  approved (`read: allow` rules keep them).
- **Tests:** the rule list as a table test (each default rule, `except`, content scan, gitignored via a temp repo),
  `flagsVerdict` units, the hub's gate order (refuse, ask, auto sees flags) with a fake system, one e2e-free API test.

**Lanes:** platform (`FnDecl.flags` in the SDK `fn()` builder; the SDK runtime serves `flags` from a
`flags(ctx, args)` hook on the fn), fs (rules, flags, results filtering), hub (`execution/runs.ts` asks before
`#mode`, `fns/auto.ts` and `fns/index.ts` `ClassifyInput.flags`, approval card part), web (the `flags` preview part on
the approval card).

## 5. Configurable hub name

**Exists.** `HUB_INFO.name = 'Harness'` (`hub/src/boot/info.ts`), `SetupState.name`, `AppBrand.vue` and `AppShell.vue`
and `index.html` say "Harness"; no web manifest.

**Changes** (`core/identity.ts`): the name is the admin's setting (hub option `hub.name`) else env `HARNESS_NAME`
else "Harness" (`hubNameOf`). Web: `identity` (open GET), `setHubName` (admin; `null` clears), user event
`identity`. Hub: `boot/identity.ts` (`HubIdentityService`: read, set, publish), `SetupState` from it, `index.html`
served with `<title>` and `apple-mobile-web-app-title` replaced, a generated `/manifest.webmanifest` (`name`,
`short_name`), push notification titles, the OpenAPI docs title, the hub actor's name. Web: `state/identity.ts`
(loaded before sign-in, updated by the event), `AppBrand`, the sign-in and setup page, `document.title` (`<page> -
<name>`), the version line, the Settings page field (admins). **Check:** a component test sets a custom name and finds
it on the sign-in page, in the shell and in the tab title, and a source scan test fails on a visible "Harness" in
`packages/web/src` templates and strings (code names allowed).

**Lanes:** hub, web. `HARNESS_NAME` lives in the hub env slice.

## 6. Audit leftovers and owner answers

| Item | Change | Lane |
|---|---|---|
| API grouped and indexed | `FnDecl.group`, `Manifest.groups` (`core/api-index.ts`). The catalog writes, in the manifest's or patch's transaction, a context item `<system>/api` (groups as `choices`) and one `<system>/api.<group>` per group (its fns, one line each, from a query of that system's fns by group), origin `system`, declared `runtime`; the hub's own fns get groups (chat, runs, context, resources, data, widgets, admin, ...). fs, database, web, input, google-calendar, embedder name their groups. | hub, platform (SDK `fn({ group })`, `system({ groups })`), systems, fs |
| Version history for every item | One `itemVersions` table (`core/versions.ts`) written by the catalog for every section on manifest import and `RunningSystem.patch` (hash compare, no version for an unchanged item); `fnVersions` and `typeVersions` rows migrated in, then those tables dropped from `HUB_TABLES` with their readers moved. Web `itemVersions`, hub fn `hub/item_versions`; the system page's item drawer shows history. | hub, web |
| No whole-table caches or load-all | `AccessService`: read by `access` key per check (no process cache). Catalog: `fnSignatureTypes` table (written in the fn's transaction) replaces `#referencing`, `#others`, `#redescribeKindsOf` scans and `#describedTypes`; fns by kind from `fnFacts.kind`. Types and manifests stay cached for gin's synchronous lookup, invalidated on every write. Resources: `family` and `source` columns (migration), facets by store group-by, text by `LIKE`/FTS, date and folder buckets by query. | hub |
| METRIC_DEFAULTS into settings | An env slice in `contextor/env.ts` with 18 settings generated from the metric list (`HARNESS_METRIC_<NAME>_WEIGHT`, `_TARGET`, `_K`); `score.ts` reads them; per-contextor overrides stay. | hub |
| Mention search tied to the request | `mentions` body carries `request: MentionRequestId`, minted per search, kept with person and session for `HARNESS_MENTION_REQUEST_TTL`; hub link `mentionResources` (`MentionResourceSearch`) searches as that person, refused for an unknown, stale or other system's request. SDK: `ctx.resources.search` on a mention ctx uses it. Web system: `RecentPages` and `WEB_RECENT_PAGES` go; page mentions search `web` roots through it. | platform, hub, systems |
| Notices on approval and running cards | Show `FnFacts.notice` ("usually takes about 3 minutes") on the approval card and a running run's card, from the facts the store already holds. | web |
| Needs-config grace | `HARNESS_CONFIG_NOTICE_GRACE` (hub notifications env, default 30 s): the `config-needed` notice waits that long and is dropped if the system connects configured first. | hub |
| Paging helper | `api/paging.ts` `collect`/`first` move into `store/rows.ts`. | hub |
| Old `{ input }` wording | `docs/reference/hub-surface.md` lines for `configure_provider`, `remove_rule`, `set_model_role`, `resource_import`. | hub |
| Graph overlap on the real stack | Check the fs cluster on a real stack; first load fits with labels shown (zoom floor), overlaps fixed. | web |
| Duplicate "New chat" | One "New chat" on desktop. | web |
| Owner's sign-in notes | Done in `9b49d1b`; keep. | — |

## 7. The worked example on hub data, and doc parts (fs lane)

- `scripts/docs/example`: notes become a stored type (`records: { shape: 'table', owner: 'person', search: { text:
  ['title', 'body'], embed: true } }`), `add`/`find` use `ctx.data.save` / `ctx.data.find` with `search`; no file
  store, no `ctx.dataDir` for shared data. `start.md` and `mistakes.md` get a "where data lives" rule (shared data is
  hub records; a system's folder holds only its own config and keys).
- Split large parts: `core-types` by source module, `examples` one part per example file, `hub`, `testing.reference`
  and `internals` by their second-level sections; each split index part gets a `choices` list. Budget: no part over
  ~25 KB. `npm run docs:authoring -- --check` stays green.

## 8. Contracts added to `packages/core` (done in this step)

- `sensitivity.ts`: `SensitivityKind`, `SensitivityRule`, `SensitivityMatch`, `SensitivityFlag`, `FlagsAnswer`,
  `flagsVerdict`, `flagLine`; `FnDecl.flags`; `PreviewPart` `flags`; system link `flags`.
- `changes.ts`: `FileChange`, `ChangeSet`, `NoDiffReason`.
- `identity.ts`: `HubDisplayName`, `HubIdentity`, `SetHubName`, `hubNameOf`, `HUB_NAME_OPTION`; `SetupState` derives
  from it; web `identitySlice`; user event `identity`.
- `versions.ts`: `ItemVersionRecord`, `ItemVersionsQuery`/`Page`; table `itemVersions`; web `versionsSlice`.
- `data.ts`: `RecordId` (`rec_`), `RecordStorage` (`TypeDecl.records`), `DataRecord`, `RecordVersion`, the query, save,
  remove and table shapes, `DataSetView`; tables `records`, `recordVersions`; registry thing `records`; capability
  `data`; hub link and web `dataSlice` endpoints.
- `widgets.ts` and `registries.ts`: `HUB_VISUALS`, `WIDGET_KIND`, `VisualChannel`, `VisualShape`
  (`ContributionDecl.shape`), `WidgetSpec` and its parts, `WidgetResult`, `WidgetActionOption`, `MakeWidgetArgs`,
  `WidgetCheck`, `confirmOf`, `actionLabel`, `declaredFit`; web `widgetsSlice`.
- `api-index.ts`: `ApiGroupDecl` (`Manifest.groups`), `FnDecl.group`, `apiContextName`, `GENERAL_GROUP`.
- `mention-search.ts`: `MentionRequestId` (`mrq_`), `MentionResourceSearch`, `MentionResourceHits`; `mentions`
  carries `request`; hub link `mentionResources`.
- `fn-facts.ts`: `FnSignatureType`; table `fnSignatureTypes`.

The new web endpoints and link endpoints are declared but not yet served: the hub lane serves them (stubs marked
`build 8: hub lane` where typecheck needed one).

## Status (end of build 8's lanes, before the widget pass)

Integrated in `06318e0`, `cc98732` and two review rounds (`9d356ac`, `c173718`). `npm run check` is green (one
timing-dependent Shiki test was made deterministic in the final step).

**e2e (final step):** 11 of 15 files passed on the full run. Two failures were real and are fixed: a root git ignores as
a whole (a root inside a data folder such as `.harness-test/`) had every file hidden by the `gitignored` rule
(`systems/fs/server/sensitive.ts` now asks only about the files of roots git doesn't ignore), and an instance
configured at pairing answered no roots because the hub asked with the manifest, before the start its roots follow
from (the SDK host now sends a roots-only patch after `started`; `package` and `pairing` pass). Still failing on the
shared, loaded embedder (embed batches closed, 4 s query waits): `chat` "suggests fns from the embedding of a draft
message" (60 s wait for `fs/read` to be indexed) and `build5` "reuses it for a request like it" (the free model wrote
`customers_by_order_count_2` instead of reusing the saved fn, whose search leans on embeddings). Neither was
re-checked on an idle embedder.

1. **Widget system: built as designed above, not yet as the owner's answers ask.** Done: `hub/visuals` hosted by the
   hub with declared shapes (the database system's table, bar and value moved there), the `hub/widget` kind
   (`packages/hub/src/widgets/`), derived row actions with `confirmOf`, `make_widget`, `WidgetView` with controls,
   pager and actions, "Save as widget" in chat, `/data/widgets`. **Left for the widget pass** (build-8-feedback.md,
   "What the answers mean"): widgets as a bundled `widgets` system rather than a hub kind; ECharts for every
   row-and-column series in about 12 families with a style picker; the extended shape and product's coverage-first
   ranking; presets, relative dates, chip row and product's buffered pager; drill actions, derived `then`, write forms
   then confirm, read-only rows from a write; propose-preview-Save authoring with the strict schema built per call;
   the derived routing line and summary-plus-rows tool result; record tables in the one widget view with inline edit;
   the accent-tuned palette, phone rules and PNG/SVG export; realtime widgets over live sources and streamed export.
   Dashboards stay "later".
2. **Data system: done.** `packages/hub/src/data/` (`StoreDataService`), the `data` link capability and `ctx.data`,
   the hub fns, `/data`, `/data/:system/:local/:id?` with search, filter, sort and a record drawer with history.
   Record tables use the result grid, not yet the widget view (widget pass).
3. **Bash change capture and diffs: done.** `systems/fs/server/changes.ts` (git and watcher capture, `certain`,
   binary/large/sensitive without a diff), the Changes strip in `BashView`.
4. **fs safeguards and the classifier: done.** `systems/fs/server/sensitive.ts` (the one rule list; `secrets.ts`
   folded in), `flags` on the fs fns, the hub's gate (refuse, ask, `auto` sees the flags), the `flags` approval part.
5. **Configurable hub name: done.** `boot/identity.ts`, `index.html` and `/manifest.webmanifest` rewritten, the
   Settings field, `document.title`, the source scan test.
6. **Audit leftovers: done**, as listed in the table: API groups as context items, `itemVersions` (old version
   tables migrated in on start; their table definitions stay only for that migration), `fnSignatureTypes` in place of
   the catalog scans, metric settings, mention requests (`RecentPages` gone), notices on approval and run cards, the
   config-notice grace, `store/rows.ts` paging, the hub-surface wording, one "New chat" on desktop, the graph's zoom
   floor. The graph overlap check on the real stack was not repeated in the final step.
7. **Worked example on hub data and doc parts: done.** Notes are a stored type used through `ctx.data`; the "where data
   lives" rule is in the guide (`parts/data.md`); large parts are split and every part is under ~25 KB.

**Library branches:** aits and ayepi `harness` branches are committed and clean, their dist builds current.
