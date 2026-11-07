# harness

A web-based agent harness: one **hub** that owns every LLM call, user, permission and record, and **stations**
that connect over WebSocket to add fns, kinds, types, resources, context and UI renderers.

Status: **design review**. Nothing is implemented yet.

- [`docs/harness.md`](docs/harness.md): the design in plain language.
- [`types/sdk.ts`](types/sdk.ts): the station SDK, everything a station author touches. Review this most closely.
- [`types/fs.ts`](types/fs.ts): the first station's contract, written with the SDK.
- [`types/hub.ts`](types/hub.ts): the hub's side: wire format, records, permissions, queues, chat, storage.
- [`types/examples.ts`](types/examples.ts): the fs station's server against the SDK, plus every mistake the types must refuse.
- `explorer/explorer.html`: open it in a browser to read the guide and click through every type, with notes
  on any section, type or member. Notes stay in your browser; **Export notes** saves them as JSON for
  `review/notes.json`.

```sh
npm install
npm run typecheck   # tsc over types/
npm run explorer    # rebuilds explorer/explorer.html (fails if the types don't compile)
```

Built on [`@aeye`](https://github.com/ClickerMonkey/aeye) and [`@ayepi`](https://github.com/ClickerMonkey/ayepi).
