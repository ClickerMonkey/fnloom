`serve(contract, impl, options, host?)` (from `@harness/sdk/server`) connects to the hub, pairs the first time, sends the
manifest (or nothing when the hub already has this version of it), and serves the implementation over the link. It
resolves with a `RunningSystem` once it has started connecting; `running.ready()` resolves once it is connected,
configured and imported.

The implementation's type is `SystemImpl<(typeof contract)['defs']>`, computed from the contract. Each section is
**required** when the contract declares something there and **forbidden** when it doesn't:

| Implementation section | One entry per | Shape |
|---|---|---|
| `fns` | native fn (not agents or fns of a kind) | `{ run(args, ctx), undo?(payload, ctx) }`; `undo` exactly when the fn declares `undo` |
| `types` | named type with methods | `{ <method>: { run(self, args, ctx), undo? } }` |
| `kinds` | kind | `{ check, describe, run, undo? }` |
| `context` | dynamic context (no `content`) | `async (args, ctx) => string` |
| `hooks` | hook | `async (input, ctx) => HookContribution[]` |
| `mentions` | mention provider | `{ search, hover, llm }` |
| `embedders` | embedder | `async (texts) => number[][]` |
| `sectioners` | sectioner | `async (text, stat) => Section[]` |
| `actions` | action | `async (input, ctx) => result` |
| `resources` | (optional) | a `ResourceProvider` |
| `events` | (optional) hub event type it handles | `async (event, ctx) => void` |
| `lifecycle` | (optional) moment | `async (ctx) => void` |

Build the implementation in a function that takes its dependencies (`createNotesImpl(deps)`), so `main.ts` passes the
real ones and tests pass fakes:

<!-- include: scripts/docs/example/server/impl.ts#deps -->

The process, `server/main.ts`: parse the env slice, build the dependencies and the implementation, optionally build
the renderers, and serve. `loggedHost(name)` gives the real host with structured logging and its logger.

<!-- include: scripts/docs/example/server/main.ts#main -->

**Options** (`ServeOptions`): `hub` (the link URL, `ws://<host>:4300/link`), `state` (the folder for its key pair and
outcome journal), `pairingToken` (a one-time token an admin made), `client` (the folder of the built renderers),
`version` (default: from `package.json`), `mcp` (also serve its native fns as an MCP server over stdio or HTTP),
`connectTimeout`, and seams for `files` and `fetch`.

**Env.** A system's tunables are an `@ayepi/env` slice that spreads `systemFields()` (the hub URL `HARNESS_HUB`, the
instance `HARNESS_INSTANCE`, the pairing token `HARNESS_PAIRING_TOKEN`, the data and cache folders) and its own, each a
zod schema with a default and a TSDoc line, then adds `systemState('<name>')`: the state folder
`HARNESS_SYSTEM_STATE`, which defaults to one of its own per instance. Feature code never reads `process.env`:

<!-- include: scripts/docs/example/server/env.ts#env -->

**Pairing.** The first time a name connects, the hub has never seen it, so the system waits as `pairing`: it logs a
pairing code and link (and a QR code), and an admin approves it in the hub, filling in its config. With a pairing token
it pairs at once. Later starts prove the key kept in `state`. With a config type, the system waits as `needs-config`
until an admin sets a valid value; its fns are unavailable meanwhile.

**At runtime.** `running.add(name, fn({ … }), impl)` adds a native fn and returns its typed ref (a fn of a kind needs
no implementation); `running.remove(ref)` removes it; `running.restart(reason)` restarts the process (the hub imports
what changed); `running.onStatus(listener)` follows `connecting`, `pairing`, `needs-config`, `connected`,
`disconnected` and `stopped`; `running.stop()` stops it.
