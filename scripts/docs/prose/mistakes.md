### Mistakes the compiler refuses

Each of these is a compile-time test in `packages/sdk/typetests`: the code under the comment does not compile, for the
reason given. If you see one of these errors, the fix is in the reason.

<!-- generate: mistakes -->

### Mistakes that compile but are wrong

- **Writing a TypeScript type by hand for a shape a gin type describes.** Infer it: `Infer<typeof X>`, `ValueOf<typeof T>`,
  `ConfigOf<(typeof c)['defs']>`.
- **Referring to things by string.** Use refs (`notes.fns.find`, `hub.fns.ask_user`) in deps, tools, context, links and
  hooks; a string can't be checked.
- **Throwing for an expected case.** Return `ctx.invalid(...)` for a mistake in the args and `ctx.fail('caller', ...,
  { code })` for a refusal; a throw is reported as a failure with the error's text.
- **Using `ctx.fail` for the caller's mistake.** An id that doesn't exist, an empty search or a range the wrong way
  round is `ctx.invalid`: the agent retries it, and the chat shows it softly.
- **Catching `Suspended`.** A general `catch` around a call must rethrow what it doesn't handle; `Suspended` means the run
  is pausing.
- **Ignoring `ctx.signal`.** Pass it to fetch, child processes and long loops, or cancel and timeouts can't stop the run.
- **Undo payloads that point at things that change.** Store what is needed to put things back (the old content as a
  `ContentRef`, the row as it was), and record it with `ctx.undoWith` as soon as the first irreversible step is done.
- **Unstable call keys in pausable fns.** Give `{ key }` to calls in fns that pause, so a resumed run gets results back.
- **Reading `process.env` in feature code.** Put tunables in the env slice and pass them in.
- **Keeping state in module variables.** Use session state (`state:`) for values fns share in a chat, `ctx.dataDir` for
  data, and the hub's config for config. A process restarts; a module variable doesn't survive it.
- **Writing into the system's own folder at runtime.** Use `ctx.dataDir` and `ctx.cacheDir`.
- **Calling a model provider directly.** Every model call goes through `ctx.llm` (or `harnessAiOf(ctx.llm)`), so the hub
  can choose, budget and record it.
- **Node imports in `shared/`.** The contract is imported by the browser and other systems.
- **A system name that differs from `system.json`.** The build and `serve()` refuse it.
- **`async` with no `await`.** This repository's lint (`require-await`) refuses it: write `run(args, ctx) { return
  Promise.resolve(ctx.done(result)); }` for an implementation that has nothing to wait for.
- **Progress on every item of a long loop.** Report a few dozen times per run.
- **Vague descriptions.** The LLM picks fns by their description and fills args from their types and docs: say exactly
  what the fn does and give examples for args that are easy to get wrong.
