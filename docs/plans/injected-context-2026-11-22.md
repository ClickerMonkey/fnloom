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
   The `system/name` and `.` forms of a fn are never shown to it or explained. People see the friendly label; an admin
   sees the qualified name on hover or click. (Decided: this is for fns only; context keys, types and hook tags keep
   their forms.)
3. **Search by kind is discouraged** unless the person asks for it: the model can't know how a fn was made.
4. **`hub/ctx_search` for context; `hub/fns_search` for fns only.** Fns do things; context holds information. Every
   context fn's name says `ctx`, matching `fns`, and (decided) as a prefix: every hub fn about fns starts `fns_` and
   every one about context starts `ctx_` (`ctx_load`, `ctx_crawl`, `fns_load`, …).
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
schemas, then code. Phil answered the open choices in the hitloop set `injected-context-2026-11-22` (his answers are
under "Decided", below), and this text follows them. The few calls this text still makes on its own are listed at the
end ("Judgement calls for the approval review"), for Phil to look over in the approval review rather than in another
round of questions.

What I read first: `packages/sdk/src/chat-prompt.ts` (today's `CHAT_BASE` and `CHAT_SMALL_BASE`),
`packages/hub/src/contextor/` (the planner's fixed region, the modes, the cards), `packages/hub/src/chat/enrich.ts`
(hooks to blocks), `packages/sdk/src/hub.ts` (the hub's fns), `packages/sdk/src/declare.ts` (`context()`, `hook()`),
`packages/core/src/manifest.ts` (`ContextDecl`), `packages/core/src/primitives.ts` (`toolName`, `fnOfToolName`),
`packages/core/src/modes.ts` (`STATIC_TOOLS`), `packages/sdk/src/server/mcp.ts` (`mcpToolNameOf`) and the providers
aeye talks to (OpenAI, OpenRouter, AWS, Ollama, Replicate; aeye itself passes tool names through untouched). Four
facts shaped it:

- **The model meets three spellings of a fn today, and an MCP client a fourth.** `hub/fns_search` in prose, cards,
  results and `run({ fn })`; `hub__fns_search` as a tool; `database__main--expenses_create` for a dotted name; and an
  MCP client sees `hub_fns_search` (`mcpToolNameOf`). Today's `toolName` is also not one-to-one: it cuts at 64
  characters, and a local name holding `--` reads back as a `.`.
- **Every conversion already goes through two core functions** (`toolName`, `fnOfToolName`), used in five places. One
  module can own the new name.
- **`alwaysFor` already exists** on context ("always loaded for these agents"). It puts an item in the loaded-context
  part of the prompt, not the fixed part; a system's own `alwaysFor` needs no approval of its own, and no admin can
  see per agent what reaches it. Injected context is that idea done properly, so it replaces it.
- **The hook mechanism is generic.** `enrich.ts` runs every hook of the session's systems and names the block after
  the hook (`fs/git` → `<fs_git>`); there is no fs code in the hub. What isn't generic is the prompt text: it names
  `<fs_git>`, `input/…`, `database/…`, `widgets/…` and the web's reads itself.

### 1. One name for the model, for fns

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
always starts with its system's first letter, which is a lowercase letter.

**Fns only.** The model name is for fns, the only names the model calls. Context keys (`fs/guide`), types
(`fs/Entry`) and hook blocks (`<fs_git>`) keep the forms they have today: the model reads them and writes them back as
they are (`hub__ctx_load({ "context": ["database/guide"] })`), they are never tool names, and nothing about them needs
to change.

**One-to-one.** A system name never holds `_`, so the first `__` ends the system. For the rest to read back, a fn's
local name may not hold `__`, and no dot-separated part of it may start or end with `_` (so `a._b` can't be confused
with `a_.b`). The hub refuses such a fn name when a system declares it or a fn is saved, with the reason. The rule is
for fns only; context keys and type names keep today's `LocalName`. None of today's fn names break: no declared fn's
local name holds `__` or starts with `_`. A model name never needs the old `--`.

**Long names.** A model name longer than 64 characters is cut to 54, trailing `_` dropped, and ends in `_x` and the
first 8 hex characters of the qualified name's sha-256 (the last row above). It can't be read back by rule, so reading
back never goes by rule: the hub keeps a **fn name registry**, built from the catalog (every fn, saved fns and methods
included, each encoded once), and turns a model name into a qualified name by looking it up. Two fns that encode the
same (only possible through the hash) are refused when the second is declared or saved. Names that are gone (a
deleted saved fn in an old transcript) stay in the registry's history table, so an old call still reads back for
people.

**Where it is used.** Everywhere the model meets a fn's name, with no exception:

- the tool list (tools mode), and static mode's `run({ "fn": "database__main__expenses_create", … })`;
- every fn card (`<fn name="…">`), the `<more_fns>` list, fn suggestions, the fns of `<loaded_for_you>`,
  `<brought_fns>`, `<loaded_fns>`, `<refused_fns>`, and the fns a context card or a crawl's card says it brings;
- `hub__fns_search`'s hits (`name`), `hub__fns_load`'s `loaded`, and every other result field that holds a fn's name;
- refusals and errors ("`database__create_table` changed and waits for an admin to approve it");
- the `<systems>` list's text, guides, context text, fn descriptions, instructions and examples, hook block docs and
  the injected context below (system names themselves hold no `/` and stay as they are);
- the hub MCP and a system's own MCP face, so an MCP client sees the name a chat model does (today's `system_local`
  goes). An MCP client that allow-listed old names (Claude Code's `mcp__harness__fs_read`) needs its list redone once.

Citations' `tool` is a run id (`run_…`), not a name: unchanged.

**In static mode** the hub fns whose jobs the static tools do are named by their tools (section 2): a mention of
`hub/fns_search` reads `find`, `hub/ctx_search` reads `find_ctx`, `hub/inspect`, `hub/load` and `hub/unload` read
`inspect`, `load` and `unload`, and `hub/fns_load` and `hub/ctx_load` read `load`, `hub/fns_drop` and `hub/ctx_drop`
read `unload`. Every other fn reads as its model name, which is what static mode's `run` takes as `fn`. So one text
reads right in both modes, and an item needs `mode` only when what it says is true in one mode only (section 4).

**Where the conversion happens: one module, three boundaries.** `core/src/model-names.ts` owns the encoder, the rule
check and the registry's interface; nothing else spells a model name. The hub calls it at the only three places a name
crosses to or from the model:

1. **Out, prompt text.** The planner's assembly writes every part of the prompt (instructions, injected context, the
   systems list, the mode's guide, context blocks, cards, and the hook and hub blocks of a user message when it is
   sent) through `text`, which turns each fn it finds into the name the model calls it by in this mode.
2. **Out, results.** The agent loop writes each tool result through `value`: fields whose type says they hold a fn's
   name (a new gin `g.fnName()`, below) are encoded; text fields go through `text`.
3. **In, calls.** The mode's call planning reads a tool name, `run`'s `fn` and every `g.fnName()` field of the args
   back through the registry. A name the registry doesn't know is refused as today, with the closest model names. A
   qualified name the model writes anyway is still accepted (never shown, never asked for), so a model that guesses
   the `/` form isn't punished.

**How authored text names fns** (decided: detect known names automatically, plus typed refs). About 2,600 qualified
names sit in today's descriptions, instructions, examples and context bodies (`hub.ts` and the systems' contracts).
They are not rewritten by hand. `text` finds a fn two ways: an explicit ref (`fn:fs/read`, already the context-file
body syntax the build checks), and a bare qualified name the registry knows as a fn, standing alone (not after `/`,
`:`, `.` or a letter, so `file:///repo/fs/read` and `docs/fs/read.md` are left alone). A bare context key or type
name is already in the model's form and is left as written; a `context:` ref (`${ctx.guide}` writes
`context:fs/guide`) renders as the plain key. Where a name is both a fn's and a context key's, the bare name is read
as the fn and the ref says which is meant. In TypeScript a ref interpolates: `` `Read it first with ${fns.read}.` ``
writes `fn:fs/read`, so a rename is a compile error, not a stale sentence. The SDK's build warns on a bare `x/y` in
model-facing text that names no fn, context item or type it knows (today's broken-link check, widened from context
files to descriptions and instructions).

**People and admins.** Nothing changes for them: the web shows fn pills (friendly label, qualified name on hover,
details on click, admins see everything) wherever it names a fn, and already does in every place listed in "Fn pills".
The LLM call view and the run inspector show the raw request; they read tool names back through the registry
(`fnOfToolName` asks the hub for a cut name) and draw them as pills, while the raw JSON keeps the model name.

**Stored data** (decided: a clean rename with one store migration). Old transcripts hold tool calls named the old way
(`hub__load_context`, `database__main--x`), and sessions hold old qualified names in their tools and context lists.
Nothing of the harness is pushed or published and the only data is the dev hub and scenario runs. One migration
(`store/migrate.ts`) does it all: it rewrites tool-call names in stored transcripts (old rule read back, new rule and
new fn names written); it renames every fn of section 3's table in sessions, policies, grants, item switches, search
decisions, hub MCP rules, examples and runs; and it turns `alwaysFor` on hub-made context (which only an admin could
set) into `inject` with the same agents as exact names, already approved. Model call records (the raw requests) are
history and stay as they were; the web reads the old spelling there through a legacy reader kept for display only.

### 2. The tools the agent starts with

The prompt stops listing them. The tool list is the truth in tools mode, and the mode's guide is the truth for how to
get more:

- **Tools mode** gets a guide (today it has none), written by the mode from its own refs: "Your tools are a few of
  the fns you can use. To use another, find it with `hub__fns_search`, add it with `hub__fns_load` (it is in your
  tools from your next step), then call it. Context is found with `hub__ctx_search` and loaded with `hub__ctx_load`."
  A rename or a hidden fn changes the sentence with it. When the chat's fn setting is "no fns" the guide says so.
  The mode's own tools are the six it needs to manage what is in front of the model: `hub/fns_search`,
  `hub/fns_load`, `hub/fns_drop`, `hub/ctx_search`, `hub/ctx_load` and `hub/ctx_drop`.
- **Static mode** keeps short names for its own tools (decided): `find`, `find_ctx`, `inspect`, `load`, `unload` and
  `run`. `find` is `hub/fns_search` and `find_ctx`, new, is `hub/ctx_search` (the split of section 3); `inspect`,
  `load` and `unload` are `hub/inspect`, `hub/load` and `hub/unload` and take fns and context alike; `run` is not a
  fn, it runs the fn it names by its model name. Its guide is rewritten from the toolset's refs, so it names the six
  tools as they are. A hub MCP's static tools gain `find_ctx` the same way: `find`, `find_ctx`, `inspect`, `run`.
- **Everything else a starting tool is for** is said by the injected item that brings it (section 4, decided): the
  item about asking the person mid-task brings `hub/ask_user` and explains it; switch the item off for an agent and
  both go. So "you start with seven" can't go stale: there is no list, and each tool's explanation travels with the
  tool. The `hub/chat` payload's `tools` shrinks to the mode's own six; the rest (`hub/fns_examples`,
  `hub/run_status`, `hub/run_wait`, `hub/ask_user`) arrive with their items.

### 3. ctx fns, and one prefix for each

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

**The prefix rule** (Phil: "all ctx or fns tools use that as prefix so load_ctx is ctx_load for consistency"). Every
hub fn that is about fns starts `fns_`, and every hub fn that is about context starts `ctx_`. A fn is "about fns" when
what it takes or gives is fns themselves (finding, loading, dropping, reading, saving one, its examples, how it has
been doing), and "about context" when it is context items (finding, loading, dropping, reading, crawling, making and
linking them, and where they are injected). A fn about runs, memories, resources, sessions, systems, types, models,
people or settings keeps its own family's name. The model then sees two families that sort together in its tool list:
`hub__fns_search`, `hub__fns_load`, `hub__fns_drop`; `hub__ctx_search`, `hub__ctx_load`, `hub__ctx_drop`.

**Renamed:**

| Today | Renamed | About |
|---|---|---|
| `hub/load_fns` | `hub/fns_load` | fns |
| `hub/drop_fns` | `hub/fns_drop` | fns |
| `hub/fns_search` | `hub/fns_search` (unchanged; it finds fns only now) | fns |
| `hub/fn_examples` | `hub/fns_examples` | fns |
| `hub/fn_get` | `hub/fns_get` | fns |
| `hub/save_fn` | `hub/fns_save` | fns |
| `hub/fn_metrics` | `hub/fns_metrics` | fns |
| (new) | `hub/ctx_search` | context |
| `hub/load_context` | `hub/ctx_load` | context |
| (new: tools mode has no way to put context down) | `hub/ctx_drop` | context |
| `hub/context_get` | `hub/ctx_get` | context |
| `hub/context_crawl` | `hub/ctx_crawl` | context |
| `hub/context_from_resource` | `hub/ctx_from_resource` | context |
| `hub/context_link` | `hub/ctx_link` | context |
| `hub/context_unlink` | `hub/ctx_unlink` | context |
| (new, admin) | `hub/ctx_injections_list` | context: what is injected where |
| (new, admin) | `hub/ctx_injection_set` | context: switch or reorder one injection for one agent |

**Kept, with why** (each a judgement call, listed again at the end):

| Fn | Why it keeps its name |
|---|---|
| `hub/inspect`, `hub/load`, `hub/unload` | The static tools' fns: they take fns and context alike, and static mode shows them as `inspect`, `load`, `unload` (decided). In tools mode they stay available under their model names. |
| `hub/remember`, `hub/forget`, `hub/memory_update` | About memories. A memory is stored as context, but the fns name what the person thinks of ("remember this"), and `ctx_search` with `origins: ['memory']` already finds them. |
| `hub/system_fns` | About one system: it sits with `hub/systems_list`, `hub/system_get` and `hub/system_logs`. It lists that system's fns, so `fns_of_system` is the alternative. |
| `hub/types_get` | About types. |
| `hub/item_versions`, `hub/switch_item` (admin) | About any item (fn, context, type, kind, command…), not fns or context alone. |
| `hub/search_decision_get`/`_set`, `hub/suggest_decision_get`/`_set` (admin) | Settings of the search and suggestion services, which cover fns and context both; the decision for each search fn is a field. |
| `hub/read_table`, `hub/visuals`, `hub/row_actions` | Hidden fns the widgets system calls (`visibility: 'none'`); `read_table` runs a fn rather than being about one. |
| `hub/search_resources` and every `hub/resource_*` | About resources. (`search_resources` is out of step with `resource_*`; not part of this change.) |
| `hub/run_*`, `hub/runs_list`, `hub/llm_call`, `hub/model_calls`, `hub/session_*`, `hub/sessions_list`, `hub/turn_undo`, the data, explorer and admin fns | About runs, model calls, sessions, records, files, people and settings. |

Not fns, so not renamed: the query lists `fns` and `contexts`, the `@` mention providers `hub/fns` and `hub/context`,
and the web endpoints.

**Card and result tags.** Tags are read, not called, so they keep the reading order they have and only say `ctx`
where they say `context`, so the model meets one word for each family:

| Today | Now |
|---|---|
| `<fn>`, `<loaded_fns>`, `<brought_fns>`, `<refused_fns>`, `<more_fns>`, `<suggested_fns>`, `<more_examples>`, `<loaded_for_you>` | unchanged |
| `<context key title>` | `<ctx key title>` |
| `<loaded_context>` | `<loaded_ctx>` |
| `<refused_context>` | `<refused_ctx>` |
| `<more_context>` | `<more_ctx>` |
| `<suggested_context>` | `<suggested_ctx>` |
| `<crawled_context>` | `<crawled_ctx>` |
| `<skipped_context>` | `<skipped_ctx>` |

The prose word stays "context".

**Back-compat** (decided: clean rename, one store migration). The TypeScript refs (`hub.fns.load_context`) become
compile errors in every system, which is the point; the store migration (section 1) rewrites stored names; tests,
scenarios and docs move in the same change; `AUTHORING.md` is regenerated. No aliases, because an alias is a second
name the model or a policy could meet.

### 4. Injected context

**What it is.** A context item that declares `inject` goes into the system prompt of the agents it targets, in their
`{{injectedContext}}` section, once an admin has approved it, unless an admin switches it off for an agent. Any system
can inject, the hub included. It replaces `alwaysFor` (decided).

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
      inject: { into: ['hub/chat*'], order: 40 },
    }),
  },
}))
```

The same in a context file's header (`context/asking.md`): `inject: { into: ['hub/chat*'], order: 40 }`.

**Targeting** (decided: "a simple format with asterisks for wildcard like functionality"). `into` is a list of
targets, each an agent's ref or a pattern over agents' qualified names:

- `'*'` alone is every agent.
- Any other pattern is `system/local`, with exactly one `/`. Each side is a name, or a name with `*` in it. A `*`
  stands for any run of characters, none included, on its own side of the `/`: it crosses `.` (so `crm/*` takes
  `crm/reviewer` and a saved agent `crm/main.reviewer`) and never crosses `/`. `*` is the only special character, and
  `**` is refused ("write one `*`"). Case counts, as it does in every qualified name.
- A target without `*` is one agent's exact name. In TypeScript one agent is named by its ref (`hub.fns.chat`,
  `crm.fns.reviewer`, typed so only `hub/llm` fns compile), and a string without `*` doesn't compile; a context file's
  header holds strings, so there an exact name is written out and checked by the build.
- Examples: `hub/chat*` is `hub/chat` and `hub/chat_small`; `crm/*` is every agent of crm; `*/review*` is every
  system's agents whose names start `review`.
- In TypeScript, patterns can be built from refs, so a rename breaks the build instead of the match:
  `agents.startingWith(hub.fns.chat)` is `hub/chat*`, `agents.of(crm)` is `crm/*`, `agents.all` is `*`. A plain
  pattern string is still fine, typed so it must hold a `*`, for agents of systems the item's system doesn't depend
  on.
- A target is matched only against `hub/llm` fns (agents, saved agents included), never a plain fn, and against the
  agents the hub has at the time, so an agent installed later receives the items whose patterns it matches as soon as
  it arrives (its own system's review lists what it will be told, and its Injected tab has the switches).
- **Checked at manifest time.** The zod schema checks a target's shape. The SDK's build and the hub, when a system
  declares an item, refuse an exact name that is no agent ("`crm/reviewr` is not an agent"), and accept a pattern that
  hits no agent now with a warning on its review card ("hits no agent yet").
- **The admin sees what a pattern hits**: the review card lists each target with the agents it hits now; the context
  item's page lists its targets, each with its agents and their switches; and an agent's Injected tab says, for each
  item, which target took it in (`hub/chat*`).

There is no per-target detail. The agent says how much it takes (`injected.detail: 'summary'` on `hub/chat_small`),
so one target, `hub/chat*`, serves the big chat agent in full and the small one by its summary, and an item never has
to name each chat agent twice. The `'chat'` tag of the earlier draft goes.

- **`order`**: lower comes first; default 100. The hub's own items sit at 10 to 30.
- **What it brings** (decided). Its `fns` join the agent's starting tools (subject to the chat's fn setting and
  policies, as today's brought fns), so a tool and its explanation travel together. An item whose brought fns all
  can't be used (off, held, beyond the fn setting) is left out with that reason: its text would describe something
  the agent can't do. `requires` names fns it mentions without bringing (default: its `fns`); it is left out unless
  they can be used too. Imports are not followed for injection: an injected item is one block of text.
- **`mode`** (decided): one text by default; an item may say `mode: 'tools'` or `mode: 'static'` when what it says is
  true in one chat mode only. Fn names already render right in both modes (section 1), so most items need no mode.
- **Static or dynamic.** A static item's text is fixed by its contract. A dynamic one (written by its system) is asked
  for at the start of each turn and kept while it says the same; the review flags it ("its text can change each turn,
  which breaks prompt caching when it does").
- **Hub-made context** (memories, context made from a resource) can inject only when an admin sets it by hand, as
  `alwaysFor` is guarded today (`guardReach`): a model can never write text that lands in every later prompt.

**Where it goes in the agent.** An agent's instructions (Handlebars, as today) may hold `{{injectedContext}}` where the
section goes; without it the section comes straight after the instructions. The hub fills it itself (not as an
escaped Handlebars value). Each item is written as its title as a heading, then its text at the agent's detail, in
order; nothing else wraps it, so it reads as the agent's own instructions. A chat's own system prompt
(`Session.instructions`) follows the same rule. An agent that wants none says `injected: 'none'`.

```ts
agent({
  description: 'Reviews a change for correctness.',
  instructions: 'You review code changes.\n\n{{injectedContext}}\n\nAnswer with a list of findings.',
  injected: { maxTokens: 1500 },   // or { detail: 'summary', maxTokens: 600 }, or 'none'
  // …
});
```

**Approval** (decided: each new or changed injection is its own card in the system's Pending review). A system's
injection is part of its contract, so a new or changed injection (a new item with `inject`, or a change to an injected
item's text, summary, targets, order, mode or brought fns) waits in the system's Pending review like any change, as
its own card, approved or declined on its own. The review summary gains a risk flag, `injects`: "Changes what
`hub/chat` and `hub/chat_small` are told: + Forms (input/asking, 310 tokens)". The card shows the text as a word diff,
each target and the agents it hits now. An item added at runtime (`ctx.add`, the dev watcher) waits the same way. The
hub's own items are not reviewed (the hub isn't), but they are listed and switchable like any.

**The admin's view.** On a `hub/llm` fn's page (and its fn modal, for admins) a new **Injected** tab lists, in order,
each item that reaches it: its system (a pill), title, key, the target that took it in, the text at the detail it
gets, tokens, order, state (on, off, waiting for review, declined, or left out with why: system off, fns can't be
used, wrong mode, didn't fit) and a switch. Switching one off is per agent, per item, recorded like other switches
(who, when) in a new table, `injectionSettings`; an admin may also give it another order for that agent. A total line
says how many tokens the section takes and which of the hub's models it fits. The context item's own page lists its
targets and the agents each hits, with the same switches. In chat both are hub fns for admins
(`hub/ctx_injections_list`, `hub/ctx_injection_set`), as every admin setting is.

**Tokens.** The section is part of the prompt's fixed part: the planner counts it in `head` with the instructions, and
the run inspector names it ("2,210 fixed: 180 instructions, 1,840 injected, 190 systems…"). An agent may cap it
(`injected.maxTokens`). When the fixed part doesn't fit the model (or passes the cap), items fall back from the highest
order down: first to their summary, then to a one-line listing under `<more_ctx>` (loadable with `hub__ctx_load`),
then out. Each fallback is in the selection report's `cut`, and the Injected tab shows it as "didn't fit" for that
model. Never cut silently.

**Caching** (decided: rebuild at the next turn, only when something changed). The section sits right after the
instructions, so it is part of the cached prefix and must stay the same from step to step: it is worked out at the
start of a turn, never between steps. The fixed region (instructions, injected section, `<systems>` list) is rebuilt
at a turn only when what it would say has changed (a system went off, an admin switched an item, an approval landed,
a dynamic item's text changed). The planner keeps a stamp of the last region it built (a hash and the items in it) on
the session and compares at each turn. A change costs one cache miss, and the message still carries
`<systems_changed>`, so the model is told why.

**With the contextors.** An injected item is in the prompt for every contextor (plain, suggest, graph), so each treats
it as loaded: it is never suggested, never loaded for you, never chosen again by the graph, and a `hub__ctx_search`
hit for it says it is in the prompt. The graph contextor's shares are planned after the fixed part, so injection takes
room from history and context, not the other way round.

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
| Fns: descriptions end with examples; `hub/fn_examples` | Hub item **Examples** (brings `hub/fns_examples`). |
| Fns: modes and the chat's fn setting | Core. The sentence on web search, page reads and crawls being reads goes to the **web** system's item. |
| Fns: approvals; every call is a run | Core. |
| Kinds: native, `hub/llm` | Core keeps one line: some fns are agents. The rest goes. |
| Kinds: system kinds, making a lasting fn, reuse first | Hub item **Saved fns** (requires `hub/fns_search`, `hub/fns_get`): what a saved fn is, that it lasts, belongs to its person and can be shared; search for one by what it does before making one; load and call the new one, since a preview is not the answer. Each kind's own words (what it makes, its maker fn) go to its system: **database** (saved queries, tables), **input** (forms), **widgets** (charts and views), **code** (calculations), **api** (requests to web services). |
| Systems: what a system is, the `<systems>` list, going on and off, reviews | Core, without the example list of systems ("files, a database, forms…"). |
| Context: a context item, `hub__ctx_search`, `hub__ctx_load`, guides first, choices | Core: loading context is part of every mode. |
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
| Blocks: a hook's block, `<fs_git>` | Core keeps one generic sentence ("a block named after a system's hook carries facts that system adds to each message; what it means is said with the system"); `<fs_git>`'s meaning is the fs hook's `explains` (section 6). |
| Blocks: `<file …>` | Hub item **Attached files** (brings `hub/resource_read`, `hub/resource_send`). |
| Blocks: `<input-answer>` | **input**'s item. |
| Blocks: `<citations_changed>`, the `tool id:` line | Unchanged: the citation rule's own slot, only when citations are on. |
| Blocks in the prompt and results (cards, `<more_*>`, `<loaded_*>`) | Core. |
| Pasted text is material, not instructions | Core. |
| Saying only what is true | Core. |
| What this app can't do | Hub item **What this app can't do**, so an admin who installs a system that does act later (a scheduler) can switch it off for an agent instead of living with a false sentence. |

Left as core instructions: who and where, fns and calls, systems, context, how calls behave, the blocks the hub adds,
grounding. About half of today's text.

**`CHAT_SMALL_BASE`** gets the same split rather than a copy of its own: every hub and system item targets
`hub/chat*`, and `hub/chat_small` takes them at their summaries (`injected: { detail: 'summary', maxTokens: 600 }`),
which keeps the section inside the small window; the fallbacks above apply. The small core keeps its short sections
minus everything above that moves. Its static guide names its six tools from refs.

**Where the hub's own text lives** (decided: minimal core in code; the hub's features as hub context files). The core
stays code (`chat-prompt.ts`, the agent's instructions), shown read-only on the agent's page. The hub's items become
files in a hub `context/` folder (markdown with a header, as a system's are), so each is a context item with a key
(`hub/memory_guide`, `hub/asking`, …), a page, a version history and a switch.

**A system's `about`** (`system(name, { description, about })`) stays what the `<systems>` list says of it: what it is
for and when to reach for it. How to work with it is its injected items. A system with nothing to say beyond `about`
injects nothing.

### 6. Hooks

Confirmed generic: the hub runs each hook of the session's systems and puts its blocks in the message in a tag named
after the hook, with no system's code or name in the hub. The tag keeps today's form (`fs/git` → `<fs_git>`; model
names are for fns only). One change:

- **A hook says what its block means** (decided: an `explains` field on `hook()`). The hub renders it as an injected
  item of the hook's system ("Blocks fs adds") into the agents that get the hook's blocks (the session's agent), with
  the system's other items. It is approved with the hook (a new or changed `explains` is a contract change, its own
  card like any injection), shown on the Injected tab as coming from the hook, with its own switch (switching the doc
  off leaves the hook running). The fs text moves out of `CHAT_BASE` into fs:

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

### 7. Types

The final types for approval, written as they would read in the SDK (`packages/sdk/src/declare.ts`, `agent.ts`,
`gin.ts`) and core (`packages/core/src/manifest.ts`, a new `model-names.ts`, `records/`). `types/sdk.ts` and
`types/hub.ts` are the frozen record of earlier design, so the new shapes are here; once approved they go straight
into the zod schemas. There is one source of each type: the SDK's are written against core's (`QualifiedName`,
`SystemName`), and core's zod schemas are what the hub, the store and the web read.

**SDK: declaring an injection** (`packages/sdk/src/declare.ts`)

```ts
/** An agent fn's ref: only `hub/llm` fns fit, so a plain fn can't be a target. */
export type AgentRef<N extends QualifiedName = QualifiedName> = FnRef<N, unknown, unknown, Handlers> & { readonly kind: 'hub/llm' };

/**
 * Agents by a pattern over their qualified names. `*` alone is every agent; any other pattern is `system/local`, where
 * each `*` stands for any run of characters (none included) on its own side of the `/`: it crosses `.`, never `/`.
 * Case counts. A string without `*` doesn't compile: one agent is named by its ref.
 */
export type AgentPattern = '*' | `${string}*${string}/${string}` | `${string}/${string}*${string}`;

/** One entry of `inject.into`: an agent's ref, or a pattern. */
export type AgentTarget = AgentRef | AgentPattern;

/** Patterns built from refs, so renaming an agent or a system breaks the build instead of the match. */
export declare const agents: {
  /** Every agent: `*`. */
  readonly all: '*';
  /** Every agent of a system: `agents.of(crm)` is `crm/*`. */
  of<S extends SystemName>(system: { readonly name: S }): `${S}/*`;
  /** Every agent whose name starts with this one's: `agents.startingWith(hub.fns.chat)` is `hub/chat*`. */
  startingWith<N extends QualifiedName>(agent: AgentRef<N>): `${N}*`;
};

/** Where an item of context is injected. It waits for an admin's approval like any change to the system's contract. */
export interface InjectInput {
  /** The agents it goes into. At least one. */
  readonly into: readonly [AgentTarget, ...AgentTarget[]];
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
  /** Put it in these agents' system prompts. Its `fns` join their starting tools. */
  inject?: InjectInput;
}
// ContextDef: `alwaysFor` goes; it gains   readonly title: string | undefined;  readonly inject: InjectInput | undefined;

/** What `hook()` takes gains `explains`: what its block means to the model, injected with its system's items. */
export declare function hook(def: { description: string; explains?: string; order?: number; timeout?: Duration }): HookDef;
// HookDef gains   readonly explains: string | undefined;

/** A ref in model-facing text. `${fns.read}` writes `fn:fs/read`, rendered as the name the model calls it by. */
export interface FnRef<N extends QualifiedName, A, R, H extends Handlers> { toString(): `fn:${N}`; /* … as today */ }
/** `${ctx.guide}` writes `context:fs/guide`, rendered as the key itself (`fs/guide`). */
export interface ContextRef<N extends QualifiedName, A> { toString(): `context:${N}`; /* … as today */ }
```

**SDK: an agent's injected section** (`packages/sdk/src/agent.ts`)

```ts
/** How an agent takes its injected section. Its instructions may hold `{{injectedContext}}`; without it the section follows them. */
export interface AgentInjected {
  /** `summary` gives each item at its summary, for a small window. Default `full`. */
  readonly detail?: 'full' | 'summary';
  /** The most tokens the section may take; items past it fall back to their summary, a listing, then out. */
  readonly maxTokens?: number;
}
// agent({ …, injected?: AgentInjected | 'none' })   (and the same field on a `hub/llm` fn's payload)
```

**SDK: a fn's name as a value** (`packages/sdk/src/gin.ts`)

```ts
/**
 * A text that holds a fn's qualified name. Code and people see `fs/read`; the model sees and writes `fs__read`, and the
 * hub converts it both ways at the boundary. Its JSON schema says "a fn's name, as your tools spell it".
 */
g.fnName(): GinType<QualifiedName>
```

**Core: the declaration on the wire** (`packages/core/src/manifest.ts`)

```ts
/** A target as declared: an agent's exact qualified name, or a pattern (`*`, or `system/local` holding `*`). */
export const AGENT_TARGET_PATTERN = /^(?:\*|[a-z*][a-z0-9*-]*\/[A-Za-z0-9_*][A-Za-z0-9_.*-]*)$/;
export const AgentTargetDecl = z.string()
  .regex(AGENT_TARGET_PATTERN, 'an agent\'s name (crm/reviewer) or a pattern (hub/chat*, crm/*, *)')
  .refine((target) => !target.includes('**'), 'write one *');
export type AgentTargetDecl = z.infer<typeof AgentTargetDecl>;

/** Whether an agent's qualified name is hit by a target: `*` is any run of characters on its side of the `/`. */
export function targetHits(target: AgentTargetDecl, agent: QualifiedName): boolean;

export const InjectDecl = z.object({
  into: z.array(AgentTargetDecl).min(1),
  order: z.number().int().min(0).max(1000).default(100),
  requires: z.array(QualifiedName).default([]),
  mode: z.enum(['tools', 'static']).optional(),
});
export type InjectDecl = z.infer<typeof InjectDecl>;

export const AgentInjected = z.union([
  z.literal('none'),
  z.object({ detail: z.enum(['full', 'summary']).default('full'), maxTokens: z.number().int().min(1).optional() }),
]);

// ContextDecl: `alwaysFor` goes; it gains   inject: InjectDecl.optional()
// ContextFileHeader: the same (`inject:` in the YAML header, `into` as strings: exact agent names or patterns)
// HookDecl gains                            explains: z.string().min(1).max(2000).optional()
// LlmPayload gains                          injected: AgentInjected.optional()
// REVIEW_FLAGS gains 'injects' (after 'write-fns'): "Changes what <agents> are told: <items>".
// STATIC_TOOLS becomes                      ['find', 'find_ctx', 'inspect', 'load', 'unload', 'run']
```

**Core: model names, for fns** (`packages/core/src/model-names.ts`)

```ts
/** The one name the model sees for a fn: letters, digits, `_` and `-`, at most 64, starting with its system's first letter. */
export const ModelFnName = z.string().regex(/^[a-z][A-Za-z0-9_-]{0,63}$/).brand<'ModelFnName'>();
export type ModelFnName = z.infer<typeof ModelFnName>;

/** A fn's local name the model name can carry: dot-separated parts, none holding `__` or starting or ending with `_`. Context keys and types keep `LocalName`. */
export const FnLocalName = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]|_(?![_.]|$))*(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]|_(?![_.]|$))*)*$/);

/** `/` and `.` as `__`; past 64 characters, cut to 54 and ended with `_x` and 8 hex of the name's sha-256. */
export function modelFnName(fn: QualifiedName): ModelFnName;

/** The hub's fn names for one prompt: built from its fn registry (every name it has given out) and the chat's mode. */
export interface ModelFnNames {
  /** The name the model calls this fn by here: its model name, or in static mode the static tool that does its job. */
  name(fn: QualifiedName): string;
  /** The fn a name from the model means (a model name, a static tool's name, or, tolerated, a qualified name); undefined when it names none. */
  fn(name: string): QualifiedName | undefined;
  /** Text for the model: each `fn:` ref and each known fn's qualified name standing alone, as `name` gives it; `context:` refs as the plain key. */
  text(text: string): string;
  /** A value for the model: `g.fnName()` fields as `name` gives them, text fields through `text`. */
  value(value: Json, type: GinTypeDef | undefined): Json;
  /** A value from the model: `g.fnName()` fields read back. */
  read(value: Json, type: GinTypeDef): Json;
}
```

**Hub: records** (`packages/core/src/records/`)

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

/** One injected item as an agent's Injected tab (and `hub/ctx_injections_list`) shows it. */
export const InjectionView = z.object({
  agent: QualifiedName,
  context: QualifiedName,
  /** A context item, or a hook's `explains`. */
  source: z.discriminatedUnion('type', [z.object({ type: z.literal('context') }), z.object({ type: z.literal('hook'), hook: QualifiedName })]),
  system: SystemName,
  /** The target that took it into this agent, as declared (`hub/chat*`, `hub/chat`). */
  via: AgentTargetDecl,
  title: z.string(),
  detail: z.enum(['full', 'summary']),
  /** As the model reads it (fn names rendered). */
  text: z.string(),
  tokens: z.number().int().min(0),
  order: z.number().int(),
  on: z.boolean(),
  leftOut: z.object({ why: z.enum(INJECTION_LEFT_OUT), reason: z.string() }).optional(),
  switched: z.object({ by: ActorId, at: Timestamp }).optional(),
});

/** One target of an item with the agents it hits now: the review card and the item's page show these. */
export const InjectTargetView = z.object({ target: AgentTargetDecl, agents: z.array(QualifiedName) });

/** What `hub/ctx_injections_list` answers: the injections asked for and, for one item, its targets. */
export const InjectionsPage = z.object({ injections: z.array(InjectionView), targets: z.array(InjectTargetView) });

/** What the planner put in the fixed region at a turn, so it is rebuilt only when this changes. */
export const FixedRegionStamp = z.object({ hash: z.string(), injected: z.array(QualifiedName), at: TurnId });
// Session gains   fixed: FixedRegionStamp.optional()

/** Model names the registry gave out whose fns are gone, so old calls still read back. */
export const ModelFnNameHistory = z.object({ model: ModelFnName, fn: QualifiedName, until: Timestamp });
```

**Hub fns.** For admins (tagged `admin`): `hub/ctx_injections_list({ agent?, context? }) → InjectionsPage` and
`hub/ctx_injection_set({ agent, context, on?, order? }) → InjectionView`. For everyone: `hub/ctx_search`,
`hub/ctx_drop`, and the renames of section 3. Every args field that holds a fn's name (`fns_load`'s `fns`,
`fns_examples`' and `fns_metrics`' `fn`, `run`'s `fn`, `read_table`'s `fn`, policies' and decisions' fn fields) is
`g.fnName()`.

### 8. Building it, after approval

| Slice | What | Touches | Size | Starts |
|---|---|---|---|---|
| A. Model names | `model-names.ts` (fns only), `FnLocalName` for declared and saved fns, the registry and its history table, the three boundaries, the static mode's tool names in `name`/`fn`, `g.fnName()`, MCP names, the web's reader, the store migration of tool-call names | core primitives; hub contextor/modes, execution/agent, mcp; sdk gin, server/mcp; web chat/logic/inspect; store/migrate | M | first wave |
| B. ctx and fns fns | `ctx_search` split from `fns_search` (two queries on one service), the prefix-rule renames of section 3 (table above), `ctx_drop`, `find_ctx` in `STATIC_TOOLS` and the MCP's static tools, the tool-mode's six tools in the chat payload, the `ctx` tags, search decisions and search-load per fn, the migration's rename map | sdk hub.ts; core fn-facts, modes, context-files; hub search, contextor render and modes, mcp; every system's refs | M | first wave |
| C. The declaration | `inject` on context and context files with targets and patterns (`AgentTargetDecl`, `targetHits`, the SDK's `AgentPattern` and `agents` helpers), the checks at manifest time, `explains` on hooks, `injected` (detail, cap) on agents, `alwaysFor` out (and migrated), the `injects` flag and its change card with targets and the agents they hit, `guardReach` for hub-made context | core manifest, review-summary; sdk declare, agent, build; hub catalog, review summary | S–M | first wave |
| D. Text rendering | `text` over every authored string (known fns detected, refs rendered, `context:` refs as keys), refs' `toString`, the build's check for names that resolve | core; sdk build; hub contextor render | S–M | after A |
| E. The planner | the injected section: matching targets against agents, `requires`, mode, the agent's detail, brought tools, order and switches, the cap and fallbacks, the fixed-region stamp and rebuild-on-change rule, contextors treating it as loaded, the inspector's line | hub contextor planner, index, contextors; execution/agent | L | after C (A for names) |
| F. Admin | `injectionSettings`, `hub/ctx_injections_list`, `hub/ctx_injection_set` and endpoints, the Injected tab on the agent (with the target that took each in), the targets and their agents on the context page and the review card | hub api, store; web fns components, context pages, review cards | M | after C, beside E |
| G. The prompt split | the minimal core text rewritten in code; the hub's `context/` items targeting `hub/chat*`; `hub/chat_small` at summary detail; each system's items (input, database, widgets, code, api, web, fs and its hook's `explains`); a hitloop review of the whole prompt as each agent reads it | sdk chat-prompt, hub.ts; hub context/; systems/*/shared and context/ | M | text beside E; wired after E |
| H. Docs and checks | harness.md (Fns, Sessions and the chat, What gets added, Content), AUTHORING.md, tests, a scenario smoke run before the big e2e | docs, tests, scenarios | S | last |

A, B and C can run in parallel: separate packages, with one shared touch, the store migration, which B and C add
their maps to (one migration file, written by A, that B adds the rename map to and C the `alwaysFor` step). D and E
need A; E and F need C; G's text can be written as soon as section 5's split is agreed and is wired once E runs.
Roughly three to four working sessions with agents in parallel, then the prompt review with Phil, then the big e2e.

### Judgement calls for the approval review

Calls this text makes on its own, for Phil to look over with the types rather than in another round of questions:

1. **Kept names under the prefix rule**: `hub/inspect`, `hub/load`, `hub/unload` (static tools' fns, for fns and
   context both); `hub/remember`, `hub/forget`, `hub/memory_update` (memories); `hub/system_fns` (a system's;
   `fns_of_system` is the alternative); `hub/item_versions`, `hub/switch_item`, the search and suggestion decision
   fns (any item, both families); `hub/read_table` (runs a fn).
2. **`fn_metrics` → `fns_metrics`**: counted as about fns (it is how fns have been doing), though it reads runs.
3. **Admin injection fns are `ctx_`**: `hub/ctx_injections_list` and `hub/ctx_injection_set`, as injections are
   context reaching agents, rather than the admin family's `injections_list` / `set_injection`.
4. **Tags keep their reading order** and only swap `context` for `ctx` (`<loaded_ctx>`, not `<ctx_loaded>`), since
   tags are read, not called.
5. **Tools mode starts with six tools**, search, load and drop for each family (`hub/fns_*`, `hub/ctx_*`), so
   putting things down is always possible; everything else comes with an injected item.
6. **Pattern semantics**: `*` stays on its side of the `/` and crosses `.`; `*` alone is every agent; case counts;
   an exact name is a ref in TypeScript; a pattern that hits nothing yet is a warning, not a refusal; an agent that
   arrives later and matches gets the item without a new approval (its own system's review shows what it will be
   told).
7. **No per-target detail**: the agent chooses `detail: 'summary'`, so one `hub/chat*` target serves both chat
   agents.
8. **Bare names that are both a fn and a context key** read as the fn; the ref says which is meant.

## Decided (Phil, hitloop set injected-context-2026-11-22, 2026-11-22, verbatim)


### name-format: Which spelling does the model see for every fn, everywhere (tools, `run`, cards, search hits, errors)?

A: `__` between every part

### which-names: Should context keys, types and hook tags use the model format too, or only fns?

Fns only

### static-tools: In static mode (the small models), should `find`, `inspect`, `load` and `unload` be called by their real fn names?

Keep short names (`find`, `find_ctx`, `inspect`, `load`, `unload`, `run`)

### authored-names: About 2,600 `system/name` mentions sit in descriptions, instructions and context. How should they become model names?

Detect known names automatically, plus typed refs

### rename-strategy: How should we roll out the renames (`load_context`→`load_ctx`, `context_crawl`→`ctx_crawl`, `context_get`/`_from_resource`/`_link`/`_unlink`→`ctx_*`, the new `ctx_search` and `drop_ctx`, the `<ctx…>` card tags) and the new name format?

Clean rename with one store migration

> Also a migration so all ctx or fns tools use that as prefix so load_ctx is ctx_load for consistency

### approval: How does an admin approve a system's injected context?

Each new or changed injection is its own card in the system's Pending review

### targeting: How does an injection name the agents it goes into?

Other: A simple format with asterisks for wildcard like functionality 

### brings: Does `inject` replace `alwaysFor`, and do an injected item's fns join the agent's starting tools?

Replace `alwaysFor`; its fns join the starting tools

### core-location: What stays as the chat agent's own instructions, and in what form?

Minimal core in code; the hub's features as hub context files

### mode-text: How should an item whose text has to differ between tools mode and static mode do it?

One text by default; an item may say `mode: 'tools' | 'static'`

### hook-docs: Where does a system say what its hook's block (such as `<fs__git>`) means to the model?

An `explains` field on `hook()`

### caching: When a system goes off, or an admin switches an injection mid-chat, when does the prompt change?

Rebuild at the next turn, only when something changed

## Decided after the prompt render (Phil, hitloop set prompt-render-2026-11-22, 2026-11-22)

- example-names: Encode by rule
- small-fit: The systems list follows the agent's detail
- suggestion-cards: Brief cards
