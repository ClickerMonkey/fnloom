### Session state

Each system has a scratch pad per chat session: values its fns pass to each other without the LLM carrying them (a
working folder, the last search, a selection). A fn declares the fields it uses with `state: g.obj({ … })`, and
`ctx.state` reads and writes only those:

- **Matched by name and type.** Two fns share a field only if both declare that name with the same type. A fn sees just
  its own fields; reading or writing another doesn't compile.
- **Scoped to the system** and to the session (a run outside a session gets state scoped to its turn).
- `get()` returns the current values (a field nothing has set is absent), `set(patch)` writes fields, `clear(...names)`
  removes them, and `update(change)` reads and writes in one step so runs at the same time don't overwrite each other.
- **Undoable and live.** Changes are recorded on the run, so undoing a turn puts state back; renderers see their fn's
  fields as `view.state` and update as they change. Actions declare fields the same way.

<!-- include: scripts/docs/example/server/impl.ts#impl-find -->

### Forms

A fn that declares `form: <gin type>` can wait for its renderer: the run calls `await ctx.form()`, the renderer calls
`view.submit(value)` (checked against the type), and the run carries on with the typed value. The hub stores the
submission if the system is offline meanwhile. A fn can be just a form the person fills in, the agent getting the
answer as the fn's result. `ctx.form` is `undefined` on a fn with no `form`, so waiting on one doesn't compile.

<!-- include: scripts/docs/example/shared/index.ts#fn-review -->

<!-- include: scripts/docs/example/server/impl.ts#impl-review -->

The renderer is in **The client**.

### Display

`display` decides what stays in the chat once a run is done: `card` (the default: the fn's renderer, or the hub's card),
`message` (the card turns into a plain message; good for forms and questions), or `hidden` (bookkeeping the person
needn't see). While it runs, every run shows its live status.
