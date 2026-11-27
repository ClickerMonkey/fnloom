# fnloom: installing and running it

fnloom is a web-based agent harness: one **hub** that owns every model call, person, permission and record, and
**systems** that connect to it to add fns (tools), types, resources and screens. It runs on your own computer; you
use it from a browser on that computer, or from a phone or another computer on the same network.

This page covers installing it from npm, starting it, signing in and installing the premade systems. For working on
the harness itself (from a clone of the repository), see the README in the [repository](https://github.com/ClickerMonkey/fnloom).

## What you need

- **Node.js 22.18 or later** (with npm). Check with `node -v`.
- **A model provider.** An [OpenRouter](https://openrouter.ai) key is the quickest (`OPENROUTER_API_KEY`); AWS
  Bedrock and a local [Ollama](https://ollama.com) work too. You can also add one after the first start.

## Install

```sh
npm install -g fnloom
```

This puts the `fnloom` command on your PATH. To keep it inside one folder instead, run
`npm install fnloom` there and use `npx fnloom …` in place of `fnloom …`.

The package carries the hub, the app, the command line and the lightweight premade systems. The heavier systems
(database, web, claude) come as small packages inside it whose own dependencies (the SQLite driver built for your
machine, puppeteer and the Chrome it downloads, the Claude Agent SDK) are fetched only when you install that system (see
[Premade systems](#premade-systems)).

## Start it

Open a terminal in the folder you want the agent to work with (the **fs** system serves that folder's files to it),
then:

```sh
fnloom start
```

It starts the hub, the app and the lightweight premade systems (fs, input, code, schedule and api). On the first
start it makes the admin account and prints everything you need:

```text
The harness is running.
  Open:      http://127.0.0.1:4300
  Or:        http://192.168.1.20:4300   (a phone on this network: https://192.168.1.20:4300, see Settings > App)
  Sign in:   admin@harness.local
  Password:  Zq3…   (saved in /home/you/.harness/admin.json)
  fs serves: /home/you/projects
```

Open the address, sign in with that email and password, and add a model provider under **Models › Providers** (or
set `OPENROUTER_API_KEY` before the first start, and the hub configures OpenRouter itself). Ctrl+C stops everything;
`fnloom start` again picks up where it left off.

**The systems are live.** A system that connects for the first time is normally *installed, not live*: nothing it
offers reaches the chat until an admin has looked at what it adds (Admin › Systems › Review and go live). The premade
systems `fnloom start` runs, and the ones you install by name with `fnloom system install <name>`, are put live for
you, since you just asked for them. Systems from anywhere else (a folder, a zip, npm, or one the chat wrote) still wait
for your review.

| Option | Setting | Default | What it is |
|---|---|---|---|
| `--port <n>` | `HARNESS_PORT` | 4300 | the hub and the web app it serves (http and https on the same port) |
| `--data <dir>` | `HARNESS_DATA` | `~/.harness` | the database, files, keys, logs and installed systems |
| `--root <dir>` | `HARNESS_DEV_ROOT` | the folder you start in | the folder the fs system serves |
| `--systems <list>` | `HARNESS_DEV_ONLY` | see below | what to run: `hub` plus lightweight system names (`fs`, `input`, `code`, `schedule`, `api`, `widgets`, `calendar`, `embedder`); `--systems hub` runs no systems. The heavy ones (database, web, claude) are installed instead, and then start with the hub |
| | `HARNESS_ADMIN_EMAIL`, `HARNESS_ADMIN_PASSWORD` | made on the first start | your own admin account instead of the generated one (set before the first start) |
| | `OPENROUTER_API_KEY` | none | configures the OpenRouter provider on the first start |
| | `HARNESS_DEFAULT_MODEL` | `openrouter/auto` | the chat agent's model until an admin picks one |

Settings can be in the environment or in a `.env` file in the folder you start in. Every other hub setting is listed
in `.env.example` in the repository.

`admin.json` in the data folder is readable only by you; it is how `fnloom system install` and the other hub
commands sign in to the hub `fnloom start` runs, without being told how. Keep it private, as you would the data
folder itself.

## Use it on your phone

The hub listens on every network address of the computer, and answers https on the same port with a certificate from
its own small certificate authority. To install the app on a phone (and get notifications), open **Settings › App ›
Use it on your phone** on the computer: it shows a QR code to download that authority, the steps to trust it on
iPhone or Android, and a QR code for the hub's https address. After that, open the address on the phone and choose
**Install app** (Android) or **Share › Add to Home Screen** (iPhone). A real certificate (Tailscale, mkcert, a reverse
proxy) works too: see "Installing the app, and HTTPS" in [`docs/harness.md`](https://github.com/ClickerMonkey/fnloom/blob/main/docs/harness.md).

## Premade systems

The harness comes with these systems. `fnloom start` runs the lightweight ones in the first group (they need
nothing beyond what the hub already has); install the others when you want them. The heavy ones (database, web and
claude) fetch their own dependencies when you install them, into that system's folder in the data folder, so a
machine that never installs web never downloads puppeteer's Chrome. `fnloom system available` prints the same list.

| System | Started by `fnloom start` | What it adds |
|---|---|---|
| `fs` | always | files and folders as resources; read, write, search, and shell commands with approval |
| `input` | always | forms the agent asks you to fill in |
| `code` | always | fns written as small programs that call other fns |
| `schedule` | always | fns that run on a schedule (every day at 9, once next Friday) |
| `api` | always | fns that call web APIs, written from a service's OpenAPI document |
| `google-calendar` | when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set | each person's own Google Calendar |
| `embedder` | when `HARNESS_EMBEDDER_URL` is set | embeddings from an EmbeddingGemma service, for search and suggestions |
| `database` | no: install it (brings `widgets`; fetches the SQLite driver built for your machine) | SQL databases (SQLite, Postgres, SQL Server): tables as types, kept queries as fns |
| `widgets` | no: comes with `database` | charts and tables drawn from database queries, saved as widgets |
| `web` | no: install it (fetches puppeteer and its Chrome) | web search ([Tavily](https://tavily.com)), page reading and site crawls |
| `claude` | no: install it (fetches the Claude Agent SDK) | Claude Code sessions on this machine, managed from the harness |
| `mcp` | no: add servers in the app | MCP servers' tools as fns, prompts as commands |
| `ollama` | no: install it | runs (or talks to) Ollama and offers its models |

### Installing one

With `fnloom start` running, in another terminal:

```sh
fnloom system install <name> [--config <file.json>]
```

`<name>` is a premade system's name from the table. The hub installs it from the copy that came with the harness
(for database, web and claude it also runs `npm install` of their own dependencies into the system's folder, which
takes a minute), pairs it, gives it the config, starts it, and starts it again every time the hub starts. The command waits until it
has connected and says so. If the hub runs on another port or keeps its data somewhere else, say so:
`--hub http://127.0.0.1:4620` and `HARNESS_DATA=<the data folder>` (that is where it finds `admin.json`). It then
puts the system live and says so.

A system that needs config and was installed without it connects and waits: fill its config on its page in the app
(**Admin › Systems › <name>**) instead. Manage installed systems with `fnloom system list`, `fnloom system stop <name>`,
`fnloom system start <name>` and `fnloom system uninstall <name>`, or on the same page.

The config each one takes:

- **schedule**: nothing (it starts with `fnloom start`). Its limits (schedules per person, firings per day, the
  shortest gap between firings) all have defaults; change them on its page in the app.
- **database**: one instance per database; the first install also installs **widgets** (charts and tables over its
  queries) when the hub doesn't have it. Installing widgets on its own works too, and says it wants database. For a
  new SQLite file in the system's data folder:

  ```json
  {
    "label": "My database",
    "connection": { "kind": "sqlite-new", "path": "my.db" },
    "data": "read-write",
    "schema": "allowed",
    "enrich": { "on": false },
    "audience": { "visibility": "private", "with": [] }
  }
  ```

  `fnloom system install database --config database.json`. `data: "read-only"` and `schema: "none"` keep it from
  changing anything; `connection` can also be an existing SQLite file, Postgres or SQL Server (the system's page in
  the app has a form for every field).
- **api**: nothing (it starts with `fnloom start`). Services are added in the app (**Admin › API services**) or by
  asking the agent.
- **web**: a Tavily key for search, `fnloom system install web --config web.json` with `{ "tavilyKey": "tvly-…" }`;
  without one it installs and waits for the key on its page in the app.
- **google-calendar**: a Google OAuth client (a "Web application" client) with `<hub>/connect/callback` among its
  redirect URIs: `{ "clientId": "…", "clientSecret": "…", "hubUrl": "http://127.0.0.1:4300" }`. Each person then
  connects their own calendar on the Calendar page.
- **embedder**: an EmbeddingGemma service: `{ "url": "http://127.0.0.1:8760" }`.
- **ollama**: an Ollama that already runs, `{ "server": { "mode": "url", "url": "http://127.0.0.1:11434" } }`, or
  one it installs and runs itself in its data folder once an admin approves:
  `{ "server": { "mode": "managed", "autoStart": false } }`.
- **claude**: Claude Code signed in on this computer, and the folders its sessions may start in:
  `{ "folders": [{ "path": "/home/you/projects", "label": "projects" }] }`.
- **mcp**: nothing to install by hand: add each MCP server under **Admin › MCP servers** (stdio, HTTP or SSE), and the
  hub runs one instance of the mcp system for it.

You can also install a system from a folder (`fnloom system install ./my-system`), a package zip made by
`fnloom system pack`, or npm (`fnloom system install some-system@1.0.0`). `fnloom system new <name>` starts a new
one from the template.

## Updating and removing

- Update: stop it (Ctrl+C), `npm install -g fnloom@latest`, start it again. Your data folder stays as it is.
- Remove: `npm uninstall -g fnloom`, then delete the data folder (`~/.harness`) if you don't want its data.
