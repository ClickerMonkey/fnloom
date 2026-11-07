# harness

A web-based agent harness: one **hub** that owns every LLM call, user, permission and record, and **systems**
that connect over WebSocket to add fns, kinds, types, resources, context and UI renderers.

Status: **first milestone running.** The hub, the SDK, the fs and embedder systems and the Vue chat and admin app run
together; the chat agent reads files, runs commands (with approval), and streams its answers.

- [`docs/harness.md`](docs/harness.md): the design in plain language.
- [`docs/architecture.md`](docs/architecture.md): the code layout, module interfaces, lane ownership and dev workflow.
- `types/`: the approved type design, kept as the design record. `explorer/explorer.html` (`npm run explorer`) lets
  you read the guide and click through every type, with notes (**Export notes** saves them for `review/notes.json`).

```sh
npm install
npm run typecheck   # every project: core, sdk (+ compile-time examples), hub, web, systems, types
npm test            # unit + web tests (no network)
npm run test:live   # live tests: OpenRouter (OPENROUTER_API_KEY, free model)
npm run lint
npm run dev         # builds the web app, then the hub (serving it), fs and embedder, LAN-bound; data in .harness/
npm run e2e         # the whole stack end to end with a free OpenRouter model (boots its own on :4330)
npm run ui-tests    # puppeteer checks of every UI feature against a running harness (HARNESS_UI_URL)
npm run check       # everything above that runs offline, plus the explorer
npm run check:full  # check, then the live tests and the e2e suite (needs OPENROUTER_API_KEY and the embedder)
```

## Running it

1. Copy `.env.example` to `.env` and set the admin account (`HARNESS_ADMIN_EMAIL`, `HARNESS_ADMIN_PASSWORD`). The hub
   makes that single admin account on its first start; there is no sign-up. `OPENROUTER_API_KEY` (from `.env` or
   the environment) gives the chat agent its models; `HARNESS_DEFAULT_MODEL` picks the one it uses.
2. Start the EmbeddingGemma service from `product/services/embedder` (it listens on `http://127.0.0.1:8760`). Without
   it the hub still works, with words-only search and no suggestions.
3. `npm run dev`. It builds the web app, starts the hub on `HARNESS_PORT` (4300) bound to `0.0.0.0`, pairs the fs and
   embedder systems with one-time tokens the first time, configures fs with this repository as its root
   (`HARNESS_DEV_ROOT` to serve another folder), and prints the LAN address. Open it and sign in. Ctrl+C stops
   everything.

| Setting | Default | What it is |
|---|---|---|
| `HARNESS_ADMIN_EMAIL`, `HARNESS_ADMIN_PASSWORD` | (required) | the single admin account |
| `HARNESS_PORT` | 4300 | the hub and the web app it serves |
| `HARNESS_DATA` | `.harness` | database, files, keys, logs, systems' state |
| `HARNESS_DEV_ONLY` | `web,hub,fs,embedder` | what `npm run dev` runs (`web` is the build step) |
| `HARNESS_DEV_ROOT` | this repository | the folder fs serves |
| `HARNESS_EMBEDDER_URL` | `http://127.0.0.1:8760` | the EmbeddingGemma service |
| `HARNESS_DEFAULT_MODEL` | `openrouter/auto` | the chat agent's model |

For hot reload of the web app, run `npm run dev:web` beside `npm run dev` (Vite on `HARNESS_WEB_PORT`, 4310, proxying
the hub).

## Tests that drive the whole thing

- `npm run e2e` boots its own stack (port `HARNESS_E2E_PORT`, 4330; data `.harness/e2e`, wiped each run) and checks,
  with a free OpenRouter model: sign-in, systems connected, suggestions from embeddings, file mentions, the agent
  reading and summarising a file with streaming and live run statuses, the fn tree, saved LLM interactions, budgets,
  approval of a shell command, the bash card's rerun, session state through `cd`, and realtime updates in a second
  browser. Set `HARNESS_E2E_URL` to test a stack that is already running instead.
- `npm run ui-tests` boots nothing. Point it at a running harness: `HARNESS_UI_URL=http://127.0.0.1:4300
  HARNESS_UI_EMAIL=… HARNESS_UI_PASSWORD=… npm run ui-tests` (`HARNESS_UI_ONLY=chat-shell,mentions` for some). One
  script per feature in `ui-tests/features/`, each run at 1440x900 and 390x844; shots go to
  `ui-tests/shots/<feature>/`, a summary to `ui-tests/shots/report.json`.

The @aeye and @ayepi packages are linked from local checkouts on their `harness` branches
(`file:../aits/packages/*`, `file:../ayepi/packages/*`), so clone [aits](https://github.com/ClickerMonkey/aeye) and
[ayepi](https://github.com/ClickerMonkey/ayepi) next to this repo and build them first.
