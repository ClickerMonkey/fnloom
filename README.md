# harness

A web-based agent harness: one **hub** that owns every LLM call, user, permission and record, and **systems**
that connect over WebSocket to add fns, kinds, types, resources, context and UI renderers.

Status: **building the first milestone.** The shared contracts (`@harness/core`), the SDK's contract builders and
the hub's module interfaces are in place; the lanes are implementing the modules.

- [`docs/harness.md`](docs/harness.md): the design in plain language.
- [`docs/architecture.md`](docs/architecture.md): the code layout, module interfaces, lane ownership and dev workflow.
- `types/`: the approved type design, kept as the design record. `explorer/explorer.html` (`npm run explorer`) lets
  you read the guide and click through every type, with notes (**Export notes** saves them for `review/notes.json`).

```sh
npm install
npm run typecheck   # every project: core, sdk (+ compile-time examples), hub, web, systems, types
npm test            # unit + web tests (no network)
npm run test:live   # live tests: OpenRouter (OPENROUTER_API_KEY, free model)
npm run lint
npm run dev         # hub :4300, web :4310, fs and embedder systems, LAN-bound; data in .harness/
npm run check       # everything above that runs offline, plus the explorer
```

The @aeye and @ayepi packages are linked from local checkouts on their `harness` branches
(`file:../aits/packages/*`, `file:../ayepi/packages/*`), so clone [aits](https://github.com/ClickerMonkey/aeye) and
[ayepi](https://github.com/ClickerMonkey/ayepi) next to this repo and build them first.
