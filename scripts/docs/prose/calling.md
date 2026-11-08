A fn calls another fn (of its own system, another system or the hub) by declaring it as a **dep** with its ref, then
calling it through `ctx.fns`. Nothing else can be called, and the args, result and handlers are typed by the ref:

<!-- include: scripts/docs/example/shared/index.ts#fn-publish -->

<!-- include: scripts/docs/example/server/impl.ts#impl-publish -->

Every call goes to the hub and is queued like any run, so the hub sees the whole tree and applies permissions,
approvals and budgets. A call returns an `FnCall`, which is awaitable for the result (rejecting with `CallFailed` on
failure or cancel) and is also a handle: `run` (the child run's id), `settled` (never throws: `{ status: 'done',
result } | { status: 'failed', error } | { status: 'cancelled' }`), `cancel()`, `pause()` and `watch(listener)` for live
status and progress.

Options (`CallOptions`): `key` names the call within the run, so a resumed run gets a finished call's result back
instead of calling again (default: the dep name and a counter; give stable keys in fns that pause); `budget` gives the
child less than what is left; `background: true` doesn't wait (the call continues after this run ends); `handlers`
answers the dep's handlers. **A dep with a required handler can't be called without it**: the options with
`{ handlers: { … } }` are required.

A type's method is a dep like any fn: `deps: { reveal: fs.types.Entry.methods.reveal }`, called with the value as
`self`: `await ctx.fns.reveal({ self: args.entry })`.

When the run is paused while waiting on a call, the call rejects with `Suspended`: let it propagate (never catch it in a
general `catch`; rethrow anything you don't handle).
