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
`server.external`) and the client into `dist/`; `pack` hashes every file into `files` and zips `dist/`; the hub checks a
zip before installing it (format, protocol, every file's hash, no path leaving the folder).

Commands that talk to a hub take `--hub <url>` and `--token <token>` (or `HARNESS_URL`, `HARNESS_TOKEN`, or the admin
account in `.env`). An installed package is code that runs as the hub's user: install only what you trust.

### Running it during development

Start the process by hand against a running hub: `HARNESS_HUB=ws://127.0.0.1:4300/link npx tsx systems/<name>/server/main.ts`.
The first start waits for pairing (approve it in the hub's admin pages, or start it with `HARNESS_PAIRING_TOKEN` from a
token an admin made). A system that runs under the hub (installed) restarts when it exits with `RESTART_CODE`, which
`running.restart(reason)` does for it. The fs system can edit a system's source and restart it, so an agent can add
fns to a system and see them live.

### Adding a new system to this repository

Besides the folder itself: add `{ "path": "systems/<name>" }` to the root `tsconfig.json` references (so
`npm run typecheck` checks it) and the folder to the root `package.json` workspaces (then `npm install`) if other
packages import it.
