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

**A context folder.** Static context can live in markdown files under the system's `context/` folder instead of the
contract: each file starts with a YAML header between `---` lines holding any context option (`ContextFileHeader`:
`key`, `title`, `description`, `summary` (required), `fns`, `imports`, `choices`, `parent`, `next`, `alwaysFor`, `tags`,
`visible`, …), and the rest of the file is the content. `key` is a stable, readable name people never see
(`notes.guide.adding`); it is never taken from the path, so a file can move or be renamed and the hub keeps updating the
same record with its links, stats and embeddings.

```md
---
key: guide
title: Notes guide
description: Where to start with notes.
summary: The index of the notes guide; pick the part you need.
choices:
  - to: notes/guide.adding
    when: You are adding or editing a note.
---
Notes are plain markdown. Use fn:notes/add to add one, or read [adding notes](context:notes/guide.adding).
```

`harness system build` checks the folder and fails with `file:line:col` problems on a header that doesn't match, a
duplicate key, a link to a fn or context that doesn't exist (in the header, and `context:` / `fn:` references in the
body), a context that imports itself in a cycle, and a missing summary. `serve` sends the files as the system's context;
with `HARNESS_CONTEXT_WATCH=true` (development) it watches the folder and sends each saved change to the hub. Keep each
item to one idea with a short summary, start with a shallow index whose `choices` are worded as decisions, and let a
small model walk the graph a step at a time instead of reading one long list.
