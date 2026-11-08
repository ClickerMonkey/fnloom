A **hook** adds information to each user message before the LLM sees it (the git branch, the pinned notes, the open
ticket). Declare it with `hook({ description, order?, timeout? })`: lower `order` runs first (default 100), and after
`timeout` ms (default 1000) the message goes on without it, so keep hooks fast.

The server implements it as `async (input, ctx) => contributions`. `input` is the message (`HookInput`: session, turn,
text, user, time); each contribution is one of:

- `{ type: 'text', tag, text }`: a tagged block the LLM can tell apart from the person's words;
- `{ type: 'suggest-context', items: [{ context, why? }] }` and `{ type: 'suggest-fns', items: [{ fn, why? }] }`:
  suggestions, by ref;
- `{ type: 'load', context?, fns? }`: load these now.

Return `[]` when there is nothing to add.

<!-- include: scripts/docs/example/shared/index.ts#hook -->

<!-- include: scripts/docs/example/server/impl.ts#impl-hook -->
