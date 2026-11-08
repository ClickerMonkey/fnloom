**Context** is text for the LLM: a guide, a skill, a reference, the state of something. The hub suggests it when a
message is about it, an agent can always have it (`alwaysFor`, `agent({ context })`), and a person loads it with a
`/command`. `context({ description, … })`:

- **Static** when it has `content`: the text is in the contract. `{{name}}` in the content is filled from the
  command's args.
- **Dynamic** when it has no `content`: the server makes the text each time it is loaded, so it can be current (a folder
  tree, the newest notes). The server **must** implement it under `context`, as `async (args, ctx) => text`.
- `command: { name, args? }` makes it a `/name` command. Each arg is `arg(hint, { required? })`, required unless
  `{ required: false }`; the implementation's `args` are typed from them (`{ tag?: string }`).
- `fns`: fns that come with it, loaded into the toolset when it is loaded; `suggestFns`: fns suggested with it.
- `imports`: other context it brings along.
- `suggest` and `visible`: who it may be suggested to and who can find it in searches (`both`, `user`, `llm`, `none`).
- `alwaysFor`: agents that always have it loaded. `tags`: free labels.
- For the graph contextor (the one small local models use): `weight` (0 to 2, default 1) is how much it counts,
  `summary` a short form sent when the budget allows only a little, `parent` and `next` place it in a hierarchy or a
  chain of pieces, and `links` are weighted edges (`{ to, relation, weight? }`) to other context, fns, named types or
  resources (`{ uri, section? }`). `imports` and `brings` make items travel together; `suggests`, `related`, `about`,
  `parent` and `next` pass on part of an item's score.

<!-- include: scripts/docs/example/shared/index.ts#context-decl -->

<!-- include: scripts/docs/example/server/impl.ts#impl-context -->

A dynamic context's `ctx` is the system context (config, LLM, resources, types, log, data folders) plus who is asking
(`ctx.user`, `ctx.time`, and the session when there is one). Keep context focused: a short guide that names its fns
beats a long manual, and the hub budgets what it sends to small models.
