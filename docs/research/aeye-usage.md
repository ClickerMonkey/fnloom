# How harness uses aeye

Research for the hub's LLM layer, the agent loop, the forwarding provider and embeddings. Every signature
below is copied from the linked checkout (`C:\Users\pdiff\Documents\GitHub\aits`, branch `harness`):
`packages/core/src/{prompt,tool,types,common,errors}.ts` and `packages/ai/src/{ai,types}.ts` +
`apis/{base,chat,schema-fallback}.ts`. Line numbers are as of 2026-11-07.

Contents:

1. Packages and the one `AI` on the hub
2. Hooks: budget reservation and interaction saving
3. The agent loop: a `Prompt` whose tools come from fn signatures
4. Suspend and resume, exactly
5. Streaming events to relay to the UI
6. Structured output
7. The forwarding provider (systems → hub)
8. Embeddings
9. Free OpenRouter models for the live tests
10. Library asks and spec notes found while reading

---

## 1. Packages and the one `AI` on the hub

| Package | Used for | In harness `package.json` today |
|---|---|---|
| `@aeye/core` | `Prompt`, `Tool`, `PromptSuspend`, `Message`/`Request`/`Chunk`/`Usage`, `toJSONSchema`, errors | yes |
| `@aeye/ai` | `AI`, hooks, `ModelRegistry`, `Provider` interface, chat/embed APIs | yes |
| `@aeye/models` | static `models: ModelInfo[]` + `strictSupport: ModelOverride[]` | yes |
| `@aeye/openrouter` | `OpenRouterProvider`, `OpenRouterModelSource` | **no: needs adding** (`file:../aits/packages/openrouter`; it pulls in `@aeye/openai` + `openai` v7) |
| `@aeye/gin` | fn/type signatures → zod (`toValueSchema`) | yes |

zod: harness is on 4.6.7, aits still on 4.1.12 (`aits/node_modules/zod`). The library-prep lane moves aits to
the latest; until then aeye's `ZodType` and harness's `ZodType` are different nominal types.

### Building it

```ts
// packages/ai/src/ai.ts:173
public static with<TContext extends AIContextUser = {}, TMetadata extends AIMetadataUser = {}>() {
  return { providers: <TProviders extends Providers>(providers: TProviders) => ({
    create: <TConfig extends Omit<AIConfig<TContext, TMetadata, TProviders>, 'providers'>>(config?: TConfig) =>
      new AI<AITypesInfer<TContext, TMetadata, TProviders, TConfig>>({ providers, ...config }),
  }) };
}
withHooks(hooks: AIHooks<T>): this;          // ai.ts:282 — REPLACES hooks, one call only
```

```ts
// packages/openrouter/src/openrouter.ts:30
export interface OpenRouterConfig extends Omit<OpenAIConfig, 'api'> {
  defaultParams?: {
    siteUrl?: string; appName?: string;
    providers?: { order?: string[]; allowFallbacks?: boolean; requireParameters?: boolean; dataCollection?: ...;
                  zdr?: boolean; only?: string[]; ignore?: string[]; sort?: ...; maxPrice?: ...; /* … */ };
    fallbackModels?: string[];   // OpenRouter `models` fallback list
    plugins?: OpenRouterPlugin[];
  };
}
```

Harness shape (one module owns it, `hub/llm/ai.ts` or as the architecture map names it):

```ts
import { AI } from '@aeye/ai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { models, strictSupport } from '@aeye/models';

/** Per-call scope the hub threads through every aeye call: who pays, where it is saved. */
export interface HubAiContext { call: LlmCallScope }   // a class; see section 2
export interface HubAiMetadata { /* empty for now; ModelChoice is mapped onto aeye metadata */ }

export function createHubAi(providers: ProviderSet, hooks: HubAiHooks) {
  return AI.with<HubAiContext, HubAiMetadata>()
    .providers(providers.instances())          // { openrouter: new OpenRouterProvider({ apiKey, defaultParams: { appName: 'harness' } }) }
    .create({ models, modelOverrides: [...strictSupport] })
    .withHooks(hooks.toAeye());
}
```

- Provider instances come from `ProviderConfig` rows (`types/hub.ts:876`); the key (`openrouter`) is the aeye
  provider id and the prefix in `provider/model` ids. Keys are secrets resolved at build time, never env reads in
  feature code (the env slice only holds the bootstrap key for the default admin setup and live tests).
- `@aeye/models` already contains the current free OpenRouter models (e.g.
  `nvidia/nemotron-3.5-super-vl:free` at `models/src/models/openrouter.ts:10632`, `pricing: { text: {} }`,
  capabilities incl. `tools`, `structured`, `streaming`). For live data use
  `modelSources: [new OpenRouterModelSource({ apiKey })]` + `await ai.models.refresh()` (refresh clears and
  refetches; `config.models` survive because they're registered as the `'config'` source).
- **`ModelChoice` → aeye metadata** (`types/sdk.ts:650`): `{ model }` → `metadata.model`; `{ auto: {cost,speed,accuracy} }`
  → `metadata.weights`; `{ category }` → the hub's category table → one of the two. Selection without a model needs
  registered models (it fails otherwise: "No compatible model found").
- Real cost: OpenRouter reports `usage.cost` (on stream usage chunks too); `BaseAPI.calculate*Cost` returns
  `usage.cost` when present (`apis/base.ts:469,488`), so the `cost` the hooks receive is the billed amount.

## 2. Hooks: budget reservation and interaction saving

```ts
// packages/ai/src/types.ts:1280
export interface AIHooks<T extends AIBaseTypes> {
  beforeModelSelection?: (ctx: AIContext<T>, request: BaseRequest, metadata: AIMetadata<T>) => Promise<AIMetadata<T>> | AIMetadata<T>;
  onModelSelected?: (ctx: AIContext<T>, request: BaseRequest, selected: SelectedModelFor<T>) => Promise<SelectedModelFor<T> | void> | SelectedModelFor<T> | void;
  beforeRequest?: (ctx: AIContext<T>, request: BaseRequest, selected: SelectedModelFor<T>, estimatedUsage: Usage, estimatedCost: number) => Promise<void> | void;
  afterRequest?: (ctx: AIContext<T>, request: BaseRequest, response: BaseResponse, responseComplete: boolean, selected: SelectedModelFor<T>, usage: Usage, cost: number) => Promise<void> | void;
  afterBatch?: (ctx: AIContext<T>, job: BatchJob, usage: Usage, cost: number) => Promise<void> | void;
  onError?: (errorType: string, message: string, error?: Error, ctx?: AIContext<T> | AIContextRequired<T>, request?: BaseRequest) => void;
}
```

What `BaseAPI` actually does (`apis/base.ts:136-290`), which decides the design:

- `ctx` passed to `beforeRequest` and `afterRequest` is the **same object** (`fullCtx`), built fresh per API call by
  `buildContext` (`{...defaultContext, ...provided, ...required, ai}`). One prompt iteration = one `chat.stream`
  call = one `fullCtx`. So a `WeakMap<object, Reservation>` keyed by `ctx` pairs a reservation with its settlement
  without any id threading.
- **`stream()`** runs `afterRequest` in a `finally` around the chunk loop: it fires on success
  (`responseComplete: true`), on abort and on a provider error mid-stream or before the first chunk
  (`responseComplete: false`, partial `usage`). Then `onError` fires for the error. → For streaming, **settle in
  `afterRequest` always**; `onError` only logs.
- **`get()`** calls `afterRequest` only on success; a provider error goes straight to `onError` with `fullCtx`. →
  For non-streaming calls, **release the reservation in `onError`** (look it up in the same WeakMap; it is absent
  when `beforeRequest` itself threw, e.g. over budget).
- `beforeRequest` throwing cancels the request (that's how "refused" works). "Wait for the window" happens
  *before* aeye, in the LLM queue (`@ayepi/work` priority doer + `@ayepi/rate` weighted hits), so the hook only
  ever reserves or refuses.
- `estimatedCost` is heuristic (char divisors, `ai.tokens`), so reserve `estimatedCost * margin` (risk 10:
  "reserve with a margin, settle exactly, allow a small overrun").
- `firstTokenAt` is not visible to hooks: take it from the first `textPartial`/`toolParseName`/`reasonPartial`
  prompt event after each `request` event (section 5).

```ts
/** The hub's aeye hooks. One class, injected with the budget ledger and the interaction store (seams for tests). */
export class HubAiHooks {
  private readonly reservations = new WeakMap<object, Reservation>();
  constructor(private readonly budgets: BudgetLedger, private readonly interactions: InteractionStore, private readonly log: Log) {}
  toAeye(): AIHooks<HubTypes> {
    return {
      beforeRequest: async (ctx, request, selected, _usage, estimatedCost) => {
        this.reservations.set(ctx, await this.budgets.reserve(ctx.call, estimatedCost));   // throws BudgetRefused
        await this.interactions.open(ctx.call, wireRequest(request), selected.model);       // status 'streaming'
      },
      afterRequest: async (ctx, _request, response, complete, selected, usage, cost) => {
        await this.budgets.settle(this.take(ctx), cost);
        await this.interactions.close(ctx.call, { response, usage, cost, status: complete ? 'done' : ctx.call.aborted ? 'aborted' : 'failed' });
      },
      onError: (type, message, error, ctx) => { /* log; if ctx has an unsettled reservation (get() path) release it */ },
    };
  }
}
```

`request` arrives as `BaseRequest`; for chat it is the core `Request` (zod in `tools[].parameters` and
`responseFormat.type`), so saving it needs the same zod → JSON schema conversion as the forwarder (section 7).
One function, `wireRequest(request: Request): WireRequest`, serves both `LlmInteraction.request` and
`LlmForward.request`.

Message content can hold `Buffer`/`Blob`/`URL` (`Resource`, `core/src/types.ts:368`). Stored transcripts hold
content refs; the hub resolves them to `URL`/`Uint8Array` when building `ctx.messages`, and `wireRequest`
replaces binary parts with their ref when saving.

## 3. The agent loop: a `Prompt` whose tools come from fn signatures

### The pieces of `PromptInput` harness uses (`core/src/prompt.ts:110-389`)

```ts
export interface PromptInput<TContext = {}, TMetadata = {}, TName extends string = string, TInput extends object = {},
  TOutput extends object | string = string, TTools extends Tuple<ToolCompatible<TContext, TMetadata>> = [], TDecoded extends unknown = TOutput> {
  name: TName;
  description: string;
  content: string;                       // Handlebars → the system message; `{{tools}}` auto-appended in <tools> when tools exist
  input?: Fn<Record<string, any>, [TInput | undefined, Context<TContext, TMetadata>]>;
  schema?: Fn<ZodType<TOutput> | false, [TInput | undefined, Context<TContext, TMetadata>]>;
  strict?: boolean | number;             // default 1 (prefer strict)
  config?: Fn<Partial<Request> | false, [TInput | undefined, Context<TContext, TMetadata>]>;
  retool?: Fn<RetoolResult<TContext, TMetadata, TTools>, [TInput | undefined, Context<TContext, TMetadata>]>;
  toolExecution?: 'sequential' | 'parallel' | 'immediate';   // default 'immediate'
  toolRetries?: number;      // default ctx.toolRetries ?? 2
  outputRetries?: number;    // default ctx.outputRetries ?? 2
  forgetRetries?: number;    // default ctx.forgetRetries ?? 1
  toolIterations?: number;   // default 3
  toolsComplete?: boolean;   // default true (never pairs suspended calls)
  onToolIntercept?: (tool: PromptTools<TTools>, args: unknown, ctx: Context<TContext, TMetadata>) => unknown | false | Promise<unknown | false>;
  // … onToolResult, reconfig, dynamic, parse, validate, review, userTurn, schemaDelivery, schemaFallbacks
}
export type RetoolResult<TContext, TMetadata, TTools extends Tuple<ToolCompatible<TContext, TMetadata>>> =
  | (Names<TTools> | ToolCompatible<TContext, TMetadata>)[] | false;
export class PromptSuspend extends Error { constructor(message: string = 'Prompt execution suspended') }   // tool.ts:226
```

`ai.prompt(options)` (`ai.ts:747`) wraps every callback (`input`, `schema`, `config`, `retool`,
`onToolIntercept`, …) so it receives the full `AIContext` (with `ctx.call`), and wraps `stream` to inject
`execute`/`stream`/`estimateUsage` via `buildCoreContext`.

### Tools from fn signatures

The toolset changes per session and per iteration (`Session.tools`, `canLoad`), so tools are **not** a
compile-time tuple: the agent prompt has `tools: []` and returns tool objects from `retool`, re-resolved on each
job (each job is a fresh `prompt.get`, so `dynamic` isn't needed).

```ts
// core/src/tool.ts:59 (fields used)
export interface ToolInput<TContext, TMetadata, TName extends string, TParams extends object, TOutput, TRefs extends Tuple<…>, TDecoded = TParams> {
  name: TName;
  description: string;
  instructions?: string;
  schema: Fn<ZodType<TParams> | undefined, [Context<TContext, TMetadata>]>;
  strict?: boolean | number;
  call: (input: TDecoded, refs: TRefs, ctx: Context<TContext, TMetadata>) => TOutput;
  parse?: (raw: unknown, ctx: Context<TContext, TMetadata>) => TDecoded | Error | Promise<TDecoded | Error>;
  maxArgsLength?: number;
}
```

One class, `FnTool`, built from a stored `FnSignature`:

- `name`: tool names can't contain `/`; map `fs/read` ↔ `fs__read` in one place (`ToolName.encode/decode`).
- `schema`: gin `type.toValueSchema({ includeDocs: 'all' })` of the args object type. That is gin's JSON "dump"
  form (dates are ISO strings, `types/date.ts:154`), which is what the model must write.
- `parse`: gin's value parse of the raw object → the plain JS value fns receive (dates as `Date`). `Tool.parse`
  applies `decodeWire(baseSchema, raw, descriptor)` *before* a custom `parse` (`tool.ts:380`), so gin never sees
  strict-mode wire quirks (nulls for optionals, pair arrays for records). A gin error is returned as an `Error`
  whose message is what the model sees (truncated to `validationErrorMaxLength`, default 4096).
- `call`: never reached in the hub loop (the interceptor suspends first), but it is the fallback if no
  interceptor is installed: it throws `PromptSuspend` too, so a tool can never run inline by mistake.

The per-fn zod is cached by signature hash: `toValueSchema` per call is waste, and the descriptor `strictify`
caches by schema identity.

### One job = one `prompt.get('stream', …)`

```ts
for await (const event of agentPrompt.get('stream', input, {
  call: scope,                       // HubAiContext
  messages: transcript,              // saved conversation WITHOUT the system message
  signal: scope.signal,              // cancel / new user message
  metadata: { model: … },            // from ModelChoice
})) relay.push(event);
```

- `toolExecution: 'parallel'` (or `'sequential'` from `LlmPayload.toolExecution`). **Never `'immediate'`**: it
  starts `run()` via `setImmediate` while the stream is still open (`prompt.ts:1089`), so a run could be recorded for
  a response that later fails.
- `onToolIntercept` records the call in the job's `PendingCalls` collector and throws `PromptSuspend`. Nothing is
  queued inside the interceptor; after the `suspend` event the hub writes the interaction, the assistant message
  and the runs in one store transaction, then queues the runs. (Throwing is the only way to stop a tool, and the
  thrown error is swallowed into `status: 'suspended'`, `prompt.ts:2191`, so its payload can't carry data out.)
- **Gap: the interceptor doesn't get the tool call id.** It is called as
  `(args) => onToolIntercept(toolInfo.tool, args, ctx)` (`prompt.ts:1077`) with the prompt ctx, while the tool's
  own `call` gets `{ ...ctx, toolCallId: toolCall.id }` (`prompt.ts:2170`). The run must know its `toolCallId` to
  write the `role: 'tool'` reply. Fix in aeye (library ask 1): pass the `ToolCall` as a 4th argument. Until then,
  suspend from `FnTool.call`, which has `ctx.toolCallId`; same effect, same collector.
- Per job the prompt makes one model request, plus in-process retries: invalid tool args (the error goes back as
  the `role: 'tool'` content and the loop calls again inside the same job), invalid structured output, a
  `length` finish with forget, a schema fallback. Each retry is its own `chat.stream` → its own reservation and
  `LlmInteraction` (same `iteration`).
- A batch with one invalid call runs **none** of its calls (`iterationMode = 'skip'`, `prompt.ts:1195`); the valid
  siblings get the synthesized `[aborted: tool call did not complete before the request was cancelled]`
  (`prompt.ts:1846`), which misleads the model (library ask 2). No interceptor runs, no runs are created.

## 4. Suspend and resume, exactly

From `Prompt.stream` (`prompt.ts:806-1660`):

**Building the request each run.** `systemMessage = { role: 'system', content }` where `content` is rendered now
from `content` + `input` + the tools `retool` returns now. Then
`request.messages = [systemMessage, ...ctx.messages]`, then a pre-emptive `forget`. With no `ctx.messages` it
adds the `userTurn` (`'Begin.'`). Consequences:

- **The system message is re-rendered on every resume.** Instructions, `{{tools}}` text, loaded context and
  anything time-dependent are current each job. Good for the design (tools loaded mid-turn appear next job), and
  it means the saved transcript **must not contain the system message**: `request.messages[0]` is the system
  message, so saving `request.messages` and passing it back would send two system messages, and `forget` keeps
  everything up to the first system message.
- **Every counter restarts per job.** `iterations`, `toolRetries`, `outputRetries`, `forgetRetries`,
  `toolIterations`, `reviewRetries`, `toolSuccesses`, `toolParseErrors`, `toolCallErrors`, the schema
  `fallbacksTaken` and the runtime prompt-delivery promotion are all locals of one `stream()` call. With a suspend
  on every call, `toolIterations` and `toolsMax` never bite and `reconfig` stats cover one job only. The hub owns
  the cross-job limits: `LlmPayload.maxIterations` (count jobs on the turn), consecutive tool-error rounds
  (count `role: 'tool'` messages with `failure` per job), and the schema step taken (store it on the run and
  pass it back through `config`, or accept re-discovery per job).
- **Where it stops.** After dispatch, every non-suspended call gets its `role: 'tool'` message; then
  `if (anySuspended) { suspended = true; break; }` (`prompt.ts:1298`). After the loop: `textComplete`,
  `responseTokens`, `usage` (accumulated for this job), then `{ type: 'suspend', request }` and `return undefined`.
  No `complete` event, no throw. `request.messages` ends with the assistant message (content + `toolCalls` +
  `reasoning`) and the replies of any calls that did not suspend.
- **Resume.** Append one `{ role: 'tool', content, toolCallId, failure? }` per suspended call, right after the
  assistant message and in `toolCalls` order, then run a new job with those messages as `ctx.messages`. Every
  `tool_call` id must be answered or the provider 400s; `toolsComplete` never fills suspended slots. A run moved to
  the background answers with a short marker (`Running in the background as run <id>; its result will be posted
  when it finishes.`), and its result arrives later as a hub message.
- **`content` serialization** matches aeye's: strings verbatim, everything else `JSON.stringify` (`prompt.ts:1272`),
  so a resumed run looks like an inline one. Use the fn's LLM rendering (`Audience` `'llm'`) when it has one.

**What to save.** Save the transcript by appending the `message` events of the job (assistant and tool messages,
in order) to the previous `ctx.messages`, **not** `request.messages`. `request.messages` is the possibly *trimmed*
list: `forget` replaces it pre-emptively and on `finishReason: 'length'` (`prompt.ts:870,1152`). Saving it would
make trimming permanent and lose history the UI and later, larger-context models still need.

**`forget` (`prompt.ts:1874`), exactly:**

- Runs only if a context window is known (`model.contextWindow ?? ctx.contextWindow ?? usage total`) and token
  counts exist: `message.tokens`, else `ctx.estimateUsage` (which `ai.prompt` always provides, and which
  **writes `msg.tokens` onto the message objects**, so the objects in `ctx.messages` come back mutated), else
  usage spread evenly.
- Budget: `contextWindow - (request.maxTokens ?? ctx.maxOutputTokens ?? 4096)`.
- It only drops messages strictly between the first system message and the **last user message**, oldest first,
  one message at a time. Everything after the last user message is never trimmed, so a long tool chain inside one
  turn can't be shortened. If that overflows and the model returns `length`, the job fails with a `PromptError`.
  The hub needs its own compaction for long turns (summarize old tool results in the saved transcript).
- It can cut between an assistant `toolCalls` message and its `role: 'tool'` replies, leaving orphaned tool
  messages that some providers reject (library ask 3).
- Per job only one `forgetRetries` (default 1).

**POC to keep honest (risk 2):** a real free model, three tools, suspend on every call, resume each job in a new
process from the saved transcript, and compare the final answer and message shapes with an uninterrupted run
that executes inline (`onToolIntercept` returning the result).

## 5. Streaming events to relay to the UI

`PromptEvent<TOutput, TTools>` (`prompt.ts:472`), every member carries `request`. What the hub does with each:

| Event | Payload | Relay |
|---|---|---|
| `request` | `iterations` | new model call started; open an LLM-call node in the fn tree; reset "first token" timer |
| `textPartial` | `content` (delta) | stream text into the agent's message. Refusal text also arrives here |
| `reasonPartial` | `reasoning` (**accumulated**, not a delta: `prompt.ts:1028`) | send the replaced reasoning, or diff by length |
| `reason` | full `reasoning` | final reasoning for the call |
| `textReset` | `reason?`, `error?: OutputValidationError` | **clear the streamed text** of this call (retry after length or bad output) |
| `toolParseName` | `tool` | show a pending tool chip as soon as the name is known |
| `toolParseArguments` | `args` (**cumulative** raw JSON string, `openai.ts:1369`) | live args preview, throttled |
| `toolArgRepairAttempt` | `fields`, `success` | debug detail on the call |
| `toolStart` | `tool`, `args` | not reached when the interceptor suspends (start is armed on parse; it is emitted, then the suspend) |
| `toolSuspend` | `tool`, `args` | the call became a run; the run's own events take over |
| `toolError` | `error`, `failure` (`ToolInputError` model / `ToolExecutionError` tool), `rawArgs?` | mark the call failed; the model sees the same text |
| `toolOutput`/`toolInterrupt` | | only for inline tools (none in the hub loop) |
| `message` | `message` | append to the saved transcript (section 4) |
| `refusal` | `content` | show as a refusal |
| `citations`, `images`, `audioPartial`, `moderation` | | attach to the message |
| `schemaFallback` | `fallback`, `error` | note on the LLM call (debug) |
| `reviewStart/Pass/Feedback` | | not used by the agent prompt |
| `requestUsage`, `responseTokens`, `usage` | `usage` | live token/cost meter; `usage` is the job total |
| `complete` | `output` | turn's final answer (no tool calls) |
| `suspend` | | persist, queue the runs, the turn shows "running tools" |

Text events use a typed `ChatEvent` union (zod first) sent over ayepi events; the browser never sees aeye types.
Throttle partials (e.g. 50 ms batches) at the relay, not in components.

## 6. Structured output

- `schema` (zod, non-`ZodString`) + `strict` (default `1`) + `schemaDelivery` (default `'auto'`). Providers pick a
  `FormatDescriptor` per model and write its id to `request.responseFormat.descriptor` (`openai.ts:948`); the
  prompt strictifies/decodes with it. `'auto'` drops a schema the model's dialect can't express to prompt text and,
  at runtime, falls back once on empty output or a provider 400 (`runtimeSchemaFallback`).
- `strict: true` is a hard selection filter (`toolsStrict`/`structured`), numeric is a preference.
- For gin output types (`Llm.object<T>` in `types/sdk.ts:659`): `schema: type.toValueSchema()` and
  `parse: raw => gin parse` (receives the wire-decoded value, returns `T` or an `Error` routed through
  `outputRetries`). The result is `TDecoded = T`.
- OpenRouter adds `requireParameters` automatically for strict `json_schema` so strict requests only route to
  upstreams that honour it. A free model that doesn't list `response_format` (e.g. `cohere/north-mini-code:free`)
  returned prose for a strict schema in the probe (section 9): don't pick those for structured output.

## 7. The forwarding provider (systems → hub)

Systems never call providers. A system's `ctx.llm` (`types/sdk.ts:656`) and any aeye prompt a system author
writes run on a system-side `AI` whose only provider forwards to the hub over the link
(`HubLink.llm(input: LlmForward): AsyncIterable<LlmForwardChunk>`, `types/hub.ts:199`).

The interface to implement (`packages/ai/src/types.ts:1136`):

```ts
export interface Provider<TConfig = any> {
  name: string;
  config: TConfig;
  priority?: number;
  defaultMetadata?: Partial<AIBaseMetadata<any>>;
  listModels?(config?: TConfig): Promise<ModelInfo[]>;
  checkHealth(config?: TConfig): Promise<boolean>;
  createExecutor?(config?: TConfig): Executor<AIContextAny, AIMetadataAny>;
  createStreamer?(config?: TConfig): Streamer<AIContextAny, AIMetadataAny>;
  embed?(request: EmbeddingRequest, ctx: AIContextAny, config?: TConfig): Promise<EmbeddingResponse>;
  // image/speech/transcribe/rerank/decide/batch …: not offered by the hub provider yet
}
// core/src/types.ts:229,245
export type Executor<TContext, TMetadata> = <TRuntimeContext extends TContext, TRuntimeMetadata extends TMetadata>(request: Request, context: TRuntimeContext, metadata?: TRuntimeMetadata, signal?: AbortSignal) => Promise<Response>;
export type Streamer<TContext, TMetadata> = <TRuntimeContext extends TContext, TRuntimeMetadata extends TMetadata>(request: Request, context: TRuntimeContext, metadata?: TRuntimeMetadata, signal?: AbortSignal) => AsyncGenerator<Chunk, Response>;
```

`class HubProvider implements Provider<HubProviderConfig>` (in the SDK):

1. **Models.** `listModels` returns one pseudo model, `hub/auto`, `pricing: {}`, a huge `contextWindow`, and
   every chat capability (`chat`, `tools`, `toolsStrict`, `structured`, `json`, `streaming`, `vision`,
   `reasoning`), so the system-side registry never filters; the hub does the real selection from the forwarded
   `ModelChoice`. (Check in the POC that an explicit `toolsStrict` capability survives registry derivation.)
2. **Request out.** `wireRequest(request)` (shared with interaction saving): each `ToolDefinition` →
   `{ name, description, parameters: z.toJSONSchema(parameters, { io: 'input', unrepresentable: 'throw' }), strict }`,
   `responseFormat` object → `{ schema, strict }`. Plain zod JSON schema, **not** aeye's strictified dialect: the
   hub strictifies for the model it picks. `unrepresentable: 'throw'` fails at build/registration for schemas with
   transforms, which wouldn't survive the round trip.
3. **Hub side.** Rebuild with `z.fromJSONSchema(json)` (zod 4.6), build `ToolDefinition`s and `ResponseFormat`,
   run `ai.chat.stream(request, { call: scopeFor(system, run) })`, so the same hooks reserve, settle and save the
   `LlmInteraction` (with `system` set). Send `{ type: 'descriptors', tools: { name: descriptorId }, output? }`
   **before the first chunk** (descriptors are set while the provider builds the request), then
   `{ type: 'chunk' }`s, then `{ type: 'done', usage, cost, interaction }`, or `{ type: 'error', kind }`.
4. **Chunks in.** On `descriptors`, write the ids into the system's own `request.tools[i].descriptor` and
   `request.responseFormat.descriptor` (the prompt holds that same `request` object), so `Tool.parse` and the
   output validator decode the strict wire shape with the **original** zod schema. Yield chunks as they come; on
   `done`, yield a final `{ usage: { ...usage, cost } }` chunk so system-side usage events carry the real cost.
   Abort: the `signal` cancels the ayepi call; the hub aborts its stream and settles partial cost.
5. `createExecutor` is the streamer collected with `getResponseFromChunks(chunks, model)` (`core/src/common.ts:343`).
6. `embed` → `HubLink.embed`.

Spec notes for `LlmForward` (`types/hub.ts:284`): `tools[]` has no `strict` and `responseFormat.strict` is
`boolean`, but aeye's policy is `boolean | number` (the number is the strict-slot priority). Use
`strict: boolean | number` in both. `LlmForward.request` and `LlmInteraction.request` are two hand-written
variants of one wire shape: define one zod `WireRequest` schema and derive both.

POC (risk 4): a system-side prompt with one tool and a structured output, through `HubProvider`, against a
strict-capable model, checking the descriptors land and the decoded args/output equal an in-process run.

## 8. Embeddings

aeye's embed API (`ai/src/types.ts:800`):

```ts
export interface EmbeddingRequest extends BaseRequest { texts: string[]; dimensions?: number; encodingFormat?: 'float' | 'base64'; userIdentifier?: string }
export interface EmbeddingResponse extends BaseResponse { embeddings: Array<{ embedding: number[]; index: number }> }
// ai.embed.get(request, ctx) — no stream()
```

EmbeddingGemma needs a **task** (`query` vs `document`; the service applies the prefix), which aeye's request
can't express except through untyped `extra`. So embeddings sit behind a harness interface, not aeye:

```ts
export type EmbedTask = 'query' | 'document';
export interface Embedder {
  readonly name: QualifiedName; readonly dimensions: number; readonly maxInput: number;
  embed(texts: readonly string[], task: EmbedTask, signal?: AbortSignal): Promise<{ vectors: number[][]; cost: Usd }>;
}
// SystemEmbedder  → SystemLink.embed (types/hub.ts:231)
// ProviderEmbedder → ai.embed.get({ texts, model }) for provider embedding models (task ignored)
```

The `embedder` system wraps product's service (`product/services/embedder/README.md` §5), checked live today:

- `GET /info` → `dim: 768`, `max_batch: 256`, `max_input_tokens: { query: 2034, document: 2035, code: 2034, raw: 2042 }`,
  `tasks: ["query","document","code","raw"]`, `device: "cuda"`, `max_concurrency: 2`, `max_queue: 64`.
- `POST /embed { texts, task, normalize: true, truncate: true }` → `{ embeddings: number[][], dim, model, task,
  truncated_count, trimmed: [{ truncated, tokens_trimmed, chars_trimmed, … }] }`. Errors 400 (empty), 413 (batch
  over `max_batch`), 503 (loading), 429 + `Retry-After` past capacity.
- The system batches to `max_batch`, retries 429 after `Retry-After`, validates responses with a zod schema, logs
  trims, and declares `EmbedderDef { dimensions: 768, maxInput: 2035, price: 0 }`. URL and retry tunables live in
  its env slice.
- Index documents with `document`, queries (suggestions, `get_fn`, `@` search) with `query`.

Spec note: `EmbedderImpl = (texts: string[]) => Promise<number[][]>` (`types/sdk.ts:1140`), `SystemLink.embed`
and `Llm.embed` have no task, so the hub can't ask for query embeddings. Add `task: EmbedTask` there.

## 9. Free OpenRouter models for the live tests

`GET https://openrouter.ai/api/v1/models` (2026-11-07): 445 models, **12** with an id ending `:free` that list
`tools` in `supported_parameters`. Each was probed once with one tool, then the top ones with a tool-result
follow-up and a strict `json_schema` response (max 600 tokens):

| Rank | Model | Context / max out | Params | Tool call | After tool result | Strict JSON | Notes |
|---|---|---|---|---|---|---|---|
| 1 | `nvidia/nemotron-3.5-super-vl:free` | 1M / 131k | tools, tool_choice, structured_outputs, response_format, reasoning | ✓ 1.2 s (first try a network failure) | ✓ 8.7 s | ✓ | 120B MoE (12B active), vision, newest; in `@aeye/models` |
| 2 | `nvidia/nemotron-3-ultra-550b-a55b:free` | 1M / 65k | tools, tool_choice, reasoning | ✓ 7.6 s | ✓ 0.8 s | ✓ (but `response_format` not listed, so aeye won't pick it for structured) | strongest reasoner; agent-orchestration model |
| 3 | `dots-studio/dots-3-note-preview:free` | 512k / 460k | tools, tool_choice, structured_outputs, response_format | ✓ 3.7 s | ✓ 1.7 s | ✓ | preview |
| 4 | `cohere/north-mini-code:free` | 256k / 64k | tools, tool_choice | ✓ 0.8 s | ✓ 0.6 s | ✗ prose | fastest; fine for tool-only tests |
| 5 | `nvidia/nemotron-3.5-lightning:free` | 1M / 65k | tools, tool_choice | ✓ 6.0 s | not probed | — | 3B active |
| 6 | `xingchen-agi/xing4.0-29b-a4b:free` | 262k / 236k | tools, tool_choice, structured_outputs | ✓ 6.0 s | 429 | 429 | rate-limited upstream |
| 7 | `google/gemma-4-31b-it:free`, `google/gemma-4-26b-a4b-it:free` | 262k / 33k | tools, tool_choice, response_format | 429 twice | | | rate-limited upstream |
| — | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256k | tools, tool_choice | not probed | | | perception sub-agent |
| — | `recursive/flint-v1.0:free` | 262k | tools (no tool_choice) | not probed | | | |
| — | `liquid/lfm-3-1.7b:free`, `liquid/lfm-2.5-2.6b:free` | 262k / 66k | tools, structured | not probed | | | too small for an agent loop |

Also zero-priced without the suffix: `openrouter/free` (a router to some free model; tool call ✓ 2.4 s) and
`stealth/crouton-alpha`. Avoid both for tests: the model behind them isn't fixed.

**Recommendation:** `nvidia/nemotron-3.5-super-vl:free` for the agent-loop and structured-output live tests,
with `nvidia/nemotron-3-ultra-550b-a55b:free` then `dots-studio/dots-3-note-preview:free` as fallbacks
(`OpenRouterConfig.defaultParams.fallbackModels`, test provider only). Keep the id in the live-test env slice,
not in test code. Free models are rate-limited per key and upstream (429s seen above), so live tests make one or
two calls each, retry once after a 429 and then skip with a clear reason rather than fail.

## 10. Library asks and spec notes found while reading

aeye (for the aeye lane):

1. **`onToolIntercept` gets no tool call id** (`prompt.ts:1077`). Pass the `ToolCall` (4th argument), and add
   `toolCallId` to the `toolStart/toolSuspend/toolError/toolOutput` events. Interim: suspend from `Tool.call`
   using `ctx.toolCallId`.
2. **Skipped siblings get an "aborted" marker.** When one call in a batch has invalid args, valid siblings get
   `[aborted: … cancelled]` (`prompt.ts:1846`); give them `[not run: another call in this batch had invalid
   arguments; call it again]`.
3. **`forget` can split a tool-call message from its replies** and can't trim after the last user message.
   Trim whole assistant+tool groups; expose a hook for compaction.
4. **Counters and schema fallbacks reset per run.** A resume option (`ctx.resume?: { fallbacks, toolRetries }`)
   would let a suspended prompt continue with its state; not blocking.
5. `buildCoreContext` checks `ctx.executor && ctx.streamer` but sets `execute`/`stream` (`ai.ts:324`), so it
   always rebuilds them. Harmless, but a caller can't supply its own streamer through `ai.prompt`.
6. `reasonPartial` carries accumulated reasoning while `textPartial` carries deltas; document it or add a delta.
7. zod 4.1.12 in aits → latest (library prep).

Harness spec (`types/`):

- `LlmForward` strict fields should be `boolean | number`, and one `WireRequest` schema should back both
  `LlmForward.request` and `LlmInteraction.request`.
- `EmbedderImpl`, `SystemLink.embed`, `HubLink.embed` and `Llm.embed` need `task: 'query' | 'document'`.
- `package.json` needs `@aeye/openrouter` (`file:../aits/packages/openrouter`).
