# Build 2: the request and the decisions

> After this workflow is done here's the next workflow to kick off and operate in the same way:
>
> Create template system with docs with all types needed (dynamically build these docs with typescript compiler or whatever so as we change stuff it's a script to rebuild it. It should be so complete an llm to generate a system should only need to read that. And also fs system has this context that chat can see to have it create systems itself). Template system shouldn't have example code in it, just placeholder comments and stuff.
>
> Make sure there's a way in UI to specify which models and providers should be used for transcription and dictation
>
> Chat should have two modes for me to experiment with. One with static toolset to reason about the system and execute fns. The result of fns could expose a little or fully a fn to the agent. If the static toolset is used at the end of whatever loaded the fn the llm sees the instructions, examples, signature, etc. and it has to use run command with name of fn and it's args. It's loosely goosey but more cost effective then strict fns and needing to auto remove lru or ask the llm to. Thats what I'm looking for! Kind of like a contextor I think I called it in product. Which let's pull into here to implement that and the context graph version of a contextor where the full convo is not sent but a series of weights determine which context and fns it's aware of and each message starts a new prompt with the relevant session history rebuilt but all the other possibly related context built in the system prompt. This method is designed for local models especially with small context limits which is what this should Be aware of and output max tokens and this needs to make sure it's not going to include too much in request to cause an issue for small models.
>
> Does context store links to other context or fns? Context can be skills or memory or from a resource or injected into an llm kind of a certain name, might be loadable with /command syntax, can pull in fns for llm to use.
>
> Make sure the ability to convert a resource to context is there. Also some formats like html should have markdown version... Aeye resources should do that? In hub db we should have it so resource raw data is stored in fs of hub or optionally in database. Then converted data for llm which could be markdown or for Excel could be structured tabular data. Each of these versions could be displayed for a resource if both exist. And slicing/sectioning or contexting whatever takes the parsed format by default to create pieces of context.
>
> Add web system with tavily for search and then can take a http and pull it down and it looks like html use puppeteer to render it to then extract the html etc. aeye/resources might do some of this and should handle it converting data from http servers to resources
>
> Resource view should have different ways to look at resources to group and folder them up automatically vs just the plain list or thumbnail views.
>
> Make sure viewing files and hub supports all the common resource types out of the bat so I can see images, syntax highlighting of code/markdown/mermaid - but also a preview mode for certain types.
>
> Maybe pairing from system can print out QR code in system if you specify hub URL it will generate something you can scan and it opens hub and you specify config and the finish pairing
>
> Let's create fn sets which is a rule set to determine what things should be exposed for a custom mcp. As in we create a Claude system... It manages creating and running Claude sessions but we want to give Claude sessions over there an mcp they can use to talk with hub. Control should be in hub - it could expose different mcp routes and have private auth info for each. I want it to work so we have control of what systems, fns, types, context, etc are included/excluded. Maybe fn set is not a good name, let's just call it hub mcps or something and an admin can create them
>
> How do we want to handle each system storing its own data if it wants to? Just leave it up to them? How portable is that? Should each system have a folder in a particular format for server, client, data, config, etc? And that's what can be zipped up and installed? What about commands for building and zipping up system to install it to run alongside hub?
>
> Does the system differentiate between llm tool call mistake (bad json, schema, or fails validation) so we can communicate the status of the tool call differently to the front end. Tool error is a real error, bad input is something the llm can retry and is often expected
>
> Make sure multiple fs instances can attach so if I want a fleet of them I can
>
> Make sure gin type system has type editor/viewer, expr editor/viewer, and type value editor/viewer. The same component can be editor and viewer depending on flag passed in. Systems can add types and custom components to render them as
>
> Since hub is provider and has llm types - let's make sure ALL calls from systems are tracked in that database. Ideally all llm calls use that kind, nothing through chat. But the non chat aeye calls for images or embeddings or audio etc. some amount of detail is captured in the hub because some of it has performance implications. Maybe a special fn kind or something?
>
> Can systems add resource components to front end?
>
> Fn metrics - all that stuff make it's way over?
>
> System can add type editor and inputs to UI
>
> Hub fns for resources and context and other fns etc - the systems can call those fns and the chat llm has them. The chat llm basically needs the ability through fns to do everything in the system and look at everything.

## Answers given (my recommendations; build to these, record them in docs/harness.md "Decided")

- **Context links:** yes. Context is a graph: a context item links to other context, fns, types and resources with weighted edges. Sources: skill, memory, resource-derived, injected into an llm kind by name, loadable by `/name`, and it can bring fns with it. The graph contextor walks these edges.
- **System data and packaging:** a standard system folder: `system.json` (name, version, entry points), `server/`, `client/`, and nothing else shipped. The hub gives each installed system its own data folder (`ctx.dataDir`, outside the package so upgrades keep it). Config lives in the hub DB, not a file. CLI: `harness system new|build|pack|install|export-data`. `pack` makes a zip of manifest+built server+client; the hub installs zips and runs them alongside itself.
- **Bad input vs error:** yes, distinct statuses. `invalid-input` (bad JSON, schema mismatch, failed validation) is retryable, shown softly in the chat as "retried", and fed back to the LLM; `error` is a real failure.
- **Non-chat model calls:** not a fn kind (fns are what agents choose to run). Every model call a system makes through the hub provider, of any modality (chat, embed, image, transcribe, speech), is a `ModelCall` record with modality, model, provider, tokens/units, cost, latency, size, attributed to the run that made it. Chat LLM calls are the same records. Nothing bypasses the hub.
- **Systems adding resource views, type editors and inputs:** yes, through `client()` renderers; build/verify all three.
- **Fn metrics:** every run records duration, queue wait, cost, tokens, outcome (done/invalid-input/error/cancelled), retries; per-fn rollups are shown in admin and to the LLM where useful.
- **Name:** "fn sets" become **hub MCPs**: admin-created MCP endpoints, each with its own route, its own secret, and include/exclude rules over systems, fns, types, context and resources.

## Prior art in product to read

- product/design/contextor.md, product/requirements/07-context.md, product/packages/server/src/ai/contextor.ts, product/packages/sdk/src/context.ts (Plain/Suggest/Graph contextors, scoring, weights)
- product/design/claude-code-system.md, product/design/mcp-system.md, product/design/system-packages.md, product/design/resources.md, product/design/chat-ux.md

## Environment facts (checked 2026-11-07)

- TAVILY_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY are set (never print values).
- Ollama is listening on :11434 — use a small local model there to prove the graph contextor and the small-context budgeting (`curl localhost:11434/api/tags` to see which).
- Embedder (EmbeddingGemma) on :8760.
- Local model available: deepseek-r1:7b (7.6B, a reasoning model; may not support native tool calls, which suits the static-toolset 'run' command mode). Pull a small tool-capable model (e.g. qwen2.5:3b / llama3.2:3b) if needed.

## Carried over from build 1 (its final open issues)

- Auto-load fns the user names explicitly in a message (for example `fs/bash`) into the turn's tools, so small/free models don't answer without the tool.
- After a reconnect, retry the catch-up calls automatically so a missed run shows without a reload.
- Mock-hub fixtures (mockChat, mockHub: Session, Run, Notification…) must be compile-time checked against their schemas (`satisfies z.input<…>`), not loose objects.
- The mock hub logs status=500 for /signIn calls that answer 200/401.
- Library asks still open: ayepi binary ws frames, ayepi web push (hub uses web-push directly), an aeye resources folder resolver.
