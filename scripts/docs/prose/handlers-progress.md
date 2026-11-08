### Handlers

A **handler** is a callback a fn asks its *caller* for in the middle of a run ("delete this note?", "pick a folder").
Declare it with `handler({ description, args, returns, required })`. A person answers with a form the chat draws from
the handler's types, an agent or code answers with a function.

- `required: true`: every caller must pass it. A caller that can't answer can't call the fn, and code calling it
  through `ctx.fns` must pass `{ handlers: { … } }` or the call doesn't compile. In the run it is always there.
- `required: false`: the caller may leave it out, so in the run `ctx.handlers.confirm` is `HandlerFn | undefined`, and
  calling it without checking doesn't compile.

A handler that gets no answer (refused, failed, timed out) throws `HandlerFailed`; let it propagate unless the fn can do
something better.

<!-- include: scripts/docs/example/shared/index.ts#fn-remove -->

<!-- include: scripts/docs/example/server/impl.ts#impl-remove -->

### Progress

A fn reports progress one of three ways, declared with `progress`:

- nothing (the default, `noProgress`): `ctx.progress` has nothing to call;
- `linear`: a fraction from 0 to 1 with an optional message, `ctx.progress.set(0.4, 'half way')`;
- `steps({ name: 'Title', … })`: named steps, each `pending`, `active`, `done`, `failed` or `skipped` with an optional
  detail, `ctx.progress.step('scan', 'done', '12 notes')`. Only the declared names compile.

Progress reaches the chat live and the fn's renderer gets it typed as `view.progress` (`{ fraction, message? }` or
`{ steps: { <name>: { status, detail? } } }`). Report often enough to look alive but not on every item of a long
loop: each update travels to the hub and on to the chat, so a few dozen updates per run (or one every few hundred ms)
is plenty.

<!-- include: scripts/docs/example/shared/index.ts#fn-tidy -->
