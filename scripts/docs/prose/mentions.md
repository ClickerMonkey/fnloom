A **mention provider** lets people point at things the system knows with `@` in the chat (a file, a database row, a
note). Declare it with `mention({ title, description, target, of? })`: `target` is the gin type of the key that gets
stored with the message (keep it small and stable: an id, a path), and `of` names the type of the things it points at,
so chips and cards use that type's display and cards offer its methods.

<!-- include: scripts/docs/example/shared/index.ts#mention-decl -->

The server implements three functions, each getting the person who is asking (`ctx.user`, `ctx.session`), so results
are limited to what they may see:

- `search(query, ctx)`: options for what was typed after `@`, each `{ label, hint?, icon?, target }`. The chip shows
  `label`; `target` must fit the declared type.
- `hover(target, ctx)`: the hover card, asked for when hovered so it is current (`{ title, subtitle?, fields?, body?,
  open?, value? }`), or `undefined` when the thing no longer exists. Give `value` as the `of` type to offer its methods.
- `llm(target, ctx)`: the text the LLM gets for the mention: what the thing is, where it lives, and how to reach it
  with the system's fns.

<!-- include: scripts/docs/example/server/impl.ts#impl-mention -->

A custom hover card is a renderer under `mentions` in **The client**; without one the hub draws the `hover` answer.
