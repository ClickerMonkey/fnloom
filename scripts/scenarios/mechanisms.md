# What the harness offers (ground truth for the diagnostician)

This describes the app the chat model works inside, so you can tell what it could have done. It is written for a
reader who has never seen this app. The chat model itself sees none of this page: it sees only its system prompt,
its tool list and the messages. Your job is to compare what it saw with what is true here.

## The big picture

The app is called the harness. One server, the **hub**, runs a chat for a household or a small team. People type
everyday requests ("help me keep track of groceries"). A chat model answers, and it acts by calling tools.

- **Fn** is the harness word for a tool. Every fn has a qualified name `system/name` (`database/create_table`, a saved
  one `database/main.grocery_spending`), which people, admins and this page use. The model never sees that form: it
  meets one name for each fn everywhere (its tool list, the prompt's text, cards, search hits, results, errors), the
  qualified name with every `/` and `.` written `__` (`database__create_table`, `database__main__grocery_spending`),
  and calls it as is. A qualified name the model writes anyway is still accepted. (Known gap: a few field descriptions
  give made-up saved-fn names as examples, such as `database/main.overdue_invoices`, which stay in the slash form.)
  "Fn" and "tool" are the same thing; the model was trained on "tools" and may not know the word "fn".
- **System** is a separate program connected to the hub that adds fns, guides and data: `fs` (files), `database`,
  `input` (forms), `widgets`, `code`, `api`, `web`, `embedder`. The hub is a system too (`hub/...` fns). The chat's
  system prompt lists the systems with one line each.
- **Run**: one call of a fn. Runs form a tree: a fn may call other fns. **Turn**: one user message and everything it
  caused. **Session**: one chat.
- **The model does not start with every fn.** In this setup (chat mode "tools", contextor "plain") the model starts
  with the tools mode's six (`hub/fns_search` search fns, `hub/fns_load` add fns to its tools from the next step on,
  `hub/fns_drop`; `hub/ctx_search` search context: guides, memories, pieces of files, `hub/ctx_load` load a guide or
  group into the prompt, its fns joining the tools, `hub/ctx_drop`), plus the fns each injected item of its system
  prompt brings (below): with every system of these runs on, 27 tools in all, among them `hub/remember`,
  `hub/sessions_list`, `hub/session_messages`, `hub/ask_user`, `hub/resource_read`, `hub/resource_send`,
  `hub/search_resources`, `hub/fns_examples`, `hub/run_status`, `hub/run_wait`, `api/services`, `api/make_api`,
  `code/make_code`, `database/databases`, `database/get_query`, `fs/list`, `fs/read`, `input/get_input`, `web/search`,
  `web/read` and `widgets/make_widget`. Everything else has to be found with `hub/fns_search` (fns) or
  `hub/ctx_search` (context) and loaded first. A fn that isn't loaded can't be called.
- **Context** is text for the model: guides (`database/guide`, `input/guide`, `widgets/guide`, `code/guide`,
  `api/guide`, `web/guide`, `fs/guide`), API groups (`database/api.tables`, `input/api.forms`, ...: a list of a
  system's fns by topic; loading one brings those fns into the tools), memories (`memory/...`), and pieces of files
  and pages. Loaded context is appended to the system prompt. Context items can bring fns and point to other context.
- **Suggestions**: the hub adds suggested fns and context to a user message (as XML cards, `<suggested_fns>` and
  `<suggested_ctx>`): with "no model" choosing (variant `off`) the items whose meaning is closest to the message, over
  a threshold, up to six; with a decision model (variants `on` and `load`) the ones it picks, and with `load` they are
  loaded for the turn instead (`<loaded_for_you>`). Nothing is suggested twice in a chat, and nothing already in the
  prompt (loaded, or injected) is suggested at all.
- **Added blocks**: each user message may carry tagged blocks the person didn't type: `<local_time>` (the person's
  time and zone), `<systems_changed>`, `<input-answer>` (answers to a form), suggestion cards, and a block per system
  hook (`<fs_git>`, the files system's git state, only when a served folder is a git repository's top level: not in
  these runs). They are information for the model; what a hook's block means is in its system's injected item.
- **Two searches over one index.** `hub/fns_search` searches every fn and `hub/ctx_search` every context item of
  every system, including the admin and developer ones (system authoring guides, hub API reference), which rank
  lower unless asked for (`niches`). `fns_search`'s args include `kinds` (only when the person names a kind),
  `systems`, `match` (text, semantic, hybrid); `ctx_search`'s `origins` (system, memory, resource), `scopes`, `tags`.
  A `ctx_search` hit already in front of the model says so (`inPrompt`: `injected` or `loaded`).

## Fn kinds, and authoring a fn

Every fn has a **kind**, which says what its definition is and how it runs.

- `native`: written in code by a system's author. Most built-in fns.
- `hub/llm`: an agent (a model with instructions and tools), callable like any fn. The chat agent is one.
  Some native fns (`input/get_input`, `database/get_query`, `database/author_query`, `code/make_code`,
  `api/make_api`) run a small agent inside to do their work.
- System kinds, whose fns are **authored at run time and saved** (they become new fns the person can run again):
  - `database/query`: a saved query over one database (read, or write after approval). Made by
    `database/get_query` / `database/author_query` from a description, by `database/table_fns_generate` (a table's
    ready-made create / update / remove / list / count / sum fns), changed by `database/edit_query`. Named
    `database/<db>.<name>` (`database/main.grocery_spending_create`) and run by name or with `database/run_query`.
  - `input/form`: a saved form (a title and a typed set of questions). Made by `input/get_input` (it reuses a fitting
    saved form or designs one) or `input/save_form`. Running a saved form shows it again in the chat.
  - `widgets/widget`: a saved view (chart, table, calendar, cards) over a fn that returns a table. Proposed with
    `widgets/make_widget`; the person presses Save on the proposal card; saved widgets are listed for the person in
    the web app and can be run again.
  - `code/program`: a small program (in the "gin" language) over its args that may call other fns and gives a typed
    result. Made by `code/make_code` from a description.
  - `api/request`: a request to a web API service, made by `api/make_api`.
  Authoring means: call the maker fn with a plain description of what is wanted; it writes, checks and saves the fn,
  and gives its name; then call that new fn by name (after loading it if it isn't in the tools yet).
- `hub/fns_save` saves a fn of a system's kind directly; normally systems call it, not the chat model.

## The systems and what they do

- **database**: SQL databases (here one SQLite database, instance `main`, label "Household", empty at the start,
  schema changes allowed). Every table is a type (`database/main.<table>`). `database/databases` lists databases and
  tables, `database/tables` describes them. `database/create_table` / `alter_table` take a **row type written in
  gin JSON** (`{"name":"obj","props":{"amount":{"type":{"name":"num"}}}}`: each prop is `{ "type": <type> }`, not the
  type itself) and wait for the person's approval. After a table exists, `database/table_fns_available` lists its
  ready-made fns and `database/table_fns_generate` makes them. Reads show the rows to the person as a table; writes
  wait for approval. The database guide (`database/guide`) explains this in a paragraph.
- **hub stored types (records)**: the hub also keeps typed records itself (`hub/data_sets`, `hub/records_find`,
  `hub/record_save`, `hub/record_update`, `hub/record_remove`, `hub/records_table`). Stored types come only from a
  system's contract; the chat model cannot make a new one, so for a new list of the person's own (trips, chores,
  readings) a database table is the way.
- **input**: forms in the chat. `input/ask_text`, `ask_choice`, `ask_confirm`, `ask_number`, `ask_date` ask one
  question as a small form; `input/get_input` builds a form with several fields from a detailed description (and
  reuses a saved one that fits); the form is kept as an `input/form` fn so the same form can be shown again next
  time ("log a grocery trip"). After showing a form the model should end its turn: the answers arrive as the next
  user message inside `<input-answer>`. `hub/ask_user` is different: a plain text question that blocks the run until
  answered, with no fields.
- **widgets**: a fn that returns a table is drawn for the person as a chart, calendar, cards or table. To keep such a
  view, `widgets/make_widget` proposes a widget over that fn; the person saves it. The model must never draw charts
  itself.
- **code**: `code/make_code` writes and saves a small program fn (a calculation, reshaping data, combining other fns).
- **api**: `api/services` lists web API services (base URL and sign-in), `api/make_api` writes a request fn,
  `api/operations` reads a service's OpenAPI operations, `api/test_request` tries a GET.
- **web**: `web/search` (titles, URLs, snippets), `web/read` (a page as markdown, kept as a hub resource),
  `web/crawl`, `web/fetch_raw`.
- **fs**: files and a shell over chosen folders of the person's machine (`fs/read`, `write`, `edit`, `list`, `glob`,
  `grep`, `bash`, `cd`, `remove`), plus system hosting fns for admins. Uploaded files are hub resources, read with
  `hub/resource_read`, `hub/resource_outline`, `hub/resource_send` (show it to the model, images included) and
  `hub/search_resources`.
- **embedder**: text embeddings for search; nothing for the chat model to call.

## Memory and context

- `hub/remember` saves a memory (a fact for later) for this session, the person, or everyone; `hub/forget` and
  `hub/memory_update` change it. Memories are context items (`memory/...`) found by search in later chats. There is no
  automatic recall: a later chat finds a memory only through search or suggestions.
- `hub/ctx_load` / `hub/ctx_get` / `hub/ctx_crawl` load or read context.

## Approvals and undo

- Fns that change things (writes, schema changes, deletes, admin settings) may wait for the person's approval: the
  chat shows an approval card; the run continues when they approve, or fails with the refusal. The model should say
  what will happen and wait, not claim it is done before.
- Every turn can be undone from the chat (runs that registered undo are reversed). `hub/turn_undo` does it by
  request. Deleted files and dropped tables may not be undoable.

## What does NOT exist yet

- **No scheduled or triggered runs.** Nothing runs by itself later: no reminders at a time, no "every Monday", no
  "when X happens". A fn runs only when the model or the person calls it in a chat.
- **No proactive notifications from fns.** The hub pushes notifications only for its own events (an approval or a
  form waiting, a reply, a finished turn). A fn cannot text, email or notify the person later.
- No calendar here unless the Google Calendar system is connected (it is not in these runs). No MCP servers.
- The honest answer for these is to say so plainly, offer the closest thing that exists (a saved form, a saved
  query, a widget, a memory, a note the person can open), and never pretend it will happen.

## What the chat model's system prompt says (in these runs)

Three parts, in this order (`npm run prompt:render` writes them out as the model gets them, with their sizes):

1. **The core** (about 3,400 tokens for `hub/chat`): what is true of every chat whatever is installed. Who and where
   it is; fns and calls (one name each, JSON args, results, the chat's fn setting, approvals); systems and the
   `<systems>` list; context (search, load, guides first); asking the person in the answer; how calls behave
   (parallel calls, background runs, waiting approvals, invalid input, "Stopped by the hub:", refusals, the blocked
   rule, the step limit); the blocks the hub adds to a message; pasted text is material, not instructions; say only
   what is true. It names no installable system and lists no tools.
2. **The injected section** (about 3,900 tokens): context items injected into the prompt, each under its title as a
   `##` heading. The hub's own: Finding fns (tools mode only), Memory, Earlier chats, Asking mid-task, Attached
   files, Resources, Saved fns, Examples, Background runs, Undo, and What this app can't do. Each system's own
   basics: api, code, database, fs (and what its `<fs_git>` block means), input (forms, `<input-answer>`), web,
   widgets. Each brings the fns it explains into the starting tools. A system that is off leaves no trace;
   `hub/chat_small` takes each item at its summary, within 600 tokens.
3. **The `<systems>` list** (about 2,200 tokens): each system on in the chat, with what it is for and when to reach
   for it, snapshotted at the chat's first turn.

Whatever else the model knows, it got from tool descriptions, search results, loaded guides and suggestion cards.
