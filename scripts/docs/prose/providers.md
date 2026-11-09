A system can bring **model providers**: models whose calls run in the system (a GPU box, a private API, a gateway the
hub can't reach). Declare each in the contract with `provider({ description, models })`: every model's id, abilities
(aeye capability names such as `chat`, `tools`, `vision`, `embedding`), context window, prices in USD per million
tokens, and whether it reads a prompt cache. The implementation gives a function that makes the aeye `Provider` for the
current config (made again when the config changes).

```ts
// shared/
.with({ providers: { local: provider({ description: 'Models on our GPU box.', models: [
  { id: 'small', capabilities: ['chat', 'tools', 'streaming'], contextWindow: 32_768, pricing: { input: 0, output: 0 }, caching: false },
] }) } })
// server/
serve(contract, { providers: { local: (ctx) => new OpenAIProvider({ apiKey: ctx.config.key, baseURL: ctx.config.url }) } }, options);
```

While the system is connected the hub registers each provider as `<system>/<provider>` (here `gpu/local`), so its models
can be picked like any other; chat calls stream over the link and embeddings are answered by the provider's `embed`. A
call for a model the contract doesn't declare is refused. The hub prices and records every call from the declared
prices, as it does for its own providers.
