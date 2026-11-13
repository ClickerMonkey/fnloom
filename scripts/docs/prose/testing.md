Every system tests itself with the SDK's **test kit** (`@harness/sdk/testing`), in vitest, with no setup:

- **`testHub(contract, impl, { config, model })`** serves the system to a fake hub in memory; every `ctx.*` call it
  makes is recorded. `kit.call('<fn>', args)` takes the fn's own args type and gives `{ result, progress, hubCalls }`:
  the typed result, the progress it reported, and what it asked the hub for (`calls`, `forwards` to the model,
  `decisions`, `proposals`, `patches`, …). `kit.run` gives the outcome instead (for `invalid-input` or `failed`);
  `callFn(contract, impl, '<fn>', args)` serves, calls and stops in one line. Call `kit.stop()` after each test.
- **Models.** `mockModel([toolCall('search', { text: 'x' }), 'Saved.'])` answers `ctx.ai()` with scripted replies, in
  order; `mockModel({ recording: 'test/title.json' })` replays replies recorded once from a real model. A few tests may
  call a real free model with `realModel.it('…', async (model) => { … })` and pass `model` to `testHub`: they are
  marked `real` and skipped without `OPENROUTER_API_KEY`.
- **Kinds.** `kit.kindProps('<kind>', payload)` gives the problems the kind finds in a payload and the fn props it
  derives. `kit.runKind('<kind>', '<fn>', payload, args)` runs a fn of the kind as the hub runs a saved one (a code
  program, an API request) and gives its outcome, progress and hub calls.
- **Proposals.** A proposed run waits in `kit.hub.proposals` until the test settles it as its approver would:
  `kit.approve('<key, approval or run>', answer?)` runs it on the system (the answer at `args[ask.into]` when it asks
  one) and sends the `run` event `done`; `kit.decline(which, reason?)` sends it `cancelled` with the hub's words. A
  settled proposal can't be settled again, and outside a run its key then proposes afresh.
- **Instances people connect to.** `kit.hub.instanceConnect` is what the instance last said (`ctx.instanceConnect`);
  `kit.hub.instanceConnects` lists every time, including the one sent again on each reconnect.
- **Data.** The fake hub answers `ctx.data` from records in memory, like the hub (filters, sorts, text search, pages,
  versions, `expect`, person-owned types refused outside runs): `kit.records('<Type>')` reads what runs saved, and
  `kit.hub.data.save(...)` puts records in first. Another system's stored type goes in `kit.hub.storedTypes`.
- **Sensitive files and mentions.** `kit.flags('<fn>', args)` gives the flags its `flags` hook answers, as the hub
  asks before a run. `kit.mentions('<provider>', query)` gives a mention provider's options and the resource searches
  it made (answer them with `kit.hub.onMentionResources`).
- **Files and commands.** `scratchFolder({ git: true, files })` makes a temp folder (a git repository with the files
  committed) to run file and command fns in: change a file, add an untracked or ignored one, and check the change set
  or the flags a fn reports. `repo.dispose()` removes it.
- **Context.** `contextFolder(dir, contract)` checks the context folder: every file parses, every link resolves (fenced
  code is skipped), and `fns` maps each context to the fns it brings. Expect `problems` to be empty.
- **Components.** `preview({ name, module: new URL('./ResultView.vue', import.meta.url), states })` draws a component in
  named states (`empty`, `loading`, `error`, `typical`, `long`, or your own; plain JSON props). A normal run only
  bundles it; `harness test --previews` shoots each state at phone and desktop sizes in light and dark into
  `.harness-test/previews/gallery.html`, for a model or a person to review. `renderHtml(component, props)` renders
  in-process, for quick checks of what a state shows.

**`harness test [dir]`** runs a folder's tests from anywhere and prints the counts and each failure (`--json` gives the
whole report). `fs/install_system` runs them before an admin is asked, and the install card shows the result. Write
tests with every system: a call per fn, a scripted-model test per agent, a `contextFolder` check, and a preview of each
component.

Underneath, the kit's hub is **`FakeHub`** (`@harness/sdk/server/testing`): a hub in memory that
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

Also unit-test the parts behind each interface (a parser, a client of an outside service) directly, with temp
folders and fixed clocks. Keep
tests that call real services (a model, an API) in `*.live.test.ts` files, marked and minimal; `npm run test:live` runs
them, `npm test` skips them.

**Compile-time tests.** For a mistake the types must refuse, write it under `// @ts-expect-error <why>`: if it ever
compiles, `npm run typecheck` fails. `expectType<Equal<A, B>>(true)` asserts two types are the same. The SDK's own
compile-time tests are the source of **Common mistakes**.

**Before you finish:** `npm run typecheck` (every project, the new system included once it is in the root
`tsconfig.json` references), `npx vitest run systems/<name>`, and `npm run lint`.

A context you build by hand (for a unit test of a lifecycle hook or a fn without the fake hub) needs `ctx.propose`
and `ctx.decide`: spread `NO_ASKS` beside `TEST_PLACE`. Proposing then fails and the decision model answers `off`;
`FakeHub` records proposals (`hub.proposals`), answers `decide` with `hub.onDecide`, and asks a system for a preview
with `hub.preview(...)`.
