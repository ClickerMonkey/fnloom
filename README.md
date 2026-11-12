# harness

A web-based agent harness: one **hub** that owns every LLM call, user, permission and record, and **systems**
that connect over WebSocket to add fns, kinds, types, resources, context and UI renderers.

Status: **build 7 done** (of 9). The hub, the SDK and CLI, the fs, embedder and web systems and the Vue chat and admin
app run together. The chat agent reads and searches files, runs commands (with approval), searches and reads the web,
and streams its answers, in strict-tools or static-toolset mode with a plain, suggesting or graph contextor that fits
each prompt in the model's window (local Ollama models included). Resources keep their raw bytes and converted forms
and become context; systems are packed, installed and run in fleets; admins make hub MCPs. Lists filter, sort and page
on the hub (build 3). Build 4 adds providers that systems declare, an AWS Bedrock provider (access keys or an API key),
web crawls into a resource root, private/shared/public visibility (shown only when the hub has more than one person),
per-person connections (the Google Calendar system), forms the agent asks for (the input system), fn validation hooks,
search pickers in place of free-text lists, and a wavy line where a chat call missed the prompt cache. Build 5 adds the database system,
registries and result visuals, approvals with previews, one fn search in the hub database, fn examples and facts
(mode, types, cost) and chat fn modes. Build 6 installs systems from chat (fs builds, scans and hosts them after an
admin approves the install card), adds `@harness/build`, context folders checked at build time (`context/**/*.md`
with YAML headers, imports, choices and brought fns), runtime add/update/remove of every manifest section, type
versions, `ctx.ai()` / `hubAi()` for systems, declared fn effects, a file explorer (`/explore/…`) and a hub fn for
every web operation. Build 7 adds staged authoring agents (`authoringAgent`: find, inspect, draft, check, fix, save) behind `get_query`, `edit_query` and `get_input`, a test kit for system authors (`@harness/sdk/testing`, `harness test`, checks and a preview gallery on the install card), generated fns from a table type (`table_fns_available`, `table_fns_generate`), installed-vs-live systems with a review page (`/admin/systems/:name/review`), declared grants enforced by the hub (with an allowlist proxy and Node file permissions), and the system and global graphs (`/graph`). What build 7 left is listed in [`docs/plans/build-7-design.md`](docs/plans/build-7-design.md). See "Build order" in
[`docs/harness.md`](docs/harness.md).

- [`docs/harness.md`](docs/harness.md): the design in plain language.
- [`docs/architecture.md`](docs/architecture.md): the code layout, module interfaces, lane ownership and dev workflow.
- `types/`: the approved type design, kept as the design record and frozen (not compiled against the code; the shapes
  are the zod schemas in `packages/core` and the generated `packages/sdk/AUTHORING.md`). `explorer/explorer.html` (`npm run explorer`) lets
  you read the guide and click through every type, with notes (**Export notes** saves them for `review/notes.json`).

## Prerequisites

- **Node 22.18 or later.**
- **The aits and ayepi checkouts beside this one**, on their `harness` branches and built. The @aeye and @ayepi
  packages are linked from them (`file:../aits/packages/*`, `file:../ayepi/packages/*`), so no publish is needed:
  clone [aits](https://github.com/ClickerMonkey/aeye) and [ayepi](https://github.com/ClickerMonkey/ayepi) next to
  this repo, then `npm install && npm run build` in aits and `pnpm install && pnpm build` in ayepi.
- **`OPENROUTER_API_KEY`** in the environment or `.env`. It configures the openrouter provider on the hub's first
  start; the live tests and the e2e suite use a free model with it.
- **`TAVILY_API_KEY`** (optional) for the web system's search; without it `npm run dev` and the e2e suite leave the
  web system out.
- **`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`** (optional): a Google OAuth client for the calendar system (its
  redirect is `<hub>/connect/callback`); without them `npm run dev` leaves the calendar system out.
- **AWS** (optional): add an `aws` provider under Models → Providers with a region and either access keys or a Bedrock
  API key.
- **A local Ollama** (optional) on `http://127.0.0.1:11434` for small local models; an admin adds it under Models →
  Providers. The graph contextor e2e suite uses the first of `HARNESS_E2E_OLLAMA_MODELS` it has (a small tool-capable
  one such as `qwen2.5:3b` first).
- **The EmbeddingGemma service** from `product/services/embedder` (see its README: a Python venv, then
  `uvicorn main:app --host 0.0.0.0 --port 8760`). It listens on `http://127.0.0.1:8760`; the embedder system wraps
  it. Without it the hub still works, with words-only search and no suggestions.

## Running it

1. `npm install`.
2. Copy `.env.example` to `.env` and set the admin account (`HARNESS_ADMIN_EMAIL`, `HARNESS_ADMIN_PASSWORD`, at least
   10 characters). The hub makes that single admin account on its first start; there is no sign-up (SSO comes later).
   `HARNESS_DEFAULT_MODEL` picks the chat agent's model until an admin picks one.
3. `npm run dev`. It builds the web app, starts the hub on `HARNESS_PORT` (4300) bound to `0.0.0.0`, pairs the fs,
   embedder and (with `TAVILY_API_KEY`) web systems with one-time tokens the first time, configures fs with this repository as its root
   (`HARNESS_DEV_ROOT` to serve another folder), and prints the local and LAN addresses. Open one and sign in with
   the admin account. Ctrl+C stops everything.

For hot reload of the web app, run `npm run dev:web` beside `npm run dev` (Vite on `HARNESS_WEB_PORT`, 4310, proxying
the hub).

| Setting | Default | What it is |
|---|---|---|
| `HARNESS_ADMIN_EMAIL`, `HARNESS_ADMIN_PASSWORD` | (required) | the single admin account |
| `OPENROUTER_API_KEY` | (none) | the openrouter provider's key |
| `HARNESS_PORT` | 4300 | the hub and the web app it serves |
| `HARNESS_DATA` | `.harness` | database, files, keys, logs, systems' state |
| `HARNESS_DEV_ONLY` | `web,hub,fs,embedder,web-system,input,calendar` | what `npm run dev` runs (`web` is the build step; `web-system` is the web system, and runs only with `TAVILY_API_KEY`; `calendar` only with the Google client) |
| `TAVILY_API_KEY` | (none) | the web system's search key |
| `HARNESS_DEV_ROOT` | this repository | the folder fs serves |
| `HARNESS_EMBEDDER_URL` | `http://127.0.0.1:8760` | the EmbeddingGemma service |
| `HARNESS_DEFAULT_MODEL` | `openrouter/auto` | the chat agent's model |

Every other setting is in `.env.example`, generated from the settings schemas (`npm run env:example`).

Ports: 4300 the hub (`npm run dev`), 4310 Vite (`npm run dev:web`), 4330 and 4331 the e2e suite's own hubs, 4421 the
package suite's, 4480 and 4481 `npm run ui-tests:mock`, 8760 the embedder service, 11434 Ollama.

## Systems

| System | Folder | What it adds |
|---|---|---|
| fs | `systems/fs` | files and folders as resources, read/write/search fns, `fs/bash` with approval, the system authoring guide as a context graph (`/new-system`), installing and hosting systems (`install_system`, `system_status`, `restart_system`, `stop_system`); many instances can attach (`fs@laptop`) |
| embedder | `systems/embedder` | embeddings from the EmbeddingGemma service, for search and suggestions |
| web | `systems/web` | Tavily search, page reading (pages that need it are rendered with puppeteer) and `web/crawl` (a site, up to 3 links deep, into one resource root); pages become hub resources with a markdown form |
| input | `systems/input` | forms the agent asks for: `get_input` (an agent: reuses a saved form fn kept in the hub, or writes a gin type), `ask_text` / `ask_choice` / `ask_confirm` / `ask_number` / `ask_date`, and `save_form` ("Save this form for next time"); answers come back as a hidden `input-answer` part |
| google-calendar | `systems/google-calendar` | each person connects their own calendar at `/connect/google-calendar` and picks which fns are on and which ask first; list, search, get, create, update and delete events |
| database | `systems/database` | a fleet, one instance per database (SQLite, Postgres, SQL Server): tables become hub types, `get_query` / `edit_query` (an agent that reuses or writes a saved query fn kept in the hub), writes and `create_table` / `alter_table` only after approval with a preview, results drawn as a table, bar chart or value; `table_fns_available` / `table_fns_generate` save CRUD, relation and comparison fns for a table with no model involved |
| template | `systems/template` | what `harness system new` copies: `system.json`, `shared/`, `server/`, `client/`, placeholder comments only |

Every installed system gets its own data and cache folders (`ctx.dataDir`, `ctx.cacheDir`) that survive upgrades; its
config lives in the hub's database.

## Chat modes and contextors

A chat's settings (or its agent's) pick a **chat mode** and a **contextor**:

- **tools** (the default): fns are real tool definitions the model calls.
- **static**: a fixed small toolset; loaded fns show to the model as cards (instructions, examples, signature) and
  it runs one with `run` and its args. Cheaper than strict tools, and it works on models without native tool calls.
- Contextors: **plain** (the whole conversation), **suggest** (plain, plus fns and context suggested from the
  embedded message) and **graph** (each message starts a fresh prompt from the relevant history and the context graph's
  weighted links, sized to the model's window and its output tokens; meant for small local models).

A chat's **fn mode** limits which fns it may call: `none`, `read`, `write`, `delete` (each allows fns up to that mode,
worked out from what a fn and the fns it uses do), or `auto`, where a classifier model (set system-wide in admin)
decides each call. A fn that needs approval waits once: approving it runs it.

A chat's settings also answer "what would a message get?" with the context and the budget a prompt would use.

## Hub MCPs

An admin makes hub MCPs under Admin → MCPs: each is an MCP endpoint at `<hub>/mcp/<slug>` with its own secret
(shown once) and include/exclude rules over systems, fns, types, context and resources. Point an MCP client at the
URL with the secret as its bearer token, or, for clients that speak stdio only, run
`harness mcp <slug> --secret <secret>`.

## The CLI

`npx harness` (the `@harness/cli` workspace) makes, builds, packs and installs systems:

```sh
harness system new <name>            # a system folder from the template
harness system build [dir]           # typecheck, check the contract and context/ folder, then bundle into dist/
harness system pack [dir]            # zip dist/ with every file hashed: a package the hub installs
harness system install <zip|folder|npm-spec> [--instance <name>] [--config <file.json>]
harness system list | start | stop | upgrade | uninstall <system>
harness system export-data <system>  # an instance's data folder as a zip
harness test [dir] [--previews]      # run a system's tests (vitest), optionally shooting the preview gallery
harness mcp <slug> --secret <secret> # bridge a hub MCP to stdio
```

Commands that talk to a hub take `--hub <url>` and `--token <token>` (or `HARNESS_URL`, `HARNESS_TOKEN`, or the
admin account in `.env`). A system started without a token asks to pair: on a terminal it prints a QR code of the
hub's pairing link (`HARNESS_PAIRING_QR`: `auto`, always or never) that opens the `/pair` page on a phone, where an
admin compares the code, fills its config and pairs it.

## Checks

```sh
npm run typecheck   # every project: core, sdk (+ compile-time examples), hub, web, systems, scripts, types
npm run lint
npm test            # unit + web tests (no network); npm run coverage for coverage
npm run test:live   # live tests: OpenRouter (OPENROUTER_API_KEY, a free model) and the local embedder
npm run build       # web manifest, typecheck, then the web build the hub serves
npm run e2e         # the whole stack end to end with a free OpenRouter model (boots its own on :4330)
npm run ui-tests    # puppeteer checks of every UI feature against a running harness (HARNESS_UI_URL)
npm run ui-tests:mock  # the same features against the web app's mock hub (nothing else running)
npm run gallery     # ui-tests shots into the screenshot gallery (ui-tests/gallery/index.html), outdated ones flagged
npm run docs:authoring # regenerate packages/sdk/AUTHORING.md, the system authoring guide (checked in npm run check)
npm run check       # manifest and .env.example checks, typecheck, lint, coverage, explorer: everything offline
npm run check:full  # check, then the live tests and the e2e suite (needs OPENROUTER_API_KEY and the embedder)
```

Only behaviour that can only be checked by rendering (layout, focus, scrolling, real rendering of components) gets a
browser test; everything else is a unit, component (happy-dom) or API-level test. See "Which tests run in a browser"
in [`docs/architecture.md`](docs/architecture.md).

## Tests that drive the whole thing

- `npm run e2e` boots its own stack (port `HARNESS_E2E_PORT`, 4330; data `.harness-test/e2e`, wiped each run) and checks,
  with a free OpenRouter model: sign-in, systems connected, suggestions from embeddings, file mentions, the agent
  reading and summarising a file with streaming and live run statuses, the fn tree, saved LLM interactions, budgets,
  approval of a shell command, the bash card's rerun, session state through `cd`, and realtime updates in a second
  browser. A second file restarts a hub of its own (`HARNESS_E2E_RESTART_PORT`, 4331) that installs and supervises
  fs. Build 2's suites: `authoring` (the agent makes a system from the authoring guide; the CLI packs it; the hub
  installs it and its fn runs), `contextor` (the static toolset on a free model; the graph contextor on the local
  Ollama, every request inside the window), `runs` (invalid input versus errors, fn metrics, embedding model calls),
  `resources` (raw and converted forms of a page, a workbook and a pdf; context from a resource), `web` (search, a page
  read into a markdown resource), `mcp` (a hub MCP answering an MCP client), `pairing` (QR pairing a second fs
  instance; two at once), `package` (a packed fs fleet installed on a hub of its own, 4421). Build 3's `build3` suite:
  list queries (filters and sorts on the hub, `hub/query`, a bad field refused), suggestion records and the decision
  model, stopping one run by id, and auto pair (pairing with a secret, re-pairing after the key is lost, rotation). Build 5's `build5` suite runs over two SQLite database instances: tables as hub types, `get_query`
writing, saving and reusing a query fn with the free model, paging and sorting a saved query, a write approved and one
declined, and a table made through approval. Build 6's `install` suite (API-level) writes a small system and calls
`fs/install_system`: an admin approves the card, fs builds, hosts and connects it and its fn runs; runtime additions are
stored with versions; a broken context folder fails the build; `load_context` and `fns_search` are checked. Set `HARNESS_E2E_URL`
  to test a stack that is already running instead.
- `npm run ui-tests` boots nothing. Start a stack (a fresh one is best: `HARNESS_DATA=.harness/ui npm run dev`), then
  point it there: `HARNESS_UI_URL=http://127.0.0.1:4300 HARNESS_UI_EMAIL=… HARNESS_UI_PASSWORD=… npm run ui-tests`
  (`HARNESS_UI_ONLY=chat-shell,mentions` for some). One script per feature in `ui-tests/features/`, each run at
  desktop, laptop, tablet and phone sizes (plus wide and phone-landscape where a feature asks;
  `HARNESS_UI_VIEWPORTS=tablet,phone` for some). Every shot is also checked for horizontal scroll, overlapping
  controls and controls off screen. Shots go to `ui-tests/shots/<feature>/`, a summary to
  `ui-tests/shots/report.json`. A full run (about 220 checks) takes about half an hour.
- `npm run gallery` runs the same features (same `HARNESS_UI_*` settings; `HARNESS_GALLERY_MOCK=true` for the mock hub)
  and keeps their shots in `ui-tests/gallery/`: the new shots are staged with the gallery's other features and swapped
  in only when the run completes, a failed feature keeps its previous shots, and `gallery.json` records each feature's
  commit and shot time. `index.html` flags shots older than their feature's code (its ui-test and the web folders it
  covers, uncommitted changes included). Run it for the screens a change touched (`HARNESS_UI_ONLY=…`);
  `HARNESS_GALLERY_INDEX_ONLY=true` only re-flags.
- `npm run e2e:mock` runs the web app's own puppeteer scenarios against a mock hub, at phone, tablet and desktop in
  light and dark.
