# random system

Generates a random number between two bounds.

A harness system: a process that connects to the hub over WebSocket and adds fns, types, context and renderers.
`harness system new random` made this folder from `systems/template`; everything still marked `TODO` is a placeholder.
The guide to every part of a system is `packages/sdk/AUTHORING.md`.

## Folder

| Path | What it is |
|---|---|
| `system.json` | the package manifest: name, version, description, link protocol, entries, instances. The one source of the name and version |
| `package.json` | npm dependencies and scripts, for development only |
| `shared/index.ts` | the contract: everything the system offers, with no implementation |
| `server/impl.ts` | the implementation of the contract, built from injected dependencies |
| `server/env.ts` | the tunables (`@ayepi/env`): hub URL, state folder, pairing token |
| `server/main.ts` | the process: builds the implementation and serves it to the hub |
| `server/link.test.ts` | tests over an in-memory hub (`FakeHub`) |
| `client/index.ts` | the renderers (Vue), optional |

## Run it

```sh
npm run typecheck                                  # from the harness repository: every project, this one included
npx vitest run systems/random                      # its tests
HARNESS_HUB=ws://127.0.0.1:4300/link npx tsx systems/random/server/main.ts
```

The first time it connects, the hub has never seen the name, so the system waits to be paired: it prints a pairing code and link (and a QR code). An admin opens the link, checks the code, fills in the config and approves.

## Build, pack and install

```sh
harness system build systems/random                # typecheck, name check, bundle server and client into dist/
harness system pack systems/random                 # hash every file and zip dist/ to random-<version>.zip
harness system install random-<version>.zip        # install on a running hub, which pairs and starts it
```

Config lives in the hub (an admin sets it, checked against the contract's config type), never in a file here. An installed system's data goes in the folders the hub gives it, outside this one, so upgrades keep it.
