# What the harness offers (ground truth for the diagnostician)

This describes the app the chat model works inside, so you can tell what it could have done. It is written for a
reader who has never seen this app. The chat model itself sees none of this page: it sees only its system prompt,
its tool list and the messages. Your job is to compare what it saw with what is true here.

## The big picture

The app is called the harness. One server, the **hub**, runs a chat for a household or a small team. People type
everyday requests ("help me keep track of groceries"). A chat model answers, and it acts by calling tools.

- **Fn** is the harness word for a tool. Every fn has a qualified name `system/name` (`database/create_table`). In
  the model's tool list the slash becomes two underscores (`database__create_table`), because tool names can't hold
  a slash. "Fn" and "tool" are the same thing; the model was trained on "tools" and may not know the word "fn".
- **System** is a separate program connected to the hub that adds fns, guides and data: `fs` (files), `database`,
  `input` (forms), `widgets`, `code`, `api`, `web`, `embedder`. The hub is a system too (`hub/...` fns). The chat's
  system prompt lists the systems with one line each.
- **Run**: one call of a fn. Runs form a tree: a fn may call other fns. **Turn**: one user message and everything it
  caused. **Session**: one chat.
- **The model does not start with every fn.** In this setup (chat mode "tools", contextor "plain") the model starts
  with six hub tools only: `hub/fns_search` (search fns and context), `hub/load_fns` (add fns to its tools from the
  next step on), `hub/load_context` (load a guide or group into the prompt; the fns it brings join the tools),
  `hub/fn_examples` (a fn's example calls), `hub/run_status`, and `hub/ask_user` (ask a plain question and wait).
  Everything else has to be found with `hub/fns_search` and loaded first. A fn that isn't loaded can't be called.
- **Context** is text for the model: guides (`database/guide`, `input/guide`, `widgets/guide`, `code/guide`,
  `api/guide`, `web/guide`, `fs/guide`), API groups (`database/api.tables`, `input/api.forms`, ...: a list of a
  system's fns by topic; loading one brings those fns into the tools), memories (`memory/...`), and pieces of files
  and pages. Loaded context is appended to the system prompt. Context items can bring fns and point to other context.
- **Suggestions**: the hub can add suggested fns and context to a user message (as XML cards) when the admin turns
  suggestions on. With contextor "plain" and suggestions off there are none, and the model must search.
- **Added blocks**: each user message may carry tagged blocks the person didn't type: `<local_time>` (the person's
  time and zone), `<fs_git>` (the files system's git state), `<systems_changed>`, `<input-answer>` (answers to a
  form), suggestion cards. They are information for the model.
- **Search ranks everything together.** `hub/fns_search` searches every fn and context item of every system,
  including the admin and developer ones (system authoring guides, hub API reference). An everyday request can get
  developer docs back first. Its args include `items` (fn / context), `kinds`, `systems`, `match` (text, semantic,
  hybrid).

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
- `hub/save_fn` saves a fn of a system's kind directly; normally systems call it, not the chat model.

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
- `hub/load_context` / `hub/context_get` / `hub/context_crawl` load or read context.

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

A short paragraph: be helpful, use tools, find fns and context with `hub/fns_search`, loading context brings its fns,
load one choice at a time, and stop and say what blocks you when something is refused or keeps failing. Then the
`<systems>` list, one line per system. It does not explain fns, kinds, authoring, forms vs `ask_user`, widgets, or what
can't be done. Whatever else the model knows, it got from tool descriptions, search results and loaded guides.
