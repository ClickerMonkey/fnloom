# Systems out of the box, the context and research layers, every device (2026-11-26)

Research for the marketing site's "systems out of the box" and "same experience on every device" messages. It
builds on `docs/site/research/harness-features.md` and keeps to its **Do not claim** list (repeated where it bites).
Paths are relative to the repository root (`E:\GitHub\harness`). Facts only: where something is partial or untested,
the row says so.

**How "install" works today.** There is no installer or hosted product. A hub is run from this repository
(`npm run dev`, or `npm run live` for a frozen build) with the aits and ayepi checkouts beside it, an admin account in
`.env` and an `OPENROUTER_API_KEY` (README § Prerequisites, § Running it). "Ready on install" below means **started,
paired and configured by `npm run dev` by default** (`scripts/dev-env.ts:12-15`, `scripts/run-stack.ts:52-80`,
`scripts/stack.ts:236-290`). Everything else is added by an admin (Admin → Systems → Install, Admin → MCP servers, a
fleet system's "Install another", or by asking in chat with `hub/add_instance`).

---

## 1. Every system that ships

All are first-party (in `systems/`, written in this repository). A plain label for the site comes first; the system
name is in the evidence column.

| Label | What it lets the assistant do for you | A family member might ask | Ready? | Evidence |
|---|---|---|---|---|
| **Your files and folders** | Read, search, write and edit files in folders you choose, and run commands (with your OK), showing every file a command changed. | "Find the warranty PDF for the dishwasher and rename it so I can find it again." | **Ready**: started by `npm run dev` with this repository as its folder (`HARNESS_DEV_ROOT` for another). Other folders/machines: an admin sets its folders or pairs another copy by QR code. | `systems/fs` (fns `read`, `write`, `edit`, `list`, `glob`, `grep`, `cd`, `bash`, `remove`, `restart`, `install_system`, `system_status`, `restart_system`, `stop_system`); 24 test files incl. `server/impl.test.ts`, `server/sensitive.test.ts`, `server/safe.test.ts`, `server/hosting.test.ts`; e2e `chat`, `restart`, `install`; `instances: "many"` |
| **Search by meaning** | Lets search, suggestions and memory recall find things by what they mean, not just matching words. | (Behind the scenes: "what did we decide about the summer trip?" finds the chat that said "July vacation".) | **Needs setup**: started by `npm run dev`, but it wraps the EmbeddingGemma service, which runs separately on `127.0.0.1:8760` and is not in this repository. Without it: words-only search, no suggestions, no recall. | `systems/embedder` (a provider, no fns); `server/embedder.test.ts`, `server/link.test.ts`, `embedder.live.test.ts`; README § Prerequisites |
| **Searches and reads the web** | Search the web, read pages as clean text (script-built pages rendered first), and crawl a site section; every page is kept. | "What time does the farmers market open this Saturday?" | **Needs a key**: runs only with `TAVILY_API_KEY` (`scripts/run-stack.ts:55`). | `systems/web` (`search`, `read`, `crawl`, hidden `fetch_raw`); 12 test files incl. `server/tavily.test.ts`, `server/crawl.test.ts`, `server/network.test.ts`; e2e `web`, `build4` |
| **Forms when it needs details** | Shows a proper form in the chat (text, choices, numbers, dates) when it needs several answers, and can save the form for next time. | "Help me plan the birthday party." (it asks date, guest count, budget in one form) | **Ready**: started by default; no config. | `systems/input` (`get_input`, `ask_text`, `ask_choice`, `ask_confirm`, `ask_number`, `ask_date`, `save_form`, `check_form`); `server/authoring.test.ts`, `client/renderers.test.ts`; `client/FormCard.vue`. Partial: forms are in-chat only, not shareable links (Do not claim 6) |
| **Charts you can keep** | Turns any table of results into a chart or table with filters and drill-down, proposed with a live preview; you press Save to keep it. | "Show me our grocery spending by week as a chart and keep it." | **Ready**: started by default; no config. | `systems/widgets` (kind `widget`, `make_widget`, `save_widget`); `server/widgets.test.ts`, `client/client.test.ts`; ui-tests `widgets-charts`, `widget-drill`, `widget-chrome`; page `/s/widgets/saved` |
| **Builds its own tools** | Writes a small, checked program over its other tools when you ask for a lookup or calculation, tests it and saves it as a new tool. | "Every month, total what we spent on the kids' activities." | **Ready**: started by default; no config. | `systems/code` (kind `program`, `make_code`); `server/code.test.ts`, `code.live.test.ts`; e2e `build9` |
| **Runs Claude Code for you** | Starts, watches and steers Claude Code coding sessions on your machines, with Claude's permission requests and questions as approve/deny cards. | "Have Claude Code fix the failing test in my recipe-app folder." | **Needs setup**: started by `npm run dev` (allowed folder: the folder above this repository), but Claude Code itself must be signed in on that machine (its own `ANTHROPIC_*`/`CLAUDE_*` settings pass through, `server/env.ts:36-58`); the Agent SDK bundles the executable. | `systems/claude` (kind `agent`, `folders`, `start_session`, `send`, `control`, `transcript`, `disk_sessions`, `permit`, `allow_mode`, `answer`, `importables`, `import`); `server/claude.test.ts`, `server/fleet.test.ts`, `server/probe.test.ts`, opt-in `agent-sdk.live.test.ts`; pages `/s/claude/sessions`, `/s/claude/session/…`. Not proven in daily use (Do not claim 11) |
| **Your Google Calendar** | Each person connects their own calendar; it can see events and, as each person allows, create, change and delete them. | "Put Emma's dentist appointment on my calendar for Tuesday at 3." | **Needs setup**: runs only with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (a Google OAuth client); then each person connects at `/connect/google-calendar`. | `systems/google-calendar` (`list_events`, `search_events`, `get_event`, `create_event`, `update_event`, `delete_event`); `server/link.test.ts`, opt-in `google.live.test.ts`. Only its "not connected" path ran in scenarios (Do not claim 11) |
| **Talks to your databases** | Connects a SQLite, Postgres or SQL Server database; you ask in plain words, it writes and saves the query, and any change waits for your OK with the SQL and rows shown. | "How much did we spend on groceries last month?" | **Needs setup**: not in the default `npm run dev` set (listed in `HARNESS_DEV_ONLY` it pairs a new SQLite file `dev.db`); otherwise an admin adds an instance per database with its connection. | `systems/database` (kind `query`, `get_query`, `edit_query`, `run_query`, `create_table`, `alter_table`, `drill_down`, `table_fns_available`, `table_fns_generate`, …); 10 test files incl. `server/link.test.ts` "proposes a write…, previews it, and runs it once approved"; e2e `build5`. SQLite built; Postgres/SQL Server only env-gated `drivers.live.test.ts` (Do not claim 12) |
| **Runs things on a schedule** | Runs any saved tool later, once or repeating, as you, and tells you how each run went; reminders too. | "Remind me every other Thursday to put the recycling out." | **Needs setup (one switch)**: not in the default `npm run dev` set; runs when listed in `HARNESS_DEV_ONLY`; no other config. | `systems/schedule` (kind `schedule`, `add`, `change`, `list`, `pause`, `resume`, `skip`, `remove`, `allow_runs`, `history`, `remind`); 9 test files incl. `server/timer.test.ts`, `server/fns.test.ts`; pages `/s/schedule/calendar` |
| **Plugs into any tool server (MCP)** | Adds any MCP server (local or remote, with sign-in): its tools become tools the assistant can use, its prompts become `/commands`, its files browsable, with approvals. | "Add 'call the plumber' to my task list." (through a task app's MCP server) | **Needs setup**: an admin adds each server under Admin → MCP servers (the hub installs, pairs and starts the bundled `mcp` system per server); people with per-person sign-in connect on `/connect/mcp`. | `systems/mcp` (kind `tool`, `at_server`, `answer_elicitation`, `server_status`, `refresh`); `server/link.test.ts`, `server/oauth.test.ts`, `server/dial.test.ts`, `server/schema.test.ts`; e2e `build9`, `mcp`. Not in scenarios (Do not claim 11) |
| **Connects to web services (APIs)** | Writes request tools for a web service from its OpenAPI document; each person connects their own token. | "Check whether my library books are due." (once the library's API is added as a service) | **Needs setup**: not in `npm run dev`'s components list (`scripts/dev-env.ts:12` has no `api`); the e2e stacks start it (`scripts/stack.ts:243`); services are added under Admin → API services or by the agent; per-service tokens on `/connect/api`. | `systems/api` (kind `request`, `make_api`, `services`, `operations`, `test_request`); `server/api.test.ts`, `server/guard.test.ts`, opt-in `api.live.test.ts`; e2e `build9` |
| **Runs local AI models** | Installs Ollama (checksum-verified), starts it, pulls and removes models, and offers the ones an admin chose in the model picker. | (Admin) "Set up a small local model so simple chats cost nothing." | **Needs setup**: runs only with `HARNESS_DEV_OLLAMA` (a URL, or `managed`). | `systems/ollama` (`status`, `detect`, `install`, `start`, `stop`, `models`, `pull`, `remove`); `server/install.test.ts`, `server/serve.test.ts`; page `/s/ollama/servers`. Tested with fakes only |
| (not a feature) | `systems/random`: a one-fn demo; `systems/template`: what `harness system new` copies (placeholder comments). | | | harness-features.md, last line |

**Built into the hub, not systems** (so they need no system at all): memories (`hub/remember`, `forget`,
`memory_update`), finding earlier chats (`hub/sessions_list`, `session_messages`), files and attachments as resources
(`hub/resource_*`), records of anything you track (hub data, `/data`), asking you one question (`hub/ask_user`), saved
tools (`hub/fns_save`, `fns_search`), and reading pictures with a vision model (`hub/image_read`). Groups:
`packages/hub/src/boot/hub-groups.ts`.

**Site wording that stays true:** "Thirteen first-party systems ship in the box; files, forms, charts, tool-building
and Claude Code start with the hub, and web search, calendar, databases, MCP servers, APIs, schedules and local models
switch on with a key, a login or an admin's click." Don't say every system works with no setup.

---

## 2. The context layer

What "context" is in this code: **context items** are text the model can be given (guides and skills a system
declares, a person's memories, pieces of files and pages), each with a key, title, summary and optional links to the
fns it brings and other items it imports (`docs/harness.md` § Content, § Context as a graph).

| Label | What it is | Evidence |
|---|---|---|
| Guides each tool brings | Every system ships guides (`context(...)` in its contract, or `context/**/*.md` files with YAML headers) that teach the model how to use it; loading one brings its tools too. | e.g. `systems/web/shared/index.ts` `guide` and `basics`; `systems/fs/context/`; `packages/hub/context/*.md` (the hub's own 12: memory, undo, later, images…); `contextor/brought.ts`, `brought.test.ts` |
| Find and load context | The model searches context by words and meaning, loads items into the chat, drops them, or reads one. | `hub/ctx_search`, `ctx_load`, `ctx_drop`, `ctx_get` (`packages/sdk/src/hub.ts:732-830`); hybrid search `store/hybrid.ts`, `index/search.ts` |
| Follows linked knowledge | Items are a weighted graph; a decision model can walk the links level by level and load what the task needs. | `hub/ctx_crawl`; `contextor/graph.ts`, `contextor/crawl.ts` and tests; admin `/admin/graph` (ui-test `build7-graph`) |
| Turn a file into knowledge | Any file or page becomes context, one item per section, kept in step with the file. | `hub/ctx_from_resource`; `web/src/context/components/FromResourceDialog.vue`; e2e `resources` |
| Link things together | People and the model can draw links between items, fns and files. | `hub/ctx_link`, `ctx_unlink`; `LinkDialog.vue`, `LinkGroups.vue` |
| Guidance every agent gets, approved by an admin | A system's item can declare `inject` to go into chosen agents' system prompts; new or changed injections wait on the admin's review, and an admin sees and switches each one per agent, with its order and token cost. | `contextor/injected.ts`, `catalog/injections.ts`, `api/injections.ts` and tests; `hub/ctx_injections_list`, `ctx_injection_set`; `admin/components/InjectedList.vue`; review flag `injects` (`docs/harness.md` § Injected context) |
| Remembers you | Short facts kept for one chat, for you, or for everyone; private ones never reach someone else's chat. | `hub/remember`, `forget`, `memory_update`; `packages/hub/context/memory.md`; `MemoryDialog.vue`; scenarios 28, 44, 67 |
| Recalls by itself | With each message the hub brings the closest few memories (up to 3, at or over 0.2 similarity, once a chat) into the message in a `<loaded_for_you>` block; no searching needed. | `chat/enrich.ts`; `chat/enrich.test.ts:60` "recalls the person's memories closest to the message…"; `HARNESS_RECALL_MEMORIES`, `HARNESS_RECALL_THRESHOLD` (`chat/env.ts`). Needs the embedder |
| Suggests (or loads) the right tools and guides | Each message gets suggested fns and context by meaning, shown as chips under it; an admin can let a decision model or LLM pick, and optionally load them straight in (`<loaded_for_you>`). | `chat/suggestions.ts`, `chat/suggestions.test.ts`; `SuggestionChips.vue`, `DraftSuggestions.vue`; ui-test `suggestions`. Partial: needs the embedder |
| Searches meaning (embeddings) | Fns, context, sections and (optionally) pictures are embedded and searched together with word search (rank fusion). | `store/hybrid.ts`, `index/index.test.ts`, `index/images.test.ts`; `systems/embedder` |
| Fits any model's window | The planner sizes every prompt to the model's window; what doesn't fit is shortened or listed, and reported. | `contextor/planner.ts`, `contextor/limits.ts`; `SelectionReportView.vue`; e2e `contextor` |
| See what the model got | Every model call shows the system prompt, each message with the hub's tagged additions picked out, and what the contextor chose. | `chat/components/LlmCallDetails.vue`; `SelectionReportView.vue`; ui-test `context-graph` |
| A Context page | Browse, search, filter and edit every context item and memory. | `/context` (`pages/ContextPage.vue`, `ContextItemPage.vue`); ui-test `context-items` |

---

## 3. The research layer

| Label | What it does | Evidence | Limit |
|---|---|---|---|
| Web search | Titles, URLs, snippets and Tavily's short answer, best first; news with a day window, include/exclude sites, basic or advanced depth (up to 20 results). | `web/search` (`systems/web/shared/index.ts:168-203`, `SEARCH_LIMIT_MAX = 20`); `server/tavily.test.ts`; `client/SearchView.vue` | **Needs a paid Tavily key**; scenarios degraded when the quota ran out (Do not claim 4). Tavily is the only search provider |
| Reads the page, not the snippet | Reads one page as clean markdown (main text, no menus), up to 200,000 characters, with redirects listed; script-built pages run in a headless browser (puppeteer) first. | `web/read`; `server/renderer.test.ts`, `server/http.test.ts`; `client/ReadView.vue` | Reading works without Tavily, but the web system only runs in `npm run dev` with the key |
| Checks before it states | The injected web guide tells every chat agent to read the page before stating a time, price or date, prefer official sources, give each URL and say what it couldn't confirm. | `web/basics` (injected into `hub/chat*`) and `web/guide`, `systems/web/shared/index.ts:280-320` | A prompt rule, not a guard |
| Crawls a site | Follows a site's links up to 3 levels (default 25 pages), respects robots.txt, keeps every page under one folder to search later. | `web/crawl`, `CRAWL_DEPTH_MAX = 3`, `CRAWL_PAGES_DEFAULT = 25`; `server/crawl.test.ts` | |
| Keeps what it read | Every search and page is kept as a hub resource (raw plus markdown), so it can be re-read, searched and made into context without fetching again. | `hub/resource_import` (`KEEPS_WHAT_IT_READS`); `/resources` (`ResourcesPage.vue`) | |
| Cites its sources | Optional per chat ("Use citations", off by default): each claim gets a numbered `[n]` chip that opens the exact tool result and value it came from. | `chat/cite-rule.ts`, `chat/cites.ts`, `cites.test.ts`; `CiteChip.vue`; `SessionSettings.vue` | Off by default |
| Reads attachments | PDFs, spreadsheets, documents and photos you attach are read in one call; scanned pages go to a vision model. | `resources/reader.ts`, `resources/pdf-pages.ts`; scenarios 15, 16, 54 | Scanned pages: one smoke run only |
| Safe fetching | Refuses private and local addresses on every redirect unless an admin allows them; per-page byte and time limits. | `server/network.test.ts`, `server/guard.test.ts`; config `allowPrivate`, `maxBytes`, `timeout` | |
| Past chats as research | "What did we decide last week" finds and quotes the right earlier chat. | `hub/sessions_list`, `session_messages`; `packages/hub/context/earlier_chats.md`; scenarios 29, 73 | |

Not built: a deep-research agent that plans many searches and writes a report, scheduled monitoring of pages, or a
second search provider. Don't claim "reliable live web answers" (Do not claim 4).

---

## 4. Same experience on every device

| Label | What's true | Evidence | Limit |
|---|---|---|---|
| One app for phone, tablet and desktop | One web app; wide screens get a sidebar, narrow ones a top bar with the sidebar in a drawer; no sideways scrolling; the composer always on screen. | `app/AppShell.vue`, `AppTopBar.vue`, `AppSidebar.vue`; ui-test `responsive` | |
| Every screen tested at every size | Each UI feature has a browser test run at desktop (1440), laptop (1180), tablet (768), tall tablet (820) and phone (390), with touch on the small ones. | `ui-tests/kit.ts:39-49` (`VIEWPORTS`); `ui-tests/features/` (~75 scripts) | |
| Add to home screen | The hub serves an install manifest (`display: standalone`, the hub's name, an icon), so it can be added as an app. | `packages/hub/src/api/serve.ts:103-130`; `packages/web/index.html:9` | **No offline mode**: the service worker caches nothing (`packages/web/sw/sw.ts`, Do not claim 7). Not a native app |
| Phone notifications | Web push per device (Settings → Notifications): approvals and questions waiting on you, replies, finished answers, budgets, pairing requests, schedule results; a repeat replaces the last one; tapping opens the app at that inbox item. | `api/push.ts`, `push.test.ts`; `chat/notifications.ts`; `web/src/state/push.ts`; `sw/sw.ts`; `pages/SettingsPage.vue` | Browsers allow web push only on HTTPS or localhost (a browser rule; the hub serves http by default) |
| One inbox for what needs you | Everything waiting on you in one place; approval cards answered right there. | `/inbox` (`pages/InboxPage.vue`, `components/inbox/InboxApprovals.vue`); ui-test `inbox` | |
| Same chats and approvals everywhere | Chats, approvals, memories, data and saved charts live on the hub, not the device; sign in anywhere and it's all there. An approval answered on one device is settled for all. | Hub database (`docs/harness.md` § Storage); `ApprovalCard.vue` used by both the chat tray and the inbox | |
| Live sync between devices | Every screen updates live over a WebSocket; a second signed-in browser sees the same chat stream as it happens; each person gets only their own events. | e2e `chat.e2e.test.ts:195` "streams the same session to a second signed-in browser as it happens"; security review "Live events go only to the people they are for" | |
| Catches up after a drop | If the connection drops while something runs, the thread catches up without a reload when it's back. | ui-test `reconnect` | |
| Links work on any device | Every page, panel, filter and tab is in the URL, so a link opened on the phone shows the same view. | `app/routes.ts`; ui-tests `url-state`, `url-reload` | |
| Speak instead of type | Dictation in the composer (a transcription model or the browser's own). | `chat/components/Composer.vue`; dictation role | Shown only when configured |
| Follows the device's theme | Light/dark follows the device or a pinned choice. | `state/theme.ts`, `ThemePicker.vue`; ui-test `themes` | |
| Add a device by scanning | A system started on any machine prints a QR code; scan it with the phone, fill its settings, pair. | `/pair` (`pages/PairPage.vue`), `link/pairing.ts`; ui-test `qr-pairing`; e2e `pairing` | Admin only |

Not built: offline use, native iOS/Android or desktop apps, sync of drafts between devices.

---

## 5. Facts for a system marketplace (planned)

**What a system is on disk** (`docs/harness.md` § System folders, packages and data):

```
systems/<name>/
  system.json   name, version, description, link protocol, server and client entries, one instance or many
  package.json  npm dependencies and scripts (development only)
  shared/       the contract (types, fns, kinds, context, grants, config type, pages)
  server/       the process (server/main.ts)
  client/       renderers (client/index.ts, optional)
  dist/         what `harness system build` makes and `pack` zips
```

**`system.json` fields** (`SystemPackageManifest`, `packages/core/src/package.ts:39-72`): `format` (1), `name`,
`version` (semver), `description`, `protocol` (link protocol; the hub refuses one it can't speak), `server.entry`,
`server.external` (npm packages left out of the bundle, e.g. `better-sqlite3`, installed by the installer),
`server.node` (Node range, optional), `client.entry` (optional), `instances` (`one` | `many`), `files` (sha-256 of each
packed file, written by `pack`), `permissions` (`childProcess`, `workers`; e.g. `systems/claude/system.json`,
`systems/mcp/system.json`). There is **no** author, license, homepage, repository, icon or screenshots field; each
`package.json` is development-only (`systems/web/package.json` "description").

**What the contract adds** (sent on connect as the manifest): fns with modes, kinds, types, context items and
injections, hooks, mention providers, model providers, config type (secret paths in `configSecrets`), pages, groups,
an `about` text, and **grants** (`SystemGrants`, `packages/core/src/grants.ts:55-66`): `hub` capabilities, `models`,
`secrets`, `calls` (fns or systems it may call), `network` hosts, `files`.

**How install works now:**

- **Sources** (`InstallSource`, `packages/core/src/records/systems.ts:22-28`): a folder path, an npm package and
  version, a **git repository and ref**, or an uploaded package zip. The hub's installer
  (`packages/hub/src/link/process.ts:49-90`) runs `npm install` for a package, `git clone --depth 1 --branch <ref>`
  then `npm install --omit=dev` for git, unpacks and checks a zip (format, protocol, every file hash, no path leaving
  the folder), then reads and checks `system.json`.
- **Where you start one:** Admin → Systems → Install (`admin/components/InstallDialog.vue`: Zip, npm, Folder, Git with
  "Repository" and "Branch, tag or commit"; start with the hub or not); the CLI `harness system install
  <zip|folder|npm-spec>` (`packages/cli/src/commands/install.ts`; no git option in the CLI); a new instance of a
  bundled system (`hub/add_instance`, `addSource` in `packages/hub/src/api/admin-ops.ts:146-160`, from
  `HARNESS_BUNDLED_SYSTEMS` or the repo's `systems/`); and from chat, `fs/install_system({ path })` builds, typechecks,
  scans and hosts a folder after an admin approves an install card (`systems/fs/server/hosting.ts`,
  `hosting.test.ts`; plan `docs/plans/system-install-flow.md`, built in build 6 per README).
- **After install:** the hub pairs it (makes the key), starts and supervises it (backoff, crash limit per hour), and
  gives it its own `state/data/cache` folders that survive upgrades. Upgrade, stop, uninstall and data export exist
  (CLI and admin endpoints; e2e `package`, `install`).
- **Review before live:** a new or changed system waits on `/admin/systems/:name/review` (`ReviewView.vue`) listing
  what it adds, the grants it wants and risk flags ("Can delete", "Can write", new effects, new grants, starts runs on
  its own, changes what agents are told) from `packages/hub/src/link/review-summary.ts`; its client screens load only
  after approval (`link/lifecycle.ts`; ui-test `build7-review`).
- **Install card (from chat):** `ApprovalPreview.vue` + `InstallSubjectView.vue` show what the contract changes, risk
  flags, the bound system/version/host and hashes, the system's own test counts and component previews, then the code
  lines the scan flagged (Node built-ins, dynamic imports, `eval`, literal URLs).
- **Untested path:** no test found for the git source (`grep "git: '"` finds none in hub, CLI or e2e tests).

**What a public listing would need, and where each comes from today:**

| Listing field | Source today |
|---|---|
| Name, version, description | `system.json` |
| One-line pitch / long "about" | contract `description`, `about` (e.g. `systems/web/shared/index.ts:141-147`) |
| Fns (with read/write/delete mode), kinds, types, guides, pages | the manifest the contract builds; the review summary already lists them |
| Permissions it asks for | contract `grants` (hub capabilities, calls, network hosts, files, secrets, models) and `system.json` `permissions` |
| What it needs to run (keys, logins) | contract config type and `configSecrets`; `ConnectDecl` for per-person sign-in |
| One copy or many | `system.json` `instances` |
| Risk flags | `review-summary.ts` flags (the same ones the admin sees) |
| Tests / previews | `harness test --previews`, shown on the install card |
| Source repo, author, license, icon, screenshots | **not in any file today**; would need new `system.json` fields |
| Signature / publisher trust | not built; `files` hashes catch corruption, not malice (`package.ts:64`) |

Keep in mind for site copy: grants are enforced by the hub, but the network guard is advisory, not OS sandboxing
(Do not claim 9); and "builds its own add-ons when you ask in plain words" is not proven (Do not claim 1).

---

## 6. Five animated-demo storyboards

Each step is something the app does today; the component to copy for a drawn replica is in brackets. Put the
"needs setup" note in each demo's small print.

### A. "What did we spend?" (databases, charts)

Setup shown in small print: a family budget SQLite database connected as a database instance.

1. Mum types "How much did we spend on groceries each week last month?" [`chat/components/Composer.vue`,
   `UserMessage.vue`].
2. A run card appears for `database/get_query`: status dot, the fn pill, "writing a query", ticking time and cost
   [`chat/components/RunCard.vue`, `RunProgress.vue`]. It reads, so it runs without asking.
3. The result lands as a table that can switch to a bar chart [`components/widgets/TableResult.vue`,
   `components/visuals/ChartVisual.vue`, `components/visuals/families/`], and the answer under it
   [`AssistantAnswer.vue`].
4. "Mark the $86 Costco charge as reimbursed." An approval card slides in above the composer: "Change 1 row in
   transactions", the highlighted SQL, the row it touches, Approve / Deny [`chat/components/ApprovalTray.vue`,
   `components/approvals/ApprovalCard.vue`, `ApprovalPreview.vue`; behaviour `systems/database/server/link.test.ts:231`].
5. Approve → the run card turns done, "1 row changed".
6. "Keep that weekly chart." A proposal card with a live chart preview, Save and Change [`systems/widgets/client/ProposalCard.vue`].
7. Save → a link to the Widgets page, the chart listed there with its filter chips [`systems/widgets/client/WidgetsPage.vue`,
   `SavedWidget.vue`, `components/widgets/WidgetChips.vue`]. **Not** "pinned to a dashboard": dashboards aren't built
   (Do not claim 13).

### B. "Fix it while I'm at lunch" (Claude Code, from the phone)

Setup: the claude system on the home computer, Claude Code signed in there.

1. On a phone layout [`app/AppShell.vue` compact, `AppTopBar.vue`], Dad types "Have Claude Code fix the failing test in
   recipe-app."
2. A `claude/start_session` run card, then a link into the session [`RunCard.vue`].
3. The session page: folder, mode, transcript with Claude's reasoning folded and its tool uses as run cards, tasks with
   progress [`systems/claude/client/SessionPage.vue`, `TaskList.vue`].
4. Claude wants to run `npm test`: an approval card with the exact command, on the session page, in the chat and in
   the inbox [`ApprovalCard.vue`; preview `systems/claude/server/preview.ts`; `components/inbox/InboxApprovals.vue`].
5. Approve → later Claude wants to edit a file: the card shows the diff (- / + lines) [`preview.ts` `replacementDiff`,
   `ApprovalPreview.vue`]. Approve.
6. The fleet page shows the session idle with its last line [`systems/claude/client/FleetPage.vue`, `SessionList.vue`].

### C. "Plug in a tool server" (MCP)

Setup: any MCP server (show a generic "Tasks" server, not a real brand).

1. Admin → MCP servers → "Add MCP server": URL, sign-in (OAuth, per person), "ask before writes" [`admin/views/McpServersView.vue`,
   `admin/components/AddServiceDialog.vue`, `McpServerForm.vue`].
2. The row shows connected, with counts of tools, prompts and resources it mirrored [`admin/components/ServiceRows.vue`].
3. A family member opens Connect and signs in to their own account [`pages/ConnectPage.vue`].
4. In chat: "Add 'call the plumber' to my tasks for Friday." The server's tool runs as a fn; an untrusted server's tool
   counts as a write, so an approval card shows the tool and its arguments [`ApprovalTray.vue`, `ApprovalCard.vue`;
   rule `systems/mcp/server/mirror.ts:66-76`].
5. Approve → run card done, answer [`RunCard.vue`, `AssistantAnswer.vue`].
6. Optional beat: the server's prompts appear as `/commands` in the composer [`Composer.vue`].

### D. "Hikes near us this Saturday" (research layer + context layer)

Setup: web system with a Tavily key; a memory from an earlier chat ("We live in Asheville; our youngest is 4");
"Use citations" switched on in the chat's settings [`chat/components/SessionSettings.vue`].

1. "Any easy hikes for the kids this Saturday?" Under the message, small context/fn icons with counts
   [`chat/components/SuggestionChips.vue`]. The memory came in by itself (`<loaded_for_you>`); to show it, open the
   message's model call where the hub's tagged additions are picked out [`chat/components/LlmCallDetails.vue`].
2. A web search card: the query, a status chip, Tavily's short answer, result rows with Read buttons
   [`systems/web/client/SearchView.vue`, `StatusChip.vue`].
3. Two page cards: title, site, "rendered", a preview of the kept page [`systems/web/client/ReadView.vue`].
4. The answer with `[1]` `[2]` chips; tap one → popover with why it backs the claim, the value, "Show in result"
   [`chat/components/CiteChip.vue`, `AssistantAnswer.vue`].
5. Optional: the pages it read sit in Resources [`pages/ResourcesPage.vue`].
   Small print: needs a search key; check details on the page (don't show "live weather" or prices as guaranteed).

### E. "Start on the laptop, approve on the phone" (same experience everywhere)

Setup: files system with the family's Documents folder; push turned on on the phone [`pages/SettingsPage.vue`].

1. Laptop, wide layout with sidebar [`AppShell.vue`, `AppSidebar.vue`]: "Move the PDFs in Downloads into
   Documents/Receipts."
2. An approval card waits above the composer with the exact command [`ApprovalTray.vue`, `ApprovalCard.vue`]. She
   leaves.
3. Phone lock screen: a notification "Approval needed" [`packages/web/sw/sw.ts`; reasons `chat/notifications.ts:190`].
4. Tap → the app opens at the inbox item, the same card at the top [`pages/InboxPage.vue`, `components/inbox/InboxApprovals.vue`].
   Approve.
5. Back on the laptop, without a reload, the run card turns done and lists every file the command moved, with
   per-file changes [`RunCard.vue`, `systems/fs/client/BashView.vue`, `components/changes/ChangeSetView.vue`;
   live sync `e2e/chat.e2e.test.ts:195`].
6. Small print: works in any modern browser; add it to the home screen; no offline mode; push needs HTTPS.
