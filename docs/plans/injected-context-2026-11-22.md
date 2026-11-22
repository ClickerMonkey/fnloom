# Injected context, one fn name for the model, ctx fns (2026-11-22)

Phil's review of the rewritten chat system prompt (hitloop review `chat-system-prompt-rewritten-for-iteration-2`),
before iteration 2 runs. This is done before any more big end-to-end testing.

## Phil's words (verbatim)

> A lot of this is much better. I don't like the 7 default tools hard coded in here, I would much prefer it to be dynamic, because if I ask to add a new one or we hide some or the chat mode is static toolset or something then the prompt is out of date. I also am thinking that the cognitive load between fn formats that the llm sees, can use, and the human sees is too much. That's three different formats. To the llm it should always be a one to one and no translation needed. And the user always sees the human friendly version of that - they don't ever need to see what's underneath unless they hover or click because they can as an admin - etc. the average user should just see friendly, the llm should just see the one valid format. The format with slashes and periods and what not should be invisible to the llm and not worth mentioning. It also talks about using kinds for fn searching - I think that will result in missed fns because the llm won't always know how something was implemented. I would discourage use of kind there unless the user explicitly asks.i also didn't realize fns_search returns context. We should exclusively have ctx_search because fns do something and ctx has information. Also shorten any context fn names to ctx. Matches fns. This also assumes the input system is installed. Ideally let's update context to have an "inject" property (admins need to approve this) which targets a hub/llm instance (of which the chat agent needs to be one) and it actually automatically puts that context into the system prompt in a {{injectedContext}} section. Any system can contribute these and need to be admin approved. Most of the system prompt could actually be populated this way so it's more transparent to the admin. And an admin for any hub/llm fn instance they can see what is injected and also can toggle them off if desired. I know this is probably a lot but I think it's the proper extendable way for the future. Should be done before we do more big e2e testing. Also the fs_git thing I hope is not hard coded in hub - every system should be able to hook into the user message similar to Claude hooks..we need to keep system specific things in the systems so if they are not installed they don't appear to exist at all. It needs to be clean and data needs to be organized this way.

(On fs_git: the hook mechanism is generic — any system's hook becomes a block named after it, `fs/git` → `<fs_git>`,
with no fs code in the hub — but the rewritten prompt names `<fs_git>`, `input/…`, `widgets/…` and `database/…`
itself, 11 mentions, so it describes systems that may not be installed. That moves into each system's injected
context.)

## What this asks for

1. **The tools the chat starts with are not written into the prompt.** Whatever the agent's toolset and chat mode
   really give it is what the prompt says (or the prompt doesn't list them at all and the tool list speaks for itself).
2. **One fn name for the model.** The model sees exactly one form of a fn's name everywhere it meets one (its tool
   list, search results, cards, guides, errors, results, citations), and that form is a valid tool name it calls as is.
   The `system/name` and `.` forms are never shown to it or explained. People see the friendly label; an admin sees the
   qualified name on hover or click.
3. **Search by kind is discouraged** unless the person asks for it: the model can't know how a fn was made.
4. **`hub/ctx_search` for context; `hub/fns_search` for fns only.** Fns do things; context holds information. Every
   context fn's name says `ctx` (`load_ctx`, `ctx_crawl`, …), matching `fns`.
5. **Injected context.** A context item can declare `inject`, targeting hub/llm agent fns (the chat agent is one). An
   admin approves each injection (as with any system change). Approved, enabled injections go into that agent's system
   prompt in an `{{injectedContext}}` section. Any system can contribute them. Most of today's system prompt becomes
   injected context, the hub's own included, so an admin can see what each agent is told. For any hub/llm fn, an admin
   can see what is injected into it and switch each injection off.
6. **System-specific text lives in its system.** Nothing in the hub's prompt names a system that may not be installed:
   the input, database, widgets, fs, web… guidance (including what a system's hook block means) is that system's
   injected context, and is absent when the system is.

## Design

Design only: nothing here is built. The order is Phil's: this design, then the types below for approval, then the zod
schemas, then code. The open choices are the hitloop set `injected-context-2026-11-22`; where this text says
"recommended", the set asks.

What I read first: `packages/sdk/src/chat-prompt.ts` (today's `CHAT_BASE` and `CHAT_SMALL_BASE`),
`packages/hub/src/contextor/` (the planner's fixed region, the modes, the cards), `packages/hub/src/chat/enrich.ts`
(hooks to blocks), `packages/sdk/src/hub.ts` (the hub's fns), `packages/sdk/src/declare.ts` (`context()`, `hook()`),
`packages/core/src/manifest.ts` (`ContextDecl`), `packages/core/src/primitives.ts` (`toolName`, `fnOfToolName`),
`packages/sdk/src/server/mcp.ts` (`mcpToolNameOf`) and the providers aeye talks to (OpenAI, OpenRouter, AWS, Ollama,
Replicate; aeye itself passes tool names through untouched). Four facts shaped it:

- **The model meets three spellings today, and an MCP client a fourth.** `hub/fns_search` in prose, cards, results
  and `run({ fn })`; `hub__fns_search` as a tool; `database__main--expenses_create` for a dotted name; and an MCP
  client sees `hub_fns_search` (`mcpToolNameOf`). Today's `toolName` is also not one-to-one: it cuts at 64
  characters, and a local name holding `--` reads back as a `.`.
- **Every conversion already goes through two core functions** (`toolName`, `fnOfToolName`), used in five places. One
  module can own the new name.
- **`alwaysFor` already exists** on context ("always loaded for these agents"). It puts an item in the loaded-context
  part of the prompt, not the fixed part; a system's own `alwaysFor` needs no approval of its own, and no admin can
  see per agent what reaches it. Injected context is that idea done properly, so it replaces it.
- **The hook mechanism is generic.** `enrich.ts` runs every hook of the session's systems and names the block after
  the hook (`fs/git` → `<fs_git>`); there is no fs code in the hub. What isn't generic is the prompt text: it names
  `<fs_git>`, `input/…`, `database/…`, `widgets/…` and the web's reads itself.

### 1. One name for the model

**The format.** A fn's model name is its qualified name with every `/` and `.` written `__`:

| Qualified (people, admins, code) | Model name |
|---|---|
| `hub/fns_search` | `hub__fns_search` |
| `hub/ctx_search` | `hub__ctx_search` |
| `input/get_input` | `input__get_input` |
| `database/main.expenses_create` (a saved fn of instance `main`) | `database__main__expenses_create` |
| `fs/Entry.reveal` (a method) | `fs__Entry__reveal` |
| `google-calendar/list_events` | `google-calendar__list_events` |
| `database/household_budget.monthly_grocery_spending_by_store_and_category_since_2024` (85 characters) | `database__household_budget__monthly_grocery_spending_b_xf34e264b` |

One rule, "`__` separates the parts", which reads well and which models already know from MCP tool names
(`mcp__server__tool`). It is a valid tool name for every provider aeye talks to: the strictest are OpenAI, Anthropic
and Bedrock (`^[a-zA-Z0-9_-]{1,64}$`) and Gemini through OpenRouter (must start with a letter or `_`); a model name
always starts with its system's first letter.

**One-to-one.** A system name never holds `_`, so the first `__` ends the system. For the rest to read back, a local
name may not hold `__`, and no dot-separated part of it may start or end with `_` (so `a._b` can't be confused with
`a_.b`). The hub refuses such a name when a system declares it or a fn is saved, with the reason. None of today's names
break: no declared local name or context key holds `__` or starts with `_`. A model name never needs the old `--`.

**Long names.** A model name longer than 64 characters is cut to 54, trailing `_` dropped, and ends in `_x` and the
first 8 hex characters of the qualified name's sha-256 (the last row above). It can't be read back by rule, so reading
back never goes by rule: the hub keeps a **name registry**, built from the catalog (every fn, context item, type and
hook, each encoded once), and turns a model name into a qualified name by looking it up. Two names that encode the
same (only possible through the hash) are refused when the second is declared. Names that are gone (a deleted saved fn
in an old transcript) stay in the registry's history table, so an old call still reads back for people.

**Which names.** Every qualified name the model reads, not only fns: context keys (`fs__guide__paths`), types
(`fs__Entry`) and hook blocks (`<fs__git>`). "Context is named like a fn" stays true, and the model never sees a `/`
name anywhere. (Asked: fns only, or every name.)

**Where it is used.** Everywhere the model meets a name, with no exception:

- the tool list (tools mode), and static mode's `run({ "fn": "database__main__expenses_create", … })`;
- every card (`<fn name="…">`, `<ctx key="…">`), the `<more_fns>` and `<more_ctx>` lists, suggestions,
  `<loaded_for_you>`, `<brought_fns>`, `<loaded_fns>`, `<refused_fns>` and the crawl's cards;
- search hits (`name`), `hub__load_fns`'s `loaded`, every result field that holds a name;
- refusals and errors ("`database__create_table` changed and waits for an admin to approve it");
- the `<systems>` list's text, guides, context text, fn descriptions, instructions and examples, hook block docs and
  the injected context below (system names themselves hold no `/` and stay as they are);
- the hub MCP and a system's own MCP face, so an MCP client sees the name a chat model does (today's `system_local`
  goes). An MCP client that allow-listed old names (Claude Code's `mcp__harness__fs_read`) needs its list redone once.

Citations' `tool` is a run id (`run_…`), not a name: unchanged.

**Where the conversion happens: one module, three boundaries.** `core/src/model-names.ts` owns the encoder, the rule
check and the registry's interface; nothing else spells a model name. The hub calls it at the only three places a name
crosses to or from the model:

1. **Out, prompt text.** The planner's assembly writes every part of the prompt (instructions, injected context, the
   systems list, the mode's guide, context blocks, cards, and the hook and hub blocks of a user message when it is
   sent) through `modelText`, which turns each qualified name it finds into its model name.
2. **Out, results.** The agent loop writes each tool result through `modelValue`: fields whose type says they hold a
   name (a new gin `g.name()`, below) are encoded; text fields go through `modelText`.
3. **In, calls.** The mode's call planning reads a tool name, `run`'s `fn` and every `g.name()` field of the args back
   through the registry. A name the registry doesn't know is refused as today, with the closest model names. A
   qualified name the model writes anyway is still accepted (never shown, never asked for), so a model that guesses
   the `/` form isn't punished.

**How authored text names fns.** About 2,600 qualified names sit in today's descriptions, instructions, examples and
context bodies (`hub.ts` and the systems' contracts). They are not rewritten by hand. `modelText` finds a name two
ways: an explicit ref (`fn:fs/read`, `context:fs/guide`, already the context-file body syntax the build checks), and a
bare qualified name the registry knows, standing alone (not after `/`, `:`, `.` or a letter, so `file:///repo/fs/read`
and `docs/fs/read.md` are left alone). In TypeScript a ref interpolates: `` `Read it first with ${fns.read}.` `` writes
`fn:fs/read`, so a rename is a compile error, not a stale sentence. The SDK's build warns on a bare `x/y` in
model-facing text that names nothing it knows (today's broken-link check, widened from context files to descriptions
and instructions). (Asked: auto-detect plus refs, or explicit refs only.)

**People and admins.** Nothing changes for them: the web shows fn pills (friendly label, qualified name on hover,
details on click, admins see everything) wherever it names a fn, and already does in every place listed in "Fn pills".
The LLM call view and the run inspector show the raw request; they read tool names back through the registry
(`fnOfToolName` asks the hub for a cut name) and draw them as pills, while the raw JSON keeps the model name.

**Stored data.** Old transcripts hold tool calls named the old way (`hub__load_context`, `database__main--x`), and
sessions hold old qualified names in their tools and context lists. Nothing of the harness is pushed or published (130
local commits) and the only data is the dev hub and scenario runs, so the recommended path is a clean rename with one
store migration (`store/migrate.ts`): it rewrites tool-call names in stored transcripts (old rule read back, new rule
written), and every renamed fn (section 3) in sessions, policies, grants, item switches, hub MCP rules, examples and
runs. Model call records (the raw requests) are history and stay as they were; the web reads the old spelling there
through a legacy reader kept for display only. (Asked: migrate, wipe, or keep aliases for a release.)

### 2. The tools the agent starts with

The prompt stops listing them. The tool list is the truth in tools mode, and the mode's guide is the truth for how to
get more:

- **Tools mode** gets a guide (today it has none), written by the mode from the agent's real toolset for this chat:
  "Your tools are a few of the fns you can use. To use another, find it with `hub__fns_search`, add it with
  `hub__load_fns` (it is in your tools from your next step), then call it." The names come from the mode's own refs,
  so a rename or a hidden fn changes the sentence with it. When the chat's fn setting is "no fns" the guide says so.
- **Static mode's** guide already describes its own tools; it is rewritten from the toolset's refs the same way.
- **Everything else a starting tool is for** is said by the injected item that brings it (section 4): the item about
  asking the person mid-task brings `hub__ask_user` and explains it; switch the item off for an agent and both go. So
  "you start with seven" can't go stale: there is no list, and each tool's explanation travels with the tool. The
  `hub/chat` payload's `tools` shrinks to what the mode needs (search and load); the rest arrive with their items.

The static toolset's own names follow the one-name rule (asked): its tools are the hub fns they are,
`hub__fns_search`, `hub__ctx_search`, `hub__inspect`, `hub__load`, `hub__unload`, plus `run`, which is not a fn. Then an
injected item reads the same in both modes, and the small model never meets `find` as a second name for
`hub__fns_search`. It costs one more tool (six instead of five) for the ctx split.

### 3. ctx fns

**`hub/ctx_search` finds context; `hub/fns_search` finds fns only.** Fns do things; context holds information. They
share the one search service (words, meaning, niches, the admin's search decisions and search-load), split by item:

- `hub/fns_search`: `text`, `systems`, `instance`, `visibility`, `types`, `modes`, `effects`, `names`, `niches`,
  `available`, `order`, `offset`, `limit`, and `kinds`. `items` goes. `kinds` stays for a person who asks for a kind
  ("my saved queries"), and its description says so: "Leave `kinds` out unless the person asks for a kind of fn by
  name: you can't know how a fn was made, and a search by what it does finds every kind." The guide and the examples
  stop showing `kinds`.
- `hub/ctx_search`: `text`, `systems`, `origins` (`system`, `memory`, `resource`), `scopes` (a memory's `session`,
  `user`, `everyone`), `tags`, `names`, `niches`, `order`, `offset`, `limit`. Its hits are today's context hits.
- The admin's search decisions are already apart (`fnsSearchDecision`, `contextSearchDecision`): each now belongs to
  its own fn. Search-load loads fns from `fns_search` and context from `ctx_search`.

**Every context fn says `ctx`:**

| Today | Renamed |
|---|---|
| `hub/load_context` | `hub/load_ctx` |
| `hub/context_crawl` | `hub/ctx_crawl` |
| `hub/context_get` | `hub/ctx_get` |
| `hub/context_from_resource` | `hub/ctx_from_resource` |
| `hub/context_link` | `hub/ctx_link` |
| `hub/context_unlink` | `hub/ctx_unlink` |
| (new) | `hub/ctx_search` |
| (new: tools mode has no way to put context down) | `hub/drop_ctx`, beside `hub/drop_fns` |

The memory fns (`hub/remember`, `hub/forget`, `hub/memory_update`) name memories, not "context", so they keep their
names. The static toolset's `hub/inspect`, `hub/load` and `hub/unload` take fns and context alike and keep theirs. The
cards' tags follow the fns, so the model reads one word: `<ctx key title>`, `<loaded_ctx>`, `<refused_ctx>`,
`<more_ctx>`, `<suggested_ctx>`, `<crawled_ctx>`, `<skipped_ctx>`. The prose word stays "context". The hub's query
list `contexts`, the `@` mention provider and the web endpoints are not model names and stay.

**Back-compat.** A clean rename: the TypeScript refs (`hub.fns.load_context`) become compile errors in every system,
which is the point; the store migration (section 1) rewrites stored names; tests, scenarios and docs move in the same
change; `AUTHORING.md` is regenerated. No aliases, because an alias is a second name the model or a policy could meet.
(Asked.)

### 4. Injected context

**What it is.** A context item that declares `inject` goes into the system prompt of the agents it names, in their
`{{injectedContext}}` section, once an admin has approved it, unless an admin switches it off for an agent. Any system
can inject, the hub included. It replaces `alwaysFor` (asked).

**Declaring it** (the SDK, `shared/`):

```ts
// systems/input/shared/index.ts
.with(({ fns }) => ({
  context: {
    asking: context({
      title: 'Forms',
      description: 'When and how to ask the person with a form.',
      summary: `For several typed details, show a form (${fns.get_input}), then end your turn; the answers come back in <input-answer>.`,
      content: [
        `A **form** asks for several typed fields at once. Make one with ${fns.get_input}, or ask one typed question with ${fns.ask_text}.`,
        'Forms are saved fns: the same form can be shown again another time.',
        'After showing a form, end your turn without answering for the person. Their answers arrive as their next message, inside `<input-answer>`, whenever they send it.',
      ].join('\n'),
      fns: [fns.get_input],
      inject: { into: ['chat'], order: 40 },
    }),
  },
}))
```

The same in a context file's header (`context/asking.md`): `inject: { into: [chat], order: 40 }`.

- **`into`** names the agents: agent refs (`hub.fns.chat`, `crm.fns.reviewer`, typed so only `hub/llm` fns compile), or
  `'chat'`, every agent tagged `chat` (the hub's `hub/chat` and `hub/chat_small` are; a system's agent that answers
  chats opts in with the tag). A target may say `detail: 'summary'`, so one item serves a big prompt in full and a
  small one by its summary: `into: [hub.fns.chat, { agent: hub.fns.chat_small, detail: 'summary' }]`. (Asked: refs
  only, refs and `'chat'`, or refs and any tag.)
- **`order`**: lower comes first; default 100. The hub's own items sit at 10 to 30.
- **What it brings.** Its `fns` join the agent's starting tools (subject to the chat's fn setting and policies, as
  today's brought fns), so a tool and its explanation travel together. An item whose brought fns all can't be used
  (off, held, beyond the fn setting) is left out with that reason: its text would describe something the agent can't
  do. `requires` names fns it mentions without bringing (default: its `fns`); it is left out unless they can be used
  too. Imports are not followed for injection: an injected item is one block of text.
- **`mode`**: `'tools'` or `'static'`, for the rare item that is true in one chat mode only (asked). Names already
  render the same in both modes, so most items need no mode.
- **Static or dynamic.** A static item's text is fixed by its contract. A dynamic one (written by its system) is asked
  for at the start of each turn and kept while it says the same; the review flags it ("its text can change each turn,
  which breaks prompt caching when it does").
- **Hub-made context** (memories, context made from a resource) can inject only when an admin sets it by hand, as
  `alwaysFor` is guarded today (`guardReach`): a model can never write text that lands in every later prompt.

**Where it goes in the agent.** An agent's instructions (Handlebars, as today) may hold `{{injectedContext}}` where the
section goes; without it the section comes straight after the instructions. The hub fills it itself (not as an
escaped Handlebars value). Each item is written as its title as a heading, then its text at the detail chosen, in
order; nothing else wraps it, so it reads as the agent's own instructions. A chat's own system prompt
(`Session.instructions`) follows the same rule. An agent that wants none says `injected: 'none'`.

```ts
agent({
  description: 'Reviews a change for correctness.',
  instructions: 'You review code changes.\n\n{{injectedContext}}\n\nAnswer with a list of findings.',
  injected: { maxTokens: 1500 },   // or 'none'
  // …
});
```

**Approval.** A system's injection is part of its contract, so a new or changed injection (a new item with `inject`,
or a change to an injected item's text, summary, targets, order, mode or brought fns) waits in the system's Pending
review like any change, as its own card, approved or declined on its own. The review summary gains a risk flag,
`injects`: "Changes what `hub/chat` and `hub/chat_small` are told: + Forms (input/asking, 310 tokens)". The card shows
the text as a word diff and the agents it reaches. An item added at runtime (`ctx.add`, the dev watcher) waits the same
way. The hub's own items are not reviewed (the hub isn't), but they are listed and switchable like any. (Asked: per
change, or per change and per agent.)

**The admin's view.** On a `hub/llm` fn's page (and its fn modal, for admins) a new **Injected** tab lists, in order,
each item that targets it: its system (a pill), title, key, the text at the detail it gets, tokens, order, state (on,
off, waiting for review, declined, or left out with why: system off, fns can't be used, wrong mode, didn't fit) and a
switch. Switching one off is per agent, per item, recorded like other switches (who, when) in a new table,
`injectionSettings`; an admin may also give it another order for that agent. A total line says how many tokens the
section takes and which of the hub's models it fits. The context item's own page lists the agents it is injected into,
with the same switches. In chat both are hub fns for admins (`hub/injections_list`, `hub/injection_set`), as every
admin setting is.

**Tokens.** The section is part of the prompt's fixed part: the planner counts it in `head` with the instructions, and
the run inspector names it ("2,210 fixed: 180 instructions, 1,840 injected, 190 systems…"). An agent may cap it
(`injected.maxTokens`). When the fixed part doesn't fit the model (or passes the cap), items fall back from the highest
order down: first to their summary, then to a one-line listing under `<more_ctx>` (loadable with `hub__load_ctx`),
then out. Each fallback is in the selection report's `cut`, and the Injected tab shows it as "didn't fit" for that
model. Never cut silently.

**Caching.** The section sits right after the instructions, so it is part of the cached prefix and must stay the same
from step to step: it is worked out at the start of a turn, never between steps. The recommended rule (asked): the
fixed region (instructions, injected section, `<systems>` list) is rebuilt at a turn only when what it would say has
changed (a system went off, an admin switched an item, an approval landed). A change costs one cache miss, and the
message still carries `<systems_changed>`, so the model is told why. The alternative is today's snapshot: keep the
chat's first-turn region for its whole life, which caches forever but keeps the text of a system that went away.

**With the contextors.** An injected item is in the prompt for every contextor (plain, suggest, graph), so each treats
it as loaded: it is never suggested, never loaded for you, never chosen again by the graph, and a search hit for it
says it is in the prompt. The graph contextor's shares are planned after the fixed part, so injection takes room from
history and context, not the other way round.

**With `<systems_changed>`.** A system that goes off takes its items (and the fns they brought) out at the next turn;
one that comes on adds its approved items at the next turn. Hooks' block docs (section 6) go the same way.

### 5. What becomes injected context

The rule: the hub agent's own instructions say what is true of every chat whatever is installed; hub features an
admin could hide, or that bring a tool, are the hub's injected items; anything about one system is that system's item.
A system that isn't there leaves no trace.

**`CHAT_BASE`, section by section:**

| Today's section | Where it goes |
|---|---|
| Where you are (WHO) | Core instructions, as is. |
| Fns: fn = tool, JSON args, results | Core. |
| Fns: `system/name`, `__` and `--` | Deleted. |
| Fns: "You start with seven…", load then call, `loaded` pages | The tools mode's guide, from its own refs (section 2). |
| Fns: descriptions end with examples; `hub/fn_examples` | Hub item **Examples** (brings `hub/fn_examples`). |
| Fns: modes and the chat's fn setting | Core. The sentence on web search, page reads and crawls being reads goes to the **web** system's item. |
| Fns: approvals; every call is a run | Core. |
| Kinds: native, `hub/llm` | Core keeps one line: some fns are agents. The rest goes. |
| Kinds: system kinds, making a lasting fn, reuse first | Hub item **Saved fns**: what a saved fn is, that it lasts, belongs to its person and can be shared; search for one by what it does before making one; load and call the new one, since a preview is not the answer. Each kind's own words (what it makes, its maker fn) go to its system: **database** (saved queries, tables), **input** (forms), **widgets** (charts and views), **code** (calculations), **api** (requests to web services). |
| Systems: what a system is, the `<systems>` list, going on and off, reviews | Core, without the example list of systems ("files, a database, forms…"). |
| Context: a context item, `hub__ctx_search`, `hub__load_ctx`, guides first, choices | Core: loading context is part of every mode. |
| Context: resources | Hub item **Resources** (brings `hub/search_resources`, `hub/resource_read`; requires `hub/resource_outline`, `hub/resource_send`). |
| Context: memory, scopes, "memories are not shown", correcting; earlier chats | Hub item **Memory** (brings `hub/remember`; requires `hub/ctx_search`, `hub/forget`, `hub/memory_update`) and **Earlier chats** (brings `hub/sessions_list`, `hub/session_messages`). |
| Asking: in your answer | Core. |
| Asking: forms | **input**'s item (above). |
| Asking: `hub/ask_user`, which way to ask | Hub item **Asking mid-task** (brings `hub/ask_user`): when to use it rather than asking in the answer. "Several typed details: a form" is in input's item, so with input absent that advice is never given. |
| Asking: a missing detail is never invented | Core (grounding). "Check memory first" moves to Memory. |
| First moves: keeping track over time | Saved fns (look for one first), with each system's own move in its item (database: a table and its fns; input: a form to add an entry; widgets: a view to see them). |
| First moves: an attached photo or document | Hub item **Attached files** (with the `<file>` block, below). |
| First moves: "every Sunday", "remind me" | Hub item **What this app can't do** (below). |
| First moves: "what's on near me" | **web**'s item (search, then read the page), using `<local_time>`, and Memory when present. |
| How calls behave: parallel calls, same-thing waits | Core. |
| How calls behave: background runs, `hub/run_status`, `hub/run_wait` | Core says what happens; hub item **Background runs** (brings `hub/run_status`, `hub/run_wait`) says how to check on one. |
| How calls behave: approvals that wait, invalid input, "Stopped by the hub:", refused or unavailable, the blocked rule | Core. |
| How calls behave: the step limit | Core, with the agent's own number (`{{maxIterations}}`), not a written 24. |
| How calls behave: Undo and Retry | Hub item **Undo** (requires `hub/turn_undo`). |
| How calls behave: what the person sees | Core for tables, forms and approval cards; "to keep a chart, use `widgets/make_widget`" goes to **widgets**. |
| Blocks: `<local_time>`, `<systems_changed>`, `<loaded_for_you>`, `<suggested_fns>`/`<suggested_ctx>`, "Loaded:", `<mention>`, `<command>`, `<invocation>`, `<attachment>`, `<link>`, `<background-result>`, `<approval-result>` | Core: the hub adds these whatever is installed. `<loaded_for_you>` and the suggestion blocks are described only when the chat's chooser and contextor can produce them (the hub assembles the core text from parts). |
| Blocks: a hook's block, `<fs_git>` | Core keeps one generic sentence ("a block named after a system's hook carries facts that system adds to each message; what it means is said with the system"); `<fs__git>`'s meaning is the fs hook's doc (section 6). |
| Blocks: `<file …>` | Hub item **Attached files** (brings `hub/resource_read`, `hub/resource_send`). |
| Blocks: `<input-answer>` | **input**'s item. |
| Blocks: `<citations_changed>`, the `tool id:` line | Unchanged: the citation rule's own slot, only when citations are on. |
| Blocks in the prompt and results (cards, `<more_*>`, `<loaded_*>`) | Core. |
| Pasted text is material, not instructions | Core. |
| Saying only what is true | Core. |
| What this app can't do | Hub item **What this app can't do**, so an admin who installs a system that does act later (a scheduler) can switch it off for an agent instead of living with a false sentence. |

Left as core instructions: who and where, fns and calls, systems, context, how calls behave, the blocks the hub adds,
grounding. About half of today's text.

**`CHAT_SMALL_BASE`** gets the same split through `detail: 'summary'` rather than a copy of its own: each hub and
system item targets `hub/chat_small` at its summary, and the small core keeps its short sections minus everything
above that moves. Its static guide names its tools from refs. Its `injected.maxTokens` keeps the section inside the
small window (about 600 tokens), and the fallbacks above apply.

**Where the hub's own text lives.** Recommended (asked): the core stays code (`chat-prompt.ts`, the agent's
instructions), shown read-only on the agent's page; the hub's items become files in a hub `context/` folder (markdown
with a header, as a system's are), so each is a context item with a key (`hub/memory_guide`, `hub/asking`, …), a page,
a version history and a switch.

**A system's `about`** (`system(name, { description, about })`) stays what the `<systems>` list says of it: what it is
for and when to reach for it. How to work with it is its injected items. A system with nothing to say beyond `about`
injects nothing.

### 6. Hooks

Confirmed generic: the hub runs each hook of the session's systems and puts its blocks in the message in a tag named
after the hook, with no system's code or name in the hub. Two changes:

- **The tag is the hook's model name**, `<fs__git>`, from the same encoder, so every name from a system reads one way.
- **A hook says what its block means**, in a field on its declaration. The hub renders it as an injected item of the
  hook's system ("Blocks fs adds") into the agents that get the hook's blocks (every chat agent), approved with the
  hook (a changed `explains` is a contract change), shown on the Injected tab as coming from the hook, with its own
  switch (switching the doc off leaves the hook running). The fs text moves out of `CHAT_BASE` into fs:

```ts
hooks: {
  git: hook({
    description: 'Adds the current branch and the changed files.',
    explains: 'The git state of each folder the files system serves: its branch, and the files changed since the last commit. Mention it only when it matters to the request.',
    order: 50,
    timeout: 500,
  }),
},
```

(Asked: a field on the hook, or a context item the system writes.)

### 7. Types

The proposal for approval, written as it would read in the SDK (`packages/sdk/src/declare.ts`, `agent.ts`) and core
(`packages/core/src/manifest.ts`, a new `model-names.ts`, `records/`). `types/sdk.ts` and `types/hub.ts` are the frozen
record of earlier design, so the new shapes are here; once approved they go straight into the zod schemas.

**SDK: declaring an injection**

```ts
/** An agent fn's ref: only `hub/llm` fns fit, so `into` can't name a plain fn. */
export type AgentRef = FnRef<QualifiedName, unknown, unknown, Handlers> & { readonly kind: 'hub/llm' };

/** One agent an injected item goes into, and how much of it. */
export type InjectTarget =
  /** Every agent tagged `chat`: the hub's chat agents, and any system agent that answers chats. */
  | 'chat'
  | AgentRef
  | { readonly agent: AgentRef | 'chat'; /** `summary` for a small prompt. Default `full`. */ readonly detail?: 'full' | 'summary' };

/** Where an item of context is injected. It waits for an admin's approval like any change to the system's contract. */
export interface InjectInput {
  readonly into: readonly InjectTarget[];
  /** Lower comes first. Default 100; the hub's own items are 10 to 30. */
  readonly order?: number;
  /** Fns its text names without bringing them: it is left out unless they can be used. Default: its `fns`. */
  readonly requires?: readonly AnyFnRef[];
  /** Only in this chat mode. Leave it out unless the text is true in one mode only. */
  readonly mode?: 'tools' | 'static';
}

/** What `context()` takes gains `title` and `inject`; `alwaysFor` goes. */
export interface ContextInput<Args extends Record<string, ArgDef<boolean>>> {
  description: string;
  /** What people (and the injected section's heading) call it; its description when absent. */
  title?: string;
  // … command, imports, fns, suggestFns, suggest, visible, tags, weight, summary, parent, next, links, as today …
  /** Put it in these agents' system prompts. */
  inject?: InjectInput;
}

/** What `hook()` takes gains `explains`: the model's reading of its block, injected with its system's items. */
export declare function hook(def: { description: string; explains?: string; order?: number; timeout?: Duration }): HookDef;

/** What `agent()` takes gains `injected`. Its instructions may hold `{{injectedContext}}`; without it the section follows them. */
export interface AgentInjected {
  /** The most tokens the section may take; items past it fall back to their summary, a listing, then out. */
  readonly maxTokens?: number;
}
// agent({ …, injected?: AgentInjected | 'none' })

/** A ref in model-facing text: `${fns.read}` writes `fn:fs/read`, which the hub renders as the model's name. */
export interface FnRef<N extends QualifiedName, A, R, H extends Handlers> { toString(): `fn:${N}`; /* … as today */ }
export interface ContextRef<N extends QualifiedName, A> { toString(): `context:${N}`; /* … as today */ }
```

**Core: the declaration on the wire**

```ts
export const InjectTargetDecl = z.object({
  /** An agent fn's qualified name, or `chat`: every agent tagged `chat`. */
  agent: z.union([QualifiedName, z.literal('chat')]),
  detail: z.enum(['full', 'summary']).default('full'),
});

export const InjectDecl = z.object({
  into: z.array(InjectTargetDecl).min(1),
  order: z.number().int().min(0).max(1000).default(100),
  requires: z.array(QualifiedName).default([]),
  mode: z.enum(['tools', 'static']).optional(),
});
export type InjectDecl = z.infer<typeof InjectDecl>;

// ContextDecl: `alwaysFor` goes; it gains   inject: InjectDecl.optional()
// ContextFileHeader: the same (`inject:` in the YAML header; `into: [chat]` or qualified agent names)
// HookDecl gains                            explains: z.string().min(1).max(2000).optional()
// LlmPayload gains                          injected: z.union([z.literal('none'), z.object({ maxTokens: z.number().int().min(1).optional() })]).optional()
// REVIEW_FLAGS gains 'injects' (after 'write-fns'): "Changes what <agents> are told: <items>".
```

**Core: model names**

```ts
/** The one name the model sees for a fn, context item, type or hook: letters, digits, `_` and `-`, at most 64, starting with a letter. */
export const ModelName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).brand<'ModelName'>();
export type ModelName = z.infer<typeof ModelName>;

/** A local name the model name can carry: dot-separated parts, none holding `__` or starting or ending with `_`. */
export const LocalName = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]|_(?![_.]|$))*(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]|_(?![_.]|$))*)*$/);

/** `/` and `.` as `__`; past 64 characters, cut to 54 and ended with `_x` and 8 hex of the name's sha-256. */
export function modelName(name: QualifiedName): ModelName;

/** The hub's registry of every model name it has given out, for reading one back (no rule reads a cut name back). */
export interface ModelNames {
  /** The qualified name a model name (or, tolerated, a qualified name) means; undefined when it names nothing. */
  qualified(name: string): QualifiedName | undefined;
  /** Text for the model: each `fn:`/`context:` ref and each known qualified name standing alone, as its model name. */
  text(text: string): string;
  /** A value for the model: `g.name()` fields encoded, text fields through `text`. */
  value(value: Json, type: GinTypeDef | undefined): Json;
  /** A value from the model: `g.name()` fields read back. */
  read(value: Json, type: GinTypeDef): Json;
}

// gin gains a text that is a qualified name, so the boundary knows which fields to convert both ways:
//   g.name({ of?: 'fn' | 'context' | 'type' })      (its JSON schema says "a name as your tools spell it")
```

**Hub: records**

```ts
/** An admin's switch (and order) for one injected item in one agent; only rows that differ from the default exist. */
export const InjectionSetting = z.object({
  agent: QualifiedName,
  context: QualifiedName,
  on: z.boolean(),
  order: z.number().int().min(0).max(1000).optional(),
  by: ActorId,
  at: Timestamp,
});

/** Why an injected item isn't in an agent's prompt now. */
export const INJECTION_LEFT_OUT = ['off', 'pending', 'declined', 'system-off', 'fns-unusable', 'mode', 'no-fit'] as const;

/** One injected item as an agent's Injected tab (and `hub/injections_list`) shows it. */
export const InjectionView = z.object({
  agent: QualifiedName,
  context: QualifiedName,
  /** A context item, or a hook's `explains`. */
  source: z.discriminatedUnion('type', [z.object({ type: z.literal('context') }), z.object({ type: z.literal('hook'), hook: QualifiedName })]),
  system: SystemName,
  title: z.string(),
  detail: z.enum(['full', 'summary']),
  /** As the model reads it (names rendered). */
  text: z.string(),
  tokens: z.number().int().min(0),
  order: z.number().int(),
  on: z.boolean(),
  leftOut: z.object({ why: z.enum(INJECTION_LEFT_OUT), reason: z.string() }).optional(),
  switched: z.object({ by: ActorId, at: Timestamp }).optional(),
});

/** What the planner put in the fixed region at a turn, so it is rebuilt only when this changes. */
export const FixedRegionStamp = z.object({ hash: z.string(), injected: z.array(QualifiedName), at: TurnId });
// Session gains   fixed: FixedRegionStamp.optional()

/** Model names the registry gave out whose items are gone, so old calls still read back. */
export const ModelNameHistory = z.object({ model: ModelName, name: QualifiedName, until: Timestamp });
```

**Hub fns (admin, tagged `admin`)**: `hub/injections_list({ agent?, context? }) → InjectionView[]` and
`hub/injection_set({ agent, context, on?, order? }) → InjectionView`. Plus `hub/ctx_search`, `hub/drop_ctx` and the
renames of section 3.

### 8. Building it, after approval

| Slice | What | Touches | Size | Starts |
|---|---|---|---|---|
| A. Model names | `model-names.ts`, the stricter `LocalName`, the registry and its history table, the three boundaries, `g.name()`, MCP names, the web's reader, the store migration of tool names | core primitives; hub contextor/modes, execution/agent, mcp; sdk server/mcp; web chat/logic/inspect; store/migrate | M | first wave |
| B. ctx fns | `ctx_search` split from `fns_search` (two queries on one service), the renames, `drop_ctx`, the tags, search decisions and search-load per fn, the static toolset's names, the migration's rename map | sdk hub.ts; core fn-facts, context-files; hub search, contextor render and modes; every system's refs | M | first wave |
| C. The declaration | `inject` on context and context files, `explains` on hooks, `injected` on agents, `alwaysFor` out, the `injects` flag and its change card, `guardReach` for hub-made context | core manifest, review-summary; sdk declare, agent; hub catalog, review summary | S | first wave |
| D. Text rendering | `modelText` over every authored string, refs' `toString`, the build's check for names that resolve | core; sdk build; hub contextor render | S–M | after A |
| E. The planner | the injected section: targets, `requires`, mode, detail, brought tools, order and switches, the cap and fallbacks, the fixed-region stamp and rebuild rule, contextors treating it as loaded, the inspector's line | hub contextor planner, index, contextors; execution/agent | L | after C (A for names) |
| F. Admin | `injectionSettings`, `hub/injections_list`, `hub/injection_set` and endpoints, the Injected tab on the agent, the agents on the context page | hub api, store; web fns components, context pages | M | after C, beside E |
| G. The prompt split | the core text rewritten; the hub's `context/` items; each system's items (input, database, widgets, code, api, web, fs and its hook's `explains`); a hitloop review of the whole prompt as each agent reads it | sdk chat-prompt; hub context/; systems/*/shared and context/ | M | text beside E; wired after E |
| H. Docs and checks | harness.md (Fns, Sessions and the chat, What gets added, Content), AUTHORING.md, tests, a scenario smoke run before the big e2e | docs, tests, scenarios | S | last |

A, B and C can run in parallel: separate packages, with one shared touch, the store migration, which B adds its rename
map to (B lands after A there, or they share one migration file written by A). D and E need A; E and F need C; G's text
can be written as soon as section 5's split is agreed and is wired once E runs. Roughly three to four working sessions
with agents in parallel, then the prompt review with Phil, then the big e2e.
