# harness

A web-based agent harness: one **hub** that owns every LLM call, user, permission and record, and **systems**
that connect over WebSocket to add fns, kinds, types, resources, context and UI renderers.

Status: **first milestone running.** The hub, the SDK, the fs and embedder systems and the Vue chat and admin app run
together; the chat agent reads and searches files, runs commands (with approval), streams its answers, and suggests
fns and context from the embedded message. See "Build order" in [`docs/harness.md`](docs/harness.md).

- [`docs/harness.md`](docs/harness.md): the design in plain language.
- [`docs/architecture.md`](docs/architecture.md): the code layout, module interfaces, lane ownership and dev workflow.
- `types/`: the approved type design, kept as the design record. `explorer/explorer.html` (`npm run explorer`) lets
  you read the guide and click through every type, with notes (**Export notes** saves them for `review/notes.json`).

## Prerequisites

- **Node 22.18 or later.**
- **The aits and ayepi checkouts beside this one**, on their `harness` branches and built. The @aeye and @ayepi
  packages are linked from them (`file:../aits/packages/*`, `file:../ayepi/packages/*`), so no publish is needed:
  clone [aits](https://github.com/ClickerMonkey/aeye) and [ayepi](https://github.com/ClickerMonkey/ayepi) next to
  this repo, then `npm install && npm run build` in aits and `pnpm install && pnpm build` in ayepi.
- **`OPENROUTER_API_KEY`** in the environment or `.env`. It configures the openrouter provider on the hub's first
  start; the live tests and the e2e suite use a free model with it.
- **The EmbeddingGemma service** from `product/services/embedder` (see its README: a Python venv, then
  `uvicorn main:app --host 0.0.0.0 --port 8760`). It listens on `http://127.0.0.1:8760`; the embedder system wraps
  it. Without it the hub still works, with words-only search and no suggestions.

## Running it

1. `npm install`.
2. Copy `.env.example` to `.env` and set the admin account (`HARNESS_ADMIN_EMAIL`, `HARNESS_ADMIN_PASSWORD`, at least
   10 characters). The hub makes that single admin account on its first start; there is no sign-up (SSO comes later).
   `HARNESS_DEFAULT_MODEL` picks the chat agent's model until an admin picks one.
3. `npm run dev`. It builds the web app, starts the hub on `HARNESS_PORT` (4300) bound to `0.0.0.0`, pairs the fs and
   embedder systems with one-time tokens the first time, configures fs with this repository as its root
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
| `HARNESS_DEV_ONLY` | `web,hub,fs,embedder` | what `npm run dev` runs (`web` is the build step) |
| `HARNESS_DEV_ROOT` | this repository | the folder fs serves |
| `HARNESS_EMBEDDER_URL` | `http://127.0.0.1:8760` | the EmbeddingGemma service |
| `HARNESS_DEFAULT_MODEL` | `openrouter/auto` | the chat agent's model |

Every other setting is in `.env.example`, generated from the settings schemas (`npm run env:example`).

Ports: 4300 the hub (`npm run dev`), 4310 Vite (`npm run dev:web`), 4330 and 4331 the e2e suite's own hubs, 8760 the
embedder service.

## Checks

```sh
npm run typecheck   # every project: core, sdk (+ compile-time examples), hub, web, systems, scripts, types
npm run lint
npm test            # unit + web tests (no network); npm run coverage for coverage
npm run test:live   # live tests: OpenRouter (OPENROUTER_API_KEY, a free model) and the local embedder
npm run build       # web manifest, typecheck, then the web build the hub serves
npm run e2e         # the whole stack end to end with a free OpenRouter model (boots its own on :4330)
npm run ui-tests    # puppeteer checks of every UI feature against a running harness (HARNESS_UI_URL)
npm run check       # manifest and .env.example checks, typecheck, lint, coverage, explorer: everything offline
npm run check:full  # check, then the live tests and the e2e suite (needs OPENROUTER_API_KEY and the embedder)
```

## Tests that drive the whole thing

- `npm run e2e` boots its own stack (port `HARNESS_E2E_PORT`, 4330; data `.harness/e2e`, wiped each run) and checks,
  with a free OpenRouter model: sign-in, systems connected, suggestions from embeddings, file mentions, the agent
  reading and summarising a file with streaming and live run statuses, the fn tree, saved LLM interactions, budgets,
  approval of a shell command, the bash card's rerun, session state through `cd`, and realtime updates in a second
  browser. A second file restarts a hub of its own (`HARNESS_E2E_RESTART_PORT`, 4331) that installs and supervises
  fs. Set `HARNESS_E2E_URL` to test a stack that is already running instead.
- `npm run ui-tests` boots nothing. Start a stack (a fresh one is best: `HARNESS_DATA=.harness/ui npm run dev`), then
  point it there: `HARNESS_UI_URL=http://127.0.0.1:4300 HARNESS_UI_EMAIL=… HARNESS_UI_PASSWORD=… npm run ui-tests`
  (`HARNESS_UI_ONLY=chat-shell,mentions` for some). One script per feature in `ui-tests/features/`, each run at
  desktop, laptop, tablet and phone sizes (plus wide and phone-landscape where a feature asks;
  `HARNESS_UI_VIEWPORTS=tablet,phone` for some). Every shot is also checked for horizontal scroll, overlapping
  controls and controls off screen. Shots go to `ui-tests/shots/<feature>/`, a summary to
  `ui-tests/shots/report.json`. A full run (about 220 checks) takes about half an hour.
- `npm run e2e:mock` runs the web app's own puppeteer scenarios against a mock hub, at phone, tablet and desktop in
  light and dark.
