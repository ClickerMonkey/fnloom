### Settings

A **setting** is a typed control an admin (or, if allowed, the person or a fn) sets per actor: a user, a group, an
agent, a system or a hub MCP. `setting({ description, type, appliesTo, merge, editableBy? })`:

- `type`: the value's gin type (the admin's form is drawn from it).
- `appliesTo`: the actor kinds it can be set on (`user`, `group`, `agent`, `system`, `mcp`).
- `merge`: how a user's value combines with their groups': `user-wins`, `union`, `intersect` or `most-restrictive`.
- `editableBy`: besides admins, `self` (the person for themselves) and `fns` (fns may set it).

A run reads the effective value for its person with `await ctx.setting(notes.settings.editing)`, typed, or `undefined`
when nothing is set; always handle `undefined` with a safe default.

<!-- include: scripts/docs/example/shared/index.ts#setting -->

### Attachments

An **attachment** is data a fn adds to the assistant message its run belongs to, drawn by the system's renderer for
it (a diff, a chart, a card). Declare it with `attachment({ description, data })`; a run attaches with
`ctx.attach(notes.attachments.note, data, title)`, and the data is checked against the type (wrong data doesn't
compile). Without a renderer the chat shows the data as a plain card. To attach a link instead (a resource, a URL, a
stored file or another run), use `ctx.link({ resource })`, `{ url, title }`, `{ file, title }` or `{ run, title }`.
