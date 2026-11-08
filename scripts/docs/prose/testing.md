Test a system end to end without a network with **`FakeHub`** (`@harness/sdk/server/testing`): a hub in memory that
serves the real link spec, so the system under test runs its real link, handshake, runtime and wire checks. Only the
hub's own behaviour is scripted: child calls (`onCall`), handler answers (`onHandle`), LLM answers (`onLlm`), type
definitions (`onTypes`), resource reads (`onResource`), and setting values (`settings`).

- `new FakeHub({ config })` holds the system's config (absent: none yet, so a system with a config type waits as
  `needs-config`); `serve(contract, impl, { hub: 'ws://hub.test/link', state: 'unused' }, hub.host())` connects to it;
  `await running.ready()` waits until it is imported.
- `await hub.run('<system>/<fn>', args)` runs a fn and resolves with its outcome on the wire (`OutcomeWire`: `{ status:
  'done', result }`, `{ status: 'invalid-input', invalid }`, `{ status: 'failed', error }`, …).
- What the system sent is recorded: `hub.manifests`, `hub.attachments`, `hub.progress`, `hub.calls`, `hub.logs`, and
  the rest; `hub.peer()` calls the system's link endpoints directly (`embed`, `hook`, `mention`, …).
- `hub.configure(value)` changes the config; `hub.drop()` drops the link to test reconnects.

<!-- include: scripts/docs/example/server/notes.test.ts#test -->

Also unit-test the parts behind each interface (a store, a parser) directly, with temp folders and fixed clocks. Keep
tests that call real services (a model, an API) in `*.live.test.ts` files, marked and minimal; `npm run test:live` runs
them, `npm test` skips them.

**Compile-time tests.** For a mistake the types must refuse, write it under `// @ts-expect-error <why>`: if it ever
compiles, `npm run typecheck` fails. `expectType<Equal<A, B>>(true)` asserts two types are the same. The SDK's own
compile-time tests are the source of **Common mistakes**.

**Before you finish:** `npm run typecheck` (every project, the new system included once it is in the root
`tsconfig.json` references), `npx vitest run systems/<name>`, and `npm run lint`.
