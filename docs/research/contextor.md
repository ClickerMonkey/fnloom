# Chat modes and the context graph contextor

Research for build 2. It covers what product's contextor does, where harness's chat agent stands today, and a
concrete proposal for two things the owner asked for:

1. **Chat modes** as a pluggable interface: today's strict-tools mode, and a **static toolset** mode where a small
   fixed tool set lets the agent find, inspect and load fns and context and run any fn through one `run` tool by name
   and args, with loaded fns shown as text at the end of the prompt.
2. A **context graph contextor**: context items with weighted links to other context, fns, types and resources; each
   user message starts a fresh prompt where the relevant history is rebuilt and the likely-related context and fns are
   placed by weight; built for small local models, so it knows the model's context window and output limit and never
   sends more than fits.

Sources read: `product/design/contextor.md`, `product/requirements/07-context.md`,
`product/packages/server/src/ai/contextor.ts`, `product/packages/server/src/ai/content.ts`,
`product/packages/sdk/src/context.ts`; harness `packages/hub/src/execution/{agent,tools,models,ports}.ts`,
`chat/{enrich,turns}.ts`, `index/{suggester,index}.ts`, `boot/hub-fns.ts`, `sdk/src/hub.ts`, `core/src/manifest.ts`,
`core/src/records/{systems,chat,content}.ts`; aeye `core/src/prompt.ts` (`forget`), `ai/src/ai.ts`
(`estimateMessageUsage`), `ai/src/types.ts` (`ModelInfo`), `core/src/delivery.ts`, gin `aeye-gin-codegen.md`,
resources `aeye-resources*.md`; the local Ollama (`/api/tags`, `/api/show`).

---

## 1. What product built

### 1.1 The context model (07 §Type layers)

A product `ContextDef` is `name`, `description` (the preview an LLM sees before loading), optional `query` (the
embedded text, falling back to `description`), `content` (Handlebars, filled from `/command` args), `suggest` and
`visible` audiences, `command` + `commandArgs`, `question`, `inject` (agent fns whose system prompt always carries it),
`functions` (fns added to the fn-set on load: a "skill"), `suggestedFunctions` (offered, never auto-added), `weight`
(default 1), `pageWeights`, and three kinds of edge: `next` (a chain: long content in ordered pieces), `parent` (a
hierarchy) and `relations: {context, weight}[]` (plain weighted edges). Row-only state: `disabled`, `childCount`,
`outdated` (a source resource changed).

### 1.2 Scoring (`Context.score`, R-07-030)

```
score(c) = effectiveWeight(c, pages) × ( match(q, c) + scale × inChatBoost(c) )
effectiveWeight = ∏ pageWeights[p] over active pages that have an entry, else weight   (0 ⇒ excluded)
match           = cosine(embed(q), searchVec(c))  — lexical token overlap |q ∩ c| / |q| when no vector
inChatBoost     = Σ relation.weight (targets already in the chat) + 0.5 per parent/next already in the chat
```

`relativeContextScale ∈ [0,1]` blends the chat-derived part in. Disabled, outdated and zero-weight context score 0.

### 1.3 The three contextors

- **Plain** (default): nothing is injected; the agent pulls context with `get_context`. `load_context` is absent.
- **Suggest**: once per user message, embed the message, score the pool, take the top `topN` (5), and add
  `<suggested-context>` (name + description only) to the user message. Optional `autoInject` puts the best ones' full
  content into the system message up to `maxChars` / `maxItems`. Never suggest or inject the same item twice.
- **Graph** (experimental, shipped): messages and context are one stream of `Content`. Each candidate gets
  `Σ_m weight_m · rbf(f_m(c), target_m, k_m)` with `rbf(x, t, k) = exp(−k(x−t)²)` over 16 metrics (embedding,
  same source/author/target and their index distances, recency in hours/days/weeks/months/years, day of week, hour
  of day, authored weight, previously viewed). Defaults: embedding 1, source 1, recently 0.5 (k 0.05 per hour),
  previouslyViewed 0.5; the rest 0. Selection (`selectGraph`):
  1. the last `minRecentExchanges` exchanges are always in, free of the budget;
  2. greedy by score into `charThreshold` (characters);
  3. up to 8 rounds of graph pull: an unselected context connected to the selected set (relation weight either
     direction, or 0.5 for parent/next) is added if it fits;
  4. the **contiguous recent tail** (walk back from the newest message while each is selected) stays the linear
     conversation;
  5. everything else selected (older messages, contexts) goes into the system message, parents with children,
     chains in order, older messages as `<past-message>` blocks.
  Both regions are rebuilt from scratch every user message (or every iteration).
- **`load_context`** delivers content as tool output, marks the item injected, adds its `functions` to the fn-set
  (counted against the dynamic fn cap, 20 by default), and returns relation names so the model can ask for more.

### 1.4 What to take and what to leave

Take: the context fields and three edge kinds, effective weight, the RBF metric model (it is a clean, tunable way to
turn many signals into one score), the floor + greedy + graph pull + contiguous tail selection, the two-region
rebuild, never-inject-twice for the non-graph paths, "skills bring fns".

Leave or fix:

- **Budgets in characters.** `charThreshold` knows nothing about the model. The floor is free of the budget, so a long
  recent exchange overflows a small window. Tool definitions, the system prompt and the reply reserve are not counted.
- **Wall-clock recency.** Hours since a message is a poor signal in a chat that pauses for a day; turn distance is
  better for history, wall time is fine for memory.
- **Unbounded pool.** product scores every context row in Node. Harness should retrieve a bounded pool from its hybrid
  index first, then score.
- **Graph pull adds, never trades.** A connected item is added only if it still fits; it never displaces a weaker
  item, and items are all-or-nothing (no shorter form).
- **Messages only.** Fns are not candidates; the fn-set is a separate LRU-capped list.

## 2. Where harness is today

- **One mode.** `HubAgentLoop.#iterate` builds an aeye `Prompt` whose `retool` returns one native tool per fn
  (`toolset` in `tools.ts`): the agent payload's `tools` plus `session.tools`, filtered by enabled systems and
  availability, capped at `payload.maxTools` (64). `hub/chat` starts with eight hub fns (`search_fns`, `load_fns`,
  `search_context`, `load_context`, `search_resources`, `run_status`, `run_wait`, `ask_user`). `load_fns` adds to
  `session.tools` forever (there is `drop_fns` but no LRU).
- **Context.** `#context` concatenates `<context name>` blocks for `payload.context ∪ session.context` (static
  content only: dynamic context, `imports`, `fns`, `alwaysFor` and `ContextRecord.mentions` are not followed yet) into
  the instructions. `/command` adds the context to `session.context` (`turns.ts #commands`); hook `load` blocks do the
  same.
- **Suggestions.** `HubMessageEnricher` adds `<local_time>`, `<suggested_context>` and `<suggested_fns>` blocks (index
  top `HARNESS_SUGGESTIONS` = 6, hybrid vector + words) to each user message.
- **History.** The session's whole `transcript` (aeye `LlmMessage[]`) is sent every iteration
  (`SessionConversation`). Nothing knows the window: `ModelResolver` returns only a model id or weights, aeye's
  `forget` trims oldest groups only if the model's `contextWindow` is known, and it does not count tool definitions
  or the reply reserve beyond a default 4096.
- **Indexed kinds** already include `fn`, `context`, `section`, `message`, `type` (`INDEXED_KINDS`), so messages and
  sections have vectors and hybrid search.
- **Seams that help:** the `Conversation` port (`messages`/`append`/`answer`), `PendingCalls` (a tool call becomes a
  queued run of the named fn), `LlmCallScope`, gin's `type.toCode()` / `toCodeDefinition()` (a TS-flavoured signature,
  "exactly what an LLM sees"), aeye's `estimateMessageUsage` (characters / divisor, 4 for text by default) and
  `ModelInfo.contextWindow` / `maxOutputTokens` / `tokenizer` / `capabilities`.

Local fact (checked 2026-11-07): Ollama serves only `deepseek-r1:7b` (qwen2 family, Q4_K_M). `/api/show` reports
`qwen2.context_length = 131072`, but that is the trained length: Ollama runs each model with its own `num_ctx`
(4096 by default in current versions, 2048 in older ones) and **silently cuts the front of a longer prompt**. Its
OpenAI-compatible endpoint takes no `num_ctx`. So the window harness must budget for is the *served* window, which
only configuration (or Ollama's native API) can tell, never the model card.

---

## 3. Proposal overview

Two independent axes, both chosen per agent fn and overridable per session (like `model` today):

| Axis | Decides | Variants |
|---|---|---|
| **Chat mode** (`ChatMode`) | how fns reach the model and how its calls come back | `tools` (strict native tools, today), `static` (fixed small tool set + `run`, fn cards as text) |
| **Contextor** (`Contextor`) | what the prompt holds: which history, which context, which fns and at what detail | `plain` (today: whole transcript, loaded context), `suggest` (today's suggestion blocks + optional auto-inject), `graph` (fresh prompt per message, weighted selection under a token budget) |

Every combination is valid; **static + graph** is the small-local-model setup. Both axes sit behind one
`PromptBudget` that knows the model's limits (section 6), so even `tools + plain` stops sending more than fits.

The loop stays `HubAgentLoop`: per iteration it asks the contextor for a **selection**, asks the mode to **render**
it (tools or text) and to **interpret** the model's calls, and runs the calls as runs exactly as today.

## 4. Data model

All shapes are zod in `@harness/core` (types by `z.infer`); the agent payload's gin fields come from them with
`ginOf` and an `Equal` test, as `ContentRef` does today.

### 4.1 Mode and contextor config (`core/src/agent-modes.ts`)

```ts
export const DETAIL_LEVELS = ['listed', 'signature', 'full'] as const;
export const Detail = z.enum(DETAIL_LEVELS);           // how much of a fn or context the model sees

export const ToolsMode = z.object({ type: z.literal('tools') });
export const StaticMode = z.object({
  type: z.literal('static'),
  /** How calls come back: native tool calls, or tagged text for models without tool support. `auto` picks by the model's `tools` capability. */
  protocol: z.enum(['auto', 'native', 'text']).default('auto'),
  /** Where loaded fn cards go: the end of the system prompt, or a trailing system message after the conversation. */
  placement: z.enum(['system-end', 'tail']).default('system-end'),
  /** The detail a fn gets when it is loaded without one. */
  loadDetail: Detail.default('full'),
});
export const ChatModeConfig = z.discriminatedUnion('type', [ToolsMode, StaticMode]);

export const PlainContextor = z.object({ type: z.literal('plain') });
export const SuggestContextor = z.object({
  type: z.literal('suggest'),
  topN: z.number().int().min(0).default(6),
  autoInject: z.object({ tokens: z.number().int().min(0), items: z.number().int().min(0) }).optional(),
});
export const GRAPH_METRICS = ['embedding', 'words', 'turnsAgo', 'age', 'selectedBefore', 'used', 'weight'] as const;
export const GraphMetric = z.enum(GRAPH_METRICS);
export const MetricWeight = z.object({ weight: z.number(), target: z.number().optional(), k: z.number().positive().optional() });
export const GraphContextor = z.object({
  type: z.literal('graph'),
  metrics: z.partialRecord(GraphMetric, MetricWeight).default({}),
  /** Activation spread over links: how much a neighbour's score passes on, and how many hops. */
  spread: z.object({ damping: z.number().min(0).max(0.95).default(0.5), hops: z.number().int().min(0).max(4).default(2) }).default({}),
  /** Exchanges always kept in the linear history (the current message is always kept). */
  floorExchanges: z.number().int().min(0).default(1),
  /** Shares of the flexible budget; what one share leaves unused flows to the others. */
  shares: z.object({ history: z.number().min(0), context: z.number().min(0), fns: z.number().min(0) }).default({ history: 0.45, context: 0.35, fns: 0.2 }),
  /** Below this activation an item is not offered even as a name. */
  threshold: z.number().min(0).default(0.15),
  evaluate: z.enum(['perMessage', 'perIteration']).default('perMessage'),
});
export const ContextorConfig = z.discriminatedUnion('type', [PlainContextor, SuggestContextor, GraphContextor]);
```

`LlmPayloadType` gains `mode: ChatModeConfig` and `contextor: ContextorConfig` (defaults `tools` / `plain`, so
`hub/chat` behaves exactly as today); `Session` gains optional `mode` and `contextor` overrides. The admin and chat
settings UI edits them through the gin type the payload already exposes (the type editor of build 2).

### 4.2 Model limits (`core/src/records/spend.ts`)

```ts
/** What the hub budgets a model's prompts against. Every field may be absent: the next source fills it. */
export const ModelLimits = z.object({
  /** The window the provider actually serves (Ollama's num_ctx, not the trained length). */
  contextWindow: z.number().int().min(256).optional(),
  maxOutputTokens: z.number().int().min(16).optional(),
  /** Tokens a reasoning model thinks before it answers; reserved on top of the answer. */
  reasoningTokens: z.number().int().min(0).optional(),
  /** Characters per token for estimates, before calibration. */
  charsPerToken: z.number().min(1).max(8).optional(),
});
export const ModelLimitsRecord = z.object({ model: z.string(), limits: ModelLimits, setBy: ActorId, updatedAt: Timestamp });
```

New table `modelLimits` keyed by `model` (the aeye model id, `ollama/qwen2.5:3b`). Resolution (`ModelResolver`
returns them with the metadata): admin record → provider probe (section 6.1) → aeye `ModelInfo` → the env defaults
`HARNESS_DEFAULT_CONTEXT_WINDOW` (4096) and `HARNESS_DEFAULT_MAX_OUTPUT` (1024). Calibration state (section 6.2) lives
in a second table `modelCalibration` (`model`, `ratio`, `samples`), written after each call.

A provider variant for Ollama joins `providerVariants`:
`{ provider: 'ollama', baseURL: z.url().default('http://127.0.0.1:11434'), contextWindow: z.number().int().optional() }`,
served by `@aeye/openai` at `${baseURL}/v1` (no key) and probed with `/api/show` (section 6.1).

### 4.3 Context items (`core/src/records/systems.ts`)

Today `ContextRecord` is `{ name, system, decl, mentions, stale, updatedAt }`, always from a manifest. It grows an
origin, a weight and a size, and becomes the one record for every kind of context:

```ts
export const ContextOrigin = z.discriminatedUnion('type', [
  /** Declared in a system's manifest (skills, guides). */
  z.object({ type: z.literal('system') }),
  /** Written by a person or an agent with `hub/remember`; scoped to a session, a user, or everyone. */
  z.object({ type: z.literal('memory'), scope: z.discriminatedUnion('to', [
    z.object({ to: z.literal('session'), session: SessionId }),
    z.object({ to: z.literal('user'), user: ActorId }),
    z.object({ to: z.literal('everyone') }),
  ]), author: ActorId, run: RunId.optional() }),
  /** Made from a resource section (section 8); `live` reads the current version when loaded, `snapshot` keeps a copy. */
  z.object({ type: z.literal('resource'), uri: ResourceUri, section: SectionKey.optional(), version: z.string(), copy: z.enum(['live', 'snapshot']) }),
]);

export const ContextRecord = z.object({
  name: QualifiedName,          // fs/guide, memory/prefers-pnpm, resource/harness-md-decided-3f9a1c2e
  system: SystemName,           // the owning system; 'hub' for memory and resource context
  origin: ContextOrigin,
  decl: ContextDecl,            // + weight, + summary (below)
  mentions: z.object({ context: z.array(QualifiedName), fns: z.array(QualifiedName) }),
  /** Estimated tokens of the full content and of the summary form (section 6.2), kept current on write. */
  tokens: z.object({ full: z.number().int().min(0), summary: z.number().int().min(0) }),
  stale: z.boolean(),
  disabled: z.boolean(),
  updatedAt: Timestamp,
});
```

`ContextDecl` gains `weight: z.number().min(0).default(1)`, `summary: z.string().optional()` (a short form shown at
`signature` detail; when absent, `description`), `parent` and `next` (`QualifiedName`, for chains and hierarchies),
and `links: z.array(DeclaredLink)` for weighted edges (below). The fields it already has keep their meaning:

| The owner's word | Field | Behaviour |
|---|---|---|
| skill | `fns` (brings fns), `imports` (brings context) | selecting or loading it brings them as one unit |
| memory | `origin.type = 'memory'` | written by `hub/remember`, scoped, editable in the chat and admin |
| from a resource | `origin.type = 'resource'` | made by `hub/context_from_resource` (section 8) |
| injected into an llm kind by name | `alwaysFor: QualifiedName[]` (llm fn names) | always in that agent's prompt, first in the budget |
| loadable with `/command` | `command` | the chat composer offers it; it is forced into that turn |
| pulls in fns | `fns` (hard), `suggestFns` (soft link, weight 0.5) | see 4.4 |

Names: memory and resource context live under two **reserved system names**, `memory` and `resource`, which pairing
refuses (`SystemName` refinement in core), so `memory/…` can never collide with a real system. Their local name is a
slug plus 8 hex of a content hash, made by one `contextName(origin, title)` function.

### 4.4 Links (`core/src/records/content.ts`)

```ts
export const LINK_RELATIONS = ['imports', 'brings', 'suggests', 'parent', 'next', 'related', 'mentions', 'about', 'learned'] as const;
export const LinkRelation = z.enum(LINK_RELATIONS);
export const LinkTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), name: QualifiedName }),
  z.object({ kind: z.literal('fn'), name: QualifiedName }),
  z.object({ kind: z.literal('type'), name: QualifiedName }),
  z.object({ kind: z.literal('resource'), uri: ResourceUri, section: SectionKey.optional() }),
]);
/** What a system or person declares (ContextDecl.links). */
export const DeclaredLink = z.object({ to: LinkTarget, relation: LinkRelation.exclude(['learned', 'mentions']), weight: z.number().min(0).max(1).default(0.5) });
/** One edge as the hub keeps it. */
export const ContextLink = z.object({
  from: QualifiedName,
  to: LinkTarget,
  relation: LinkRelation,
  weight: z.number().min(0).max(1),
  /** Where the edge came from; declared and mentioned edges are rebuilt from their source, learned ones are kept. */
  source: z.enum(['declared', 'mentioned', 'resource', 'learned', 'authored']),
  updatedAt: Timestamp,
});
```

Table `contextLinks` keyed by (`from`, target key, `relation`). One source of truth per edge source:

- **declared / mentioned**: derived from the record by one pure `linksOf(record): ContextLink[]` (imports → `imports`
  weight 1; `fns` → `brings` 1; `suggestFns` → `suggests` 0.5; `parent`/`next` → 0.6; `decl.links`; `mentions` → 0.4).
  The catalog rewrites a record's derived edges in the same transaction it writes the record, so they never drift.
- **resource**: written by resource-to-context conversion (section 8).
- **learned**: co-use. When two items are both *used* in one turn (a context loaded or cited and a fn run, two fns
  run, two contexts loaded), the edge's count `n` goes up and `weight = 0.6 · (1 − e^(−n/4))` (caps at 0.6, so a
  learned edge never outweighs a declared one). Counts decay by half every `HARNESS_LINK_HALF_LIFE` (30 days) of
  no use. Kept in `contextLinks` with `source: 'learned'`; fn→fn learned edges use the same table with `from` a fn
  name (the `from` side is any qualified name, context or fn).
- **authored**: a person links two items in the admin context view.

Edges are directed; scoring reads them both ways (inbound edges count with a 0.5 factor, section 7.3).

### 4.5 Session state for the graph contextor

`Session` gains `selection: GraphSelection.optional()`: what the last cycle chose (item name → detail, activation),
used for the `selectedBefore` metric and for a stable answer within a turn. It is rewritten wholesale every cycle
(product's "rebuilt from scratch"). `session.tools` / `session.context` keep meaning "the agent or person loaded
these", which the graph contextor treats as forced-at-`signature` (fns) or forced-at-`full` (context) for a number of
turns (`HARNESS_LOADED_TURNS`, 3) after their last use, then as ordinary candidates with a `used` boost. That is the
answer to "auto remove LRU": nothing asks the model to drop anything.

---

## 5. Chat modes

### 5.1 The interface (`packages/hub/src/execution/modes/index.ts`)

```ts
/** How fns reach the model and how its calls come back. One implementation per `ChatModeConfig` variant. */
export interface ChatMode {
  /** Tokens a fn costs at a detail level in this mode (a native tool definition, or a text card). */
  cost(fn: FnView, detail: Detail): number;
  /** The tools and the prompt text for one iteration's selection. */
  render(selection: Selection, budget: PromptBudget): RenderedIteration;
  /** One model call → a queued run of a fn, or a reply the loop gives back at once (bad input, unknown fn). */
  interpret(call: ModelCall, rendered: RenderedIteration): CallPlan;
}
export interface RenderedIteration {
  readonly tools: FnTool[];          // native tools sent with the request (empty for the text protocol)
  readonly systemEnd: string;        // text appended to the instructions
  readonly tail: string | undefined; // a trailing system message, for placement 'tail'
  readonly protocol: 'native' | 'text';
}
export type CallPlan =
  | { type: 'run'; fn: QualifiedName; args: Json }
  | { type: 'reply'; status: 'invalid-input' | 'error'; text: string };

/** Every mode, by config type: adding a variant to ChatModeConfig fails to compile here until it has a mode. */
export const CHAT_MODES = {
  tools: (config, deps) => new ToolsChatMode(config, deps),
  static: (config, deps) => new StaticChatMode(config, deps),
} satisfies { [T in ChatModeConfig['type']]: (config: Extract<ChatModeConfig, { type: T }>, deps: ModeDeps) => ChatMode };
```

`FnView` is the catalog's fn record plus its `FnSignature` and gin type definitions; the `run` reply statuses use
build 2's `invalid-input` vs `error` split, so a bad `run` shows softly as "retried" in the chat.

### 5.2 `tools` (strict, today)

`render` turns each selected fn at `signature` or `full` into a native tool (`fnTool`, unchanged); `listed` fns go
into a short `<more_fns>` list in `systemEnd` so the model knows to `load_fns` them. `cost(fn)` is the estimated
tokens of the tool's JSON schema plus name and description. `interpret` maps the tool name back through
`Toolset.fns`. With `contextor: plain` this is exactly today's behaviour.

### 5.3 `static` (the new mode)

**The fixed tool set.** Five tools, always the same (so the tool block is small, about 500 tokens, and a provider
prompt cache stays warm):

| Tool | Args | What it does |
|---|---|---|
| `find` | `query`, `kinds?: ('fn'\|'context'\|'resource'\|'type')[]`, `limit?` | hybrid search; returns `name — description` lines, already-loaded items marked |
| `inspect` | `name`, `detail?: Detail` | one item at a detail: a fn's card, a context's content, a type's definition, a resource's stat and section outline |
| `load` | `names[]`, `detail?: Detail` | puts fns (as cards) and context (as content) into the prompt from the next iteration on |
| `unload` | `names[]` | takes them out (optional for the model; the contextor ages them out anyway) |
| `run` | `fn`, `args` | runs any fn the session may use, loaded or not |

`find`, `inspect`, `load` and `unload` are real hub fns (`hub/find`, `hub/inspect`, `hub/load`, `hub/unload`; the
existing `search_*`/`load_*` fns become their implementations), so they get policies, metrics and run records like
any fn. **`run` is not a fn.** `interpret` turns `run(fn, args)` straight into a `PendingCall` for the named fn, so
the run tree, the approval prompt and the chat card show `fs/read`, not a wrapper. Before queuing, the args are
checked with the fn's gin type; a failure is an immediate `invalid-input` reply that carries the fn's card at
`full`, so the next try has the signature in front of it. An unknown fn gets `invalid-input` with the three nearest
names from the index.

**Fn cards.** A loaded fn is shown as text, at the end of the prompt (`placement: 'system-end'`, the default, or
`'tail'`: a final system message after the conversation, which small models weigh more; try both, section 10.4):

```
## Loaded fns — call with run(fn, args)

### fs/read — Read a text file.                                   ← listed: this line only
run("fs/read", { path: text, lines?: { from: num, to: num } }) → { text: text, total: num }   ← signature
Read whole files under 2000 lines; use lines for longer ones.     ← full: instructions
Example: run("fs/read", { "path": "docs/harness.md", "lines": { "from": 1, "to": 80 } })
type Entry { path: text; kind: 'file' | 'folder'; size: num }    ← full: referenced types (gin toCodeDefinition)
```

The signature line is gin's `args.toCode()` and `returns.toCode()`; types are `toCodeDefinition()` of the fn's
`typeClosure`, each shown once per prompt even when several fns use it. Examples come from a new optional
`FnDecl.examples: { args: Json, note?: string }[]` (SDK `fn({ examples })`, args checked against the fn's own args type
at build time, so a wrong example does not compile). One renderer, `fnCard(view, detail): string`, used by `inspect`,
by `run`'s invalid-input reply and by the prompt region, so they always read the same.

**Fn results expose fns.** A fn result can ask for fns to be shown: `OutcomeWire` gains
`expose?: { fn: QualifiedName, detail: Detail }[]` (the SDK sets it with `ctx.expose(ref, detail)`). The hub's own
`find` exposes its hits at `listed`; `inspect` at the asked detail; a system's fn can expose follow-ups (`fs/search`
exposing `fs/read` at `signature`). The tool reply text ends with the card(s) at that detail; the item also becomes a
graph candidate with a `used` boost, so it stays near the top next iteration.

**Text protocol** (`protocol: 'text'`, chosen by `auto` when the model lacks aeye's `tools` capability, as
`deepseek-r1:7b` through Ollama does). No tools are sent; the instructions say:

```
To use a tool, write a block on its own lines and stop:
<run fn="fs/read">{"path": "README.md"}</run>
find, inspect, load and unload are tools too: <run fn="find">{"query": "git status"}</run>
```

The stream is watched for `<run`; text before it streams to the chat as usual, the block is held back, and parsing
happens at the end of the answer (`parseRunBlocks(text): { calls, prose, problems }`). Each call becomes a
`PendingCall` (a synthetic tool call id per block) and its result goes back as a user message
`<result fn="fs/read" status="done">…</result>` (aeye history keeps the assistant text as is). Bad JSON or a missing
`fn` attribute is an `invalid-input` reply, as for native calls. aeye's tool-argument repair is not available on this
path; the reply carries the parse error and the card, which is what small models need.

**Why it is cheaper than strict tools.** Strict mode pays every loaded fn's JSON schema on every iteration and grows
the tool list until something evicts. Static mode pays five tool schemas, plus cards only for what the contextor
selected at the detail the budget allows (a `listed` fn is one line), and the model can still run anything by name.

## 6. Token budgets: never more than the model takes

### 6.1 Knowing the limits

`ModelResolver.resolve` returns `{ metadata, limits: Required<ModelLimits> }` resolved in this order, first value wins
per field:

1. `modelLimits` record (admin; the chat's model picker shows "window 4096 / output 1024" and an edit link);
2. a **probe** cached per provider and model (`HARNESS_MODEL_PROBE_TTL`, 10 min): for `ollama`, `/api/show` gives the
   trained length and `parameters` (`num_ctx` when the Modelfile sets one); `contextWindow = num_ctx ?? provider
   record contextWindow ?? min(trained, HARNESS_OLLAMA_DEFAULT_CTX = 4096)`. Never the trained length alone;
3. aeye `ModelInfo.contextWindow` / `maxOutputTokens` (OpenRouter and OpenAI report these);
4. env defaults (4096 / 1024), logged once per model as `model.limits.guessed` so it shows in admin.

`reasoningTokens` defaults to `0.5 × maxOutputTokens` for models aeye marks `reasoning` (deepseek-r1 thinks before
answering and the thinking counts against output).

### 6.2 Estimating tokens

```
est(text) = ceil(chars(text) / cpt) + 4          per message (role and framing)
cpt       = limits.charsPerToken ?? tokenizerDefault(ModelInfo.tokenizer) ?? 4    (3.5 for Qwen/Llama3, 4 for GPT)
calibrated(text) = est(text) × r_model
r_model  ← EMA_0.2( actual_input_tokens / estimated_input_tokens ), clamped to [0.7, 1.6], starting at 1.1
```

After every call `LlmCallScope` has aeye's `usage.text.input`; the ratio updates `modelCalibration`. Item sizes are
estimated once on write (`ContextRecord.tokens`, fn card sizes cached by fn and detail with the catalog's fn hash) and
multiplied by `r_model` at selection time, so selection does no tokenizing. Images and files use aeye's divisors.
One module, `execution/tokens.ts`, holds `estimate`, `messageCost`, `toolCost` (the JSON schema text) and the ratio
update; everything else calls it.

### 6.3 The budget split

```
W = limits.contextWindow
O = limits.maxOutputTokens' + limits.reasoningTokens        maxOutputTokens' = min(limits.maxOutputTokens, payload.maxOutput ?? ∞)
M = max(64, ⌈0.06 · W⌉)                                       safety margin for estimate error
B = W − O − M                                                 tokens the request may hold

F = instructions + tool definitions + current user message (with its extras) + this turn's tool loop so far
R = B − F                                                     the flexible budget
```

`maxTokens = maxOutputTokens'` is set on the aeye request, and `contextWindow: W` / `maxOutputTokens` go on the
prompt context, so aeye's `forget` is a last resort that should never fire (it logs `agent.forget` if it does; a test
asserts it does not).

`R` is shared by three pools with **water-filling**: each pool asks for what its selected items cost; pools get
`min(ask_i, share_i · R)`; what is left goes to the still-hungry pools in proportion to their shares, repeated until
nothing is left or nobody asks (at most three rounds). Always-items (`alwaysFor`, `/command` this turn, items the model
loaded this turn) are charged first, before shares, because they are promises.

If `F > B` the request cannot be made as is. The fixed part is cut in this order until it fits: suggestion and hook
blocks of the user message (they are re-derivable), then old tool results of this turn (head and tail kept, the
middle replaced by `[… 3,214 characters trimmed: run it again with a range to see them]`), then the newest tool
result down to what is left. If the user's own words and the instructions alone exceed `B`, the turn fails with a
plain message ("This message is about 5,100 tokens; deepseek-r1:7b takes 2,900 here. Shorten it or pick a model with
a larger window.") instead of a silent truncation.

### 6.4 Trimming order (what goes first)

When the selection does not fit, the contextor gives things up in this order, lowest activation first within a step:

1. `listed` lines for items below `2 × threshold`;
2. older non-linear history summaries (section 7.5);
3. context `full` → `signature` (its summary) → `listed`;
4. fn cards `full` → `signature` → `listed` (static mode) or tool definitions → `<more_fns>` lines (tools mode);
5. linear history beyond the floor: the oldest exchange leaves the linear tail (and may come back as a summary);
6. tool results inside floor exchanges, shortened to head and tail;
7. the floor exchange itself, summarised to its user message and final answer.

Never cut: the instructions, the current user message text, the static tool set, always-items (an agent whose
always-items exceed `B / 3` for its model is flagged in admin when the agent or model changes, not discovered mid-chat).

---

## 7. The graph contextor

### 7.1 One cycle

Run at the start of each user message (and each iteration with `evaluate: 'perIteration'`):

```
query q      = the rendered user message (with mentions, without suggestion blocks)
1. pool      = retrieve(q)                              bounded, section 7.2
2. s₀(c)     = base score                                section 7.3
3. a(c)      = spread(s₀) over links                     section 7.3
4. units     = group items with their hard links         section 7.4
5. selection = choose details under the budget           section 7.4
6. history   = linear tail + non-linear summaries        section 7.5
7. prompt    = mode.render(selection) + history          section 7.6
```

The output is a `Selection`:

```ts
export interface Selection {
  readonly context: ReadonlyArray<{ name: QualifiedName; detail: Detail; activation: number }>;
  readonly fns: ReadonlyArray<{ name: QualifiedName; detail: Detail; activation: number }>;
  readonly linear: readonly LlmMessage[];      // the conversation the request carries
  readonly earlier: readonly ExchangeSummary[]; // selected older exchanges, for the system prompt
  readonly budget: BudgetReport;               // W, O, M, B, F, what each pool asked and got, what was cut
}
```

`BudgetReport` is saved on the LLM interaction record, and the chat's run inspector shows it ("4,096 window: 1,024
reply, 246 margin, 612 fixed, 1,230 history, 640 context, 344 fns"), so the owner can see why something was left out.

### 7.2 Retrieval: a bounded pool

```
pool = always-items ∪ session-loaded items ∪ last cycle's selection
     ∪ Search.search(q, kinds: ['context','fn'], limit: K)            K = HARNESS_GRAPH_POOL (48)
     ∪ Search.search(q, kinds: ['message'],     limit: K/2, session)   older exchanges of this session
     ∪ neighbours(all of the above, 1 hop, by link weight, at most K)
```

Filtered to the session's enabled systems, available items, audience `ai`, not disabled, memory in scope (this
session, this user, everyone). Sections are not candidates by themselves; they reach the prompt through
resource-derived context or `inspect`. The pool size is bounded by `3K`, independent of how much context exists.

### 7.3 Scores

**Base score**, product's RBF model with harness's metrics (`rbf(x, t, k) = e^(−k(x−t)²)`):

```
s₀(c) = w(c) · Σ_m W_m · rbf(f_m(c), t_m, k_m) / Σ_m W_m

metric          f_m(c)                                                  t   k     default W
embedding       cosine(e_q, e_c) from the vector index                  1   4     1.0
words           |tokens(q) ∩ tokens(c)| / |tokens(q)|                  1   2     0.3
turnsAgo        turns since c was last selected or used (∞ ⇒ metric off) 0   0.15  0.4
age             days since c was written (memory only)                  0   0.02  0.1
selectedBefore  1 if in last cycle's selection, else 0                  1   1     0.3
used            uses in the last 5 turns / 5 (ran, loaded, cited)       1   1.5   0.5
weight          not used here: w(c) multiplies the sum instead          —   —     —
w(c)            decl.weight (memory 0.8, resource 1, system 1); 0 excludes
```

`f_m(c)` returning nothing (no vector yet, never used) leaves that metric out of both sums, so an item is not punished
for a signal it cannot have. Normalising by `Σ W_m` keeps `s₀ ∈ [0, w(c)]` whatever weights a session sets.
Messages score the same way, with `turnsAgo` = turn distance from now.

**Spread** over links (a damped, personalised activation, like personalised PageRank with a fixed number of steps):

```
a⁰(c)     = s₀(c)
aʰ⁺¹(c)   = s₀(c) + λ · Σ_{u → c} ŵ(u, c) · aʰ(u)  +  λ/2 · Σ_{c → u} ŵ(c, u) · aʰ(u)
ŵ(u, c)   = weight(u, c) / max(1, Σ_v weight(u, v))          out-weight normalised, so a hub item does not flood
a(c)      = a^H(c),   H = spread.hops (2),   λ = spread.damping (0.5)
```

Because `λ < 1` and the weights are normalised, `a` stays bounded (`a ≤ s₀ / (1 − 1.5λ)` in the worst case; with the
default `λ = 0.5`, 4 × the base). A fn reached only through links (a skill's fn) gets activation without any text
match, which is how "context brings fns" works without the model asking.

### 7.4 Choosing what goes in, and at what detail

**Units.** An item and its hard links travel together: a context with its `imports` (recursively, cycles cut) and its
`brings` fns is one unit; its cost at a detail is the sum of its members' costs, and a brought fn is at least
`signature` when its context is at `signature` or `full`. Soft links (`suggests`, `related`, learned) only spread
activation.

**Detail values.** An item `c` at detail `d` is worth `v(c, d) = a(c) · q_d` with `q_listed = 0.15`,
`q_signature = 0.6`, `q_full = 1`, and costs `cost(c, d)` tokens (context: `listed` = its line, `signature` = its
summary, `full` = its content; fns: `ChatMode.cost`).

**Greedy by value per token** (the standard greedy for a multiple-choice knapsack):

```
current(c) = none for every unit with a(c) ≥ threshold; forced units start at their forced detail, charged first
loop:
  candidates = every unit's next upgrade (none→listed, listed→signature, signature→full)
  pick the upgrade u with the largest (v(c, d') − v(c, d)) / (cost(c, d') − cost(c, d)) that fits its pool
  apply it; stop when no upgrade fits any pool
```

Pools are the shares of section 6.3; an upgrade fits when its pool (after water-filling) has the tokens. Ties go to
the item selected last cycle, then to the higher activation, so the prompt is stable between messages and between
runs of the same test. This replaces product's add-only graph pull: a connected item now competes on value per token,
and a big item can enter in a short form.

### 7.5 Rebuilding the history

The session transcript stays the record of everything (`session.transcript`, unchanged). The graph contextor builds
the request's history from it with a `GraphConversation` that implements the `Conversation` port (append and answer
still write the transcript; `messages()` returns the rebuilt view):

- **Exchanges.** The transcript is cut into exchanges: a user message and everything until the next user message
  (assistant text, tool calls and their replies). Each exchange is a candidate with the message metrics; its text for
  similarity is its user message and final answer; its cost is the sum of its messages.
- **The current turn** (the user message and every iteration since) is always linear and charged to the fixed part.
- **Floor.** The last `floorExchanges` exchanges are always linear, charged to the history pool (not free, unlike
  product); when they do not fit, step 6 and 7 of the trimming order shorten them.
- **Selection.** Older exchanges are chosen by activation per token into the history pool, as in 7.4.
- **Contiguous tail.** Walking back from the newest exchange, those selected in a row form the linear history, sent as
  real messages in order. Selected exchanges before the first gap become **earlier summaries** in the system prompt:

```
<earlier turn="12" when="2 hours ago">
User: how do I add a sectioner for csv files?
Answer: (short) Declare one with sectioner({ match: { format: 'csv' } }) and …
Used: fs/read docs/architecture.md, context fs/sectioners
</earlier>
```

  Summaries are made without a model call: the user message and the first and last sentences of the answer, clipped to
  `HARNESS_EARLIER_TOKENS` (120), plus the names of fns and context the exchange used. Old tool results never travel
  in summaries; the model can `run hub/run_status` with the run id if it needs one.

Tool call messages are kept whole or left out whole (an assistant's `tool_calls` with every reply, as aeye's `forget`
groups them), so providers never see a call without its reply.

### 7.6 Prompt layout

```
system:  agent instructions
         <context name="fs/guide">…</context>           selected context, parents before children, chains in order,
         <context name="memory/prefers-pnpm" detail="signature">…</context>    higher activation first within a group
         <more_context> fs/sectioners — How sections are cut; … </more_context>   listed items, loadable by name
         <earlier …>…</earlier>                          earlier summaries, oldest first
         ## Loaded fns — call with run(fn, args) …       fn cards (static, placement system-end)
history: the linear tail, then the current turn
tail:    fn cards (static, placement tail)
```

The `<suggested_context>` / `<suggested_fns>` blocks of the enricher are not added in graph mode: the selection already
did that job, and `listed` lines are the suggestions.

### 7.7 Plain and suggest under the same budget

`plain` keeps today's prompt but runs the same budget: when `transcript + loaded context + tools > B`, it applies the
trimming order (steps 5 to 7) to the oldest exchanges and reports it, instead of letting the provider cut silently.
`suggest` is today's enricher blocks plus product's optional `autoInject`, now in tokens: the top `items` context
whose `full` cost fits `tokens` go into the system prompt. Both are a few dozen lines over the same `tokens.ts`,
`budget.ts` and renderers.

### 7.8 The interface (`packages/hub/src/execution/contextors/index.ts`)

```ts
/** What goes in one iteration's prompt. One implementation per `ContextorConfig` variant. */
export interface Contextor {
  select(input: ContextorInput): Promise<Selection>;
}
export interface ContextorInput {
  readonly session: Session | undefined;   // an agent outside a session uses its run conversation
  readonly payload: LlmPayload;
  readonly turn: Turn;
  readonly query: string;
  readonly transcript: readonly LlmMessage[];
  readonly limits: Required<ModelLimits>;
  readonly ratio: number;                  // calibration
  readonly mode: ChatMode;                 // for fn costs
  readonly fixed: number;                  // F, measured by the loop
}
export const CONTEXTORS = {
  plain: (config, deps) => new PlainContextor(config, deps),
  suggest: (config, deps) => new SuggestContextor(config, deps),
  graph: (config, deps) => new GraphContextor(config, deps),
} satisfies { [T in ContextorConfig['type']]: (config: Extract<ContextorConfig, { type: T }>, deps: ContextorDeps) => Contextor };
```

`ContextorDeps` is `Search`, `Catalog` (context, fns, links, signatures), `HubStore` (sessions, links, calibration),
`clock` and `log`. The pure parts live in their own files so tests need no store: `score.ts` (`rbf`, `baseScore`,
`spread`), `choose.ts` (`units`, `chooseDetails`, `waterFill`), `history.ts` (`exchanges`, `contiguousTail`,
`summarise`), `render.ts` (context blocks, `fnCard`, earlier blocks). Tunables (`HARNESS_GRAPH_POOL`,
`HARNESS_LOADED_TURNS`, `HARNESS_EARLIER_TOKENS`, `HARNESS_LINK_HALF_LIFE`, `HARNESS_DEFAULT_CONTEXT_WINDOW`,
`HARNESS_DEFAULT_MAX_OUTPUT`, `HARNESS_OLLAMA_DEFAULT_CTX`, `HARNESS_MODEL_PROBE_TTL`) go in a `contextor` env slice
beside the code. Logs: `contextor.selected` (counts per detail, budget numbers), `contextor.cut` (what and why),
`contextor.overflow` (F > B).

### 7.9 Where it plugs into the loop

In `HubAgentLoop.#iterate`, after the model and its limits are resolved and before the `Prompt` is built:

1. `mode = CHAT_MODES[cfg.mode.type](…)`, `contextor = CONTEXTORS[cfg.contextor.type](…)` (session override, else
   payload).
2. `fixed = instructions + mode's fixed tools + current turn` (tokens.ts).
3. `selection = contextor.select(…)` (cached on the run's `resume` per user message for `perMessage`, so a resumed or
   retried job sends the same prompt).
4. `rendered = mode.render(selection, budget)`; `retool` returns `rendered.tools`; `content` becomes
   `instructions + context region + earlier + systemEnd`; `ctx.messages = selection.linear` (+ `rendered.tail`).
5. Tool calls (or text-protocol blocks) go through `mode.interpret`; `run` plans become `PendingCall`s as today;
   `reply` plans are answered at once with their status.
6. After the call, update calibration and learned links.

`#tools` and `#context` move into the `tools` mode and the `plain` contextor; nothing else in the loop changes.

---

## 8. Resources to context

**Renditions.** A resource keeps its raw bytes where it is served (the system) or in the hub's content store, and
the hub keeps **renditions** for LLMs: a new `resourceRenditions` table, `{ uri, version, format: 'markdown' | 'text'
| 'table' | 'code', content: ContentRef, parser: string, tables?: TableSummary[] }`. They come from aeye's parsers
(`htmlParser` → markdown via `htmlToMarkdown`, with `renderUrl` from the build 2 web system's puppeteer;
`docxParser` → markdown; `excelParser` → markdown tables plus `metadata.structuredTables`, kept as `format: 'table'`
with columns and row counts; `pdfParser` → text per page; code and markdown as they are). The resource view shows raw
and each rendition when both exist.

**Sectioning reads the rendition.** The indexer's sectioners (`whole`, `headings`, `symbols`, `pages`, `paragraphs`)
run over the preferred rendition by default (markdown for HTML and DOCX, table for spreadsheets: one section per
table region, its key the sheet and range), so section keys stay structural.

**`hub/context_from_resource`** (a hub fn, so the chat and the admin do it the same way):

```
args:    { uri, sections?: SectionKey[] | 'all', copy?: 'live' | 'snapshot', weight?, alwaysFor?, command? }
returns: { created: QualifiedName[], updated: QualifiedName[], links: number }
```

1. One context per section (or one for the whole resource when it has one section): name from `contextName`,
   `description` = the section's heading path and the resource name, `summary` = aeye's section summary when the
   resource type is configured with `summarize`, else the first 300 characters.
2. A section larger than `HARNESS_CONTEXT_PIECE_TOKENS` (600, small-model friendly) is cut into a `next` chain at
   paragraph boundaries.
3. A resource-level context (`parent` of every section context) holds the outline.
4. Links: `parent`/`next` as above; `about` → the resource (weight 1); each resource link that points at a resource
   which also has context → `related` 0.4 (0.6 for `imports` in code); mentions of fns and context in the text →
   `mentions`.
5. `live` context reads its content from the section's current version when loaded and turns `stale` (already a
   field) when the section diff changes it; `snapshot` keeps the text and is never stale.

Re-running it is idempotent: names come from the uri and section key, so a second run updates rather than duplicates.
A chat command (`/remember-file @fs/docs/harness.md`) and a button in the resource view call it.

**Memory**, for completeness: `hub/remember { text, scope, about?: LinkTarget[], weight? }` writes a memory context
(name from the first words) with `about` links, and `hub/forget { name }` disables it. Both are tagged so the default
policy asks the person before writing to `user` or `everyone` scope.

---

## 9. Library notes

- **aeye `forget` does not count tool definitions** and assumes `maxOutput` 4096 when not given. Harness passes
  `contextWindow` and `maxOutputTokens` and stays under them itself; still worth fixing in aeye so `forget` is correct
  for other users (ask: count `request.tools` JSON in the input estimate).
- **aeye model limits are static.** A provider hook to report the served window (Ollama `num_ctx`) would let
  `ModelInfo.contextWindow` be right; until then the hub's probe and `modelLimits` cover it (ask, not a blocker).
- **aeye text tool protocol.** The static mode's text protocol could live in aeye as a schema fallback for tools
  (`SCHEMA_FALLBACKS` today only moves the output schema). Build it in harness first (`parseRunBlocks`), offer it to
  aeye after it proves out.
- **gin** already renders what fn cards need (`toCode`, `toCodeDefinition`, `typeClosure`); nothing to ask.
- **@aeye/resources** already converts HTML, DOCX and spreadsheets; the open folder-resolver ask stands.

## 10. Test plan

Unit tests beside the code (`vitest unit`), no network, fakes of `Search`, `Catalog`, `HubStore` (the existing
`execution/testing.ts` scripted engine for loop tests). Random cases use a seeded generator in a test helper (no new
dependency).

### 10.1 Pure parts

- `tokens.ts`: estimates per message; tokenizer defaults; calibration EMA moves toward the observed ratio and is
  clamped; `toolCost` equals the length of the serialized schema / cpt.
- `budget.ts`: `B = W − O − M` for given limits; reasoning reserve applied only to reasoning models; water-filling
  gives leftover share to hungry pools, conserves the total (`Σ got ≤ R`), and is order-independent.
- `score.ts`: `rbf` peaks at target; a metric with no signal drops out of both sums; `s₀ ∈ [0, w]`; weight 0
  excludes; spread with `λ = 0` is the base score; a two-node cycle converges and stays under the bound; out-weight
  normalisation (one item with 50 links passes no more than one with 1).
- `choose.ts`: units include imports recursively and stop at cycles; a brought fn is never below `signature` when its
  context is at `signature`+; greedy picks the best value per token; ties prefer last cycle's items; forced units are
  charged first; **property:** for 500 seeded random pools, limits and shares, the chosen total never exceeds `R` and
  no single upgrade that fits was left out.
- `history.ts`: exchanges keep tool calls with their replies; contiguous tail stops at the first unselected exchange;
  the floor is always present (shortened, never dropped); summaries are under `HARNESS_EARLIER_TOKENS`.
- `render.ts`: `fnCard` at each detail (snapshot tests); a shared type is printed once; context grouped parents first
  and chains in order; `parseRunBlocks` handles several blocks, prose around them, bad JSON (`invalid-input`), a
  missing `fn`, and a block split across stream chunks.
- `linksOf(record)`: every decl field maps to its relation and weight; changing a decl rewrites exactly its derived
  edges; learned weights follow `0.6(1 − e^(−n/4))` and decay by half after the half-life.
- Compile-time: `CHAT_MODES` and `CONTEXTORS` fail to compile when a config variant is added without an implementation
  (`@ts-expect-error` in a typetest); the payload's gin `mode`/`contextor` equals the core zod types (`Equal`).

### 10.2 Modes and the loop (scripted engine)

- `tools` + `plain` sends exactly today's request (golden test against the current loop's output), so build 1 stays
  green.
- `static`: the request has exactly the five tools; `run("fs/read", args)` creates a run of `fs/read` (not a wrapper)
  with the fn's policy applied; bad args give an `invalid-input` reply with the card and no run; an unknown name
  suggests near names; `load` shows the card on the next iteration; a result with `expose` adds the card to the reply.
- Text protocol: with a model lacking `tools`, no tools are sent, `<run>` blocks become runs, prose streams to the chat
  and the block does not.
- Budget in the loop: with limits `{ window 2048, output 256 }` and a 60-exchange transcript, every request's estimate
  is `≤ B`, aeye `forget` never runs (spy), and the `BudgetReport` is saved; with a user message larger than `B` the
  turn fails with the plain message, not a provider error.
- Graph: a skill context selected by similarity brings its fn's card without the fn matching the query; a fn run last
  turn is still offered (`used`); a 2,000-token context enters at `signature` when only that fits; selection is the
  same for a retried job (cached on `resume`).

### 10.3 Resources to context

- A markdown resource with three headings gives three section contexts, a parent, `next` order, and `about` links; a
  1,500-token section becomes a chain of three pieces; re-running updates, never duplicates; a changed section marks
  its live context stale and leaves snapshots alone.
- An HTML resource is sectioned over its markdown rendition; a spreadsheet gives one context per table region with
  its columns in the summary.

### 10.4 Live (marked `*.live.test.ts`, minimal)

- **Ollama small window** (`ollama pull qwen2.5:3b`; limits from the probe; a `modelLimits` record of window 4096 /
  output 512): seed 40 context items of about 500 tokens and a 30-exchange session; send five messages. Assert each
  request's estimate `≤ B`, Ollama's `prompt_eval_count` (from the usage aeye returns) `≤ 4096 − 512`, and that the
  answer to a question only one seeded item can answer names it (the right item was selected).
- **Static mode, no native tools** (`deepseek-r1:7b`, text protocol): "how many lines does README.md have?" ends in a
  `fs/read` run started through a `<run>` block and an answer with the number.
- **Placement**: the same static task with `system-end` and `tail` on `qwen2.5:3b`, five runs each, logging success
  and tokens; the result is recorded in the design doc, the test only checks that both complete.
- One free OpenRouter model with `static` + `graph` and native tools, to prove the mode is not Ollama-specific.

## 11. Summary of the changes by owner

| Where | Change |
|---|---|
| core | `agent-modes.ts` (mode and contextor configs, `Detail`), `ModelLimits` + `modelLimits` / `modelCalibration` tables, `ContextOrigin`, `ContextRecord` (origin, tokens, disabled), `ContextDecl` (weight, summary, parent, next, links), `ContextLink` + `contextLinks`, `resourceRenditions`, `Session.mode` / `contextor` / `selection`, `OutcomeWire.expose`, `FnDecl.examples`, ollama provider variant, reserved `memory` / `resource` system names |
| sdk | `LlmPayloadType` gains `mode`, `contextor`, `maxOutput`; `fn({ examples })`; `context({ weight, summary, parent, next, links })`; `ctx.expose()`; hub fns `find`, `inspect`, `load`, `unload`, `remember`, `forget`, `context_from_resource` |
| hub execution | `modes/` (`ToolsChatMode`, `StaticChatMode`, `parseRunBlocks`), `contextors/` (plain, suggest, graph and the pure files), `tokens.ts`, `budget.ts`, limits in `ModelResolver`, the Ollama probe, the loop changes of 7.9 |
| hub catalog | `linksOf` and derived links written with records; learned-link updates |
| hub index | renditions, sectioning over renditions, `context_from_resource` |
| hub chat | enricher skips suggestion blocks in graph mode; `/command` forces the item for the turn |
| web | mode and contextor pickers in chat settings and the agent editor (URL-tied), model limits in the model picker, the `BudgetReport` in the run inspector, context links in the context view, renditions in the resource view |
