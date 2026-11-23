Every run ends in an **outcome**, built with the ctx helpers, which are typed to the fn (its result, undo and resume
types). Return exactly one; never throw to report something the caller should hear.

| Helper | Status | Use it when |
|---|---|---|
| `ctx.done(result, { undo?, cost? })` | `done` | it worked. `undo` records how to reverse it (undoable fns only) |
| `ctx.invalid(problems, { cost? })` | `invalid-input` | **the caller's mistake** the types can't catch: an id that doesn't exist, an end before a start, nothing to search for. Give a message or `[{ path, message }]` problems (`path` a dotted path into the args, `''` for the whole). An agent gets the problems back and retries; the chat shows the run calmly as "Thinking harder". Not an error |
| `ctx.fail(class, message, { code?, data?, undo?, cost? })` | `failed` | **a real failure.** `class` is `retry` (temporary: the hub retries per `limits.retries`), `caller` (refused for a reason the caller must hear: full, denied, conflict) or `fatal` (a bug or broken setup). `code` is a stable word for programs (`not-found`, `denied`, `full`) |
| `ctx.pause(state)` | `paused` | it can stop and continue later (fns with a `resume` type only) |
| `ctx.cancelled({ partial?, undo? })` | `cancelled` | it stopped because it was cancelled or the person said no |

**Invalid input versus errors.** Args that don't fit the fn's gin types never reach the fn: the hub and the runtime
answer `invalid-input` for bad JSON, a schema mismatch and failed validation. Inside the fn, use `ctx.invalid` for any
other mistake in the args, and `ctx.fail` only for real failures. A thrown exception becomes a `failed` outcome with the
error's message; that is for bugs, not for expected cases.

**Cancel and timeouts.** `ctx.signal` aborts when the run is cancelled, paused or past its deadline. Pass it to anything
that takes a signal (fetch, child processes, ayepi calls) and check `ctx.signal.aborted` in long loops; then return
`ctx.cancelled({ partial })` with what you managed. A run past its deadline is reported as timed out whatever it returns.
`ctx.allow({ cancel: false })` narrows what can be done to the run right now ("no cancelling during the commit").

### Undo

Declaring `undo: <gin type>` makes a fn undoable: `ctx.done(result, { undo: payload })` records the payload, and the
server **must** implement `undo(payload, ctx)`, which returns an `UndoOutcome`: `{ status: 'undone', summary }`,
`{ status: 'failed', error }`, or `{ status: 'gone' }` when there is nothing left to undo. Record the payload with
`ctx.undoWith(payload)` as soon as the first irreversible step is done, so a run that then fails or is cancelled can
still be undone (the last payload recorded wins). The payload holds what is needed to put things back (the previous
content by `ContentRef`, the row as it was), never a reference to something that can change. Undo runs later, perhaps
after a restart, with only the payload and an `UndoCtx`.

<!-- include: scripts/docs/example/server/impl.ts#undo-helper -->

### Pause and resume

Declaring `resume: <gin type>` makes a fn pausable. Register `ctx.onPause(() => state)`: when someone pauses the run, the
hub asks this hook for the state to resume from, the run settles as `paused` straight away, `ctx.signal` aborts, and any
call the fn is waiting on rejects with `Suspended` (let it propagate; never catch it). Resuming runs the fn again with
`ctx.resume` set: `ctx.resume.state` is the state, `ctx.resume.calls` the results of child calls that finished (by call
key, so they aren't made again), and `ctx.resume.reason` says whether a person resumed it or the hub restarted.

<!-- include: scripts/docs/example/server/impl.ts#impl-tidy -->

**Results with rows.** A fn whose result is rows gives the rows to the person (an attachment holding a
`ResultTable`) and the model a `ResultBlock`: `resultBlock(table, { fn: { name, signature }, args })` from
`@harness/sdk/server` says what the person sees and that the model shouldn't repeat it, lists the columns, the row
count, the total when counted, whether there are more rows with the exact call for the next page (`nextPage`), the
sort, and a `sample` of the first rows within `HARNESS_RESULT_SAMPLE_TOKENS` (long text cut at
`HARNESS_RESULT_CELL_CHARS`), with a `sampleNote` saying how much is there. `ResultBlockType` is its gin form for
`returns`.
