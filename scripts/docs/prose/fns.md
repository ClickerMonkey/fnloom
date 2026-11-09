A **fn** is something people, agents and code can run: a name, a description, typed args and a typed result. A
**native** fn is implemented in code by its own system and declared with `fn({ … })`. Only `description`, `args` and
`returns` are required; every other option changes what the fn can do, and the types follow:

| Option | What it does | What it changes in the server |
|---|---|---|
| `description` | one sentence: what it does, for people and the LLM | |
| `instructions` | extra guidance the LLM sees when the fn is in its toolset | |
| `args`, `returns` | gin types of the args (an object) and the result | `run(args, ctx)` gets typed args; `ctx.done(result)` checks the result |
| `examples` | example calls (`{ args, note? }`) agents see on its card and when they get its args wrong | a wrong example doesn't compile |
| `status` | the words its runs show, per phase (below) | tokens are checked against args and result |
| `tags` | free labels; `read` marks a fn that changes nothing, so policies may run it without asking | |
| `deps` | fns its implementation may call, as refs: `{ read: fs.fns.read }` | `ctx.fns.read(args)` exists, typed; nothing else can be called |
| `handlers` | callbacks the caller may supply mid-run (**Handlers and progress**) | `ctx.handlers.confirm(...)` |
| `progress` | `linear` or `steps({ … })` (**Handlers and progress**) | `ctx.progress.set(f)` or `ctx.progress.step(name, status)` |
| `undo` | a gin type of the undo payload: the fn is undoable | `undo(payload, ctx)` must be implemented |
| `resume` | a gin type of the resume payload: the fn can pause | `ctx.pause(state)`, `ctx.onPause`, `ctx.resume` |
| `state` | the session state fields it reads and writes (**Session state, forms and display**) | `ctx.state` sees exactly these fields |
| `form` | a gin type its renderer submits back to the waiting run | `await ctx.form()` |
| `display` | how a finished run looks: `card` (default), `message`, `hidden` | |
| `operations` | `{ cancel?, background? }`, both default `true`; pause and undo follow `resume` and `undo` | |
| `limits` | `{ timeout?, retries?, cost? }`: hard limit per run, retries for `retry` failures, a rough cost | |
| `visibility` | who sees it: `both` (default), `user` (people only, not the LLM), `llm`, `none` | |

<!-- include: scripts/docs/example/shared/index.ts#fn-add -->

<!-- include: scripts/docs/example/shared/index.ts#fn-find -->

**Status words.** `status` gives each phase (`active`, `retry`, `done`, `failed`) a `one` form for a single run and a
`many` form for a group of runs of the fn. In `one` forms, `{args.<path>}` reads the args and, in `done` only,
`{output.<path>}` reads the result; `many` forms may use only `{fn}` and `{n}` (the count). `{args.path|a file}`
gives a fallback for a missing value. A token for a path the args or result don't have doesn't compile. Without
`status`, runs show the kind's words or the hub's defaults (`DEFAULT_STATUS`). Give all four phases; keep them short
and in the present (`Reading {args.path}…`) and past (`Read {args.path}`) tense.

**Writing fns an LLM uses well.** The description says what it does in one sentence. Args are few, named for what
they are, with `g.field(…, { docs })` where a value needs explaining; prefer enums and bounded numbers to free text.
Return what the caller needs next (ids, counts, whether it was truncated), not a wall of text. Use `examples` for any
fn whose args are easy to get wrong. Tag read-only fns `read`.

**Implementing a fn.** Each native fn is `{ async run(args, ctx) { … } }` under `fns` in the implementation, returning an
outcome built with the ctx helpers (**Outcomes**):

<!-- include: scripts/docs/example/server/impl.ts#impl-add -->

Fns can also be added and removed while the system runs: `running.add(name, fn({ … }), impl)` returns the new fn's
typed ref, and `running.remove(ref)` removes it (**The server**).

**Validation hooks.** `validate: { input, output }` adds checks the hub asks the system for around a run. `input(ctx,
args, state)` runs before the run starts: `{ ok: false, reason }` means the fn can't run now, and the model reads "Not
available now: reason" (it isn't an error, and the fn isn't run). `output(ctx, args, result, state)` runs after it is
done: `{ ok: false, action: 'retry', reason }` asks the model to try again (a few times a turn), `action: 'stop'` fails
the run with the reason shown to the person. `ctx` is the system context with the run and, for output, the attempt;
`state` is the session state fields the fn declares, as they are now. An output check runs after the fn has done its
work, and a refused result's undo is dropped: a fn with side effects should check what it can in `input`, or undo its
own work before answering `retry` or `stop`.

**Per-person systems.** A system that acts as each person (a calendar) adds `connect` to its contract with
`.with({ connect: { title, description, how, settings, fns } })`, naming the fns that act as the person and whether
each is on and asks first by default. Its implementation then has `connect: { start, finish, disconnect }`: `start`
gives the provider's sign-in URL (pass the hub's `state` through), `finish` turns what came back into the account and
credentials (or a `problem`), `disconnect` revokes them. In a run, `ctx.connection` is the connection it acts as
(credentials and the person's settings), and `ctx.updateConnection({ credentials })` hands refreshed tokens back.
A fn that adds a fn for the person (a saved form) gives it to them with `ctx.shareFn(name, { visibility, with })`.

```ts
buy: fn({
  description: 'Buy an item.', args: g.obj({ count: g.num({ whole: true }) }), returns: g.obj({ total: g.num() }),
  validate: {
    input: (_ctx, args) => (args.count > 0 ? { ok: true } : { ok: false, reason: 'Buy at least one.' }),
    output: (ctx, _args, result) => (result.total <= 100 ? { ok: true } : { ok: false, action: ctx.attempt > 1 ? 'stop' : 'retry', reason: 'Too expensive.' }),
  },
}),
```
