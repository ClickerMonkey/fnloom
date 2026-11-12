### `system.json`

The package manifest, `system.json`, is the one source of a system's name, version and entries. Its contract's name
must equal `name`. Its schema (`SystemPackageManifest` in `@harness/core`, as JSON Schema):

<!-- generate: system-json-schema -->

- `format`: the package format, `1`. `protocol`: the link protocol it speaks, `1`; the hub refuses a package it can't
  talk to.
- `server.entry`: `server/main.ts` in source (`server/main.js` once built); `server.external`: npm packages left out of
  the bundle (native addons), by version range, which the installer installs; `server.node`: the Node versions it runs on.
- `client.entry`: `client/index.ts`, when it has renderers.
- `instances`: `one` (a single instance named `main`) or `many` (a fleet).
- `files`: the sha-256 of every packed file, written by `pack` and checked by install. Never write it by hand.

### The `harness` CLI

Every command, read from the CLI itself:

<!-- generate: cli-commands -->

`harness system new` fills the name in everywhere the template has `template`: as is in strings and paths, in camel
case in identifiers (`templateEnv` becomes `notesDbEnv`) and Pascal case in type names (`TemplateDeps` becomes
`NotesDbDeps`). `build` typechecks, checks the contract's name against `system.json`, bundles `server/main.ts` (all but
`server.external`) and the client into `dist/`, and writes `dist/contract.json`: the manifest the built bundle declares
and its hash, read in a child process with no file writes, network or child processes. Pairing and install bind to that
hash, so the contract an admin approved is the one that runs. `pack` hashes every file into `files` and zips `dist/`;
the hub checks a zip before installing it (format, protocol, every file's hash, no path leaving the folder).

### Installing from the chat, review and Go live

`fs/install_system` builds the folder, runs its tests and shows an admin a card: what the system adds (or the change
from the running version), the bundle scan (the Node built-ins it uses, risky ones as concerns, the hosts and URLs in
its code), the test results, and the grants it declares, which are enforced from the moment it starts. Once the card is
approved, fs starts it and it pairs with the hub. It is then **installed**, not live: the hub knows its contract but
offers nothing of it, and only an admin's test calls run. An admin opens its review page
(`/admin/systems/<name>/review`), looks over what it declares and adds, switches off anything unwanted, and presses
**Go live**. From then on a change to its contract (a new fn, a changed type, other grants) waits as a **pending
review** with a diff: the live version keeps serving and the change stays off until an admin approves it. Additions a
fn declared it makes while running (its registry effects) go live at once.

So after `fs/install_system` says it connected, tell the person what is left: an admin reviews the system at
`/admin/systems/<name>/review` and presses Go live (or approves the pending review, after an update). Don't call its
fns before then; they aren't offered yet.

Commands that talk to a hub take `--hub <url>` and `--token <token>` (or `HARNESS_URL`, `HARNESS_TOKEN`, or the admin
account in `.env`). An installed package is code that runs as the hub's user: install only what you trust.

### Running it during development

Start the process by hand against a running hub: `HARNESS_HUB=ws://127.0.0.1:4300/link npx tsx systems/<name>/server/main.ts`.
The first start waits for pairing (approve it in the hub's admin pages, or start it with `HARNESS_PAIRING_TOKEN` from a
token an admin made); once paired it is installed and waits for review and Go live, like a system installed from the
chat. A system that runs under the hub (installed) restarts when it exits with `RESTART_CODE`, which
`running.restart(reason)` does for it. The fs system can edit a system's source and restart it, so an agent can add
fns to a system and see them live.

### Adding a new system to this repository

Besides the folder itself: add `{ "path": "systems/<name>" }` to the root `tsconfig.json` references (so
`npm run typecheck` checks it) and the folder to the root `package.json` workspaces (then `npm install`) if other
packages import it.
