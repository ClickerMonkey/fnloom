# Build 5: owner feedback

The owner reviewed builds 4 and 5 and gave this feedback. It is part of build 5 and binding. Where it conflicts with
build-5.md or build-5-design.md, this file wins.

## The feedback, verbatim

> - for query and input the saved fns should be in hub and not a local store. In input I saw in memory loading of inputs and vector calculations - all of that should be in hub. Absolutely no load all and in memory vector math - leave that to the database in the hub. The hub should have a fns/context search endpoint with optional ordering by scoring and have filters by kind, system, etc. that should've been used in input.
> - web was doing its own html break down of links - why wasn't aeye/resources used? That's the whole point of the package I created. You reinventing the wheel in code is bothering me, I've made all these libraries for this project - use them. If you find they can't be used tell me why and I will make the decisions.
> - query/input needs to behave like agent in product where it's a prompt with tools (fns). Also the fns are completely void of instructions it feels like. And there are no examples... Fn default should have any number of examples and there should be config to pull a certain number in and also a fn for an llm to get a page of examples for a fn call. Because something like query examples can be quite a lot. And when we get to code that is also going to be a lot. Make sure things are being used as I designed them - don't take shortcuts. Also for examples probably something that could be stored in separate table so it can be semantically searched.
> - file explorer wherever fs system is installed but without saving as resources on the machine
> - Web search produces resources, and reading pages
> - UI should take up full width - looking at resources page. Also has scrolling section within scrolling section. And all resources tree view should be in left sidebar area with its own draggable divider to control width.
> - I tried to open hub-client.ts in resource page and nothing happened
> - dev console error "Type error: Cannot destructure property 'bum' of 'e' as it is null.
> - frontend traffic and logs are sent to hub backend in files that are hub resources that can be read. They are chunked by time and size threshold, so if a log is not received within 5 minutes or something a new file is created on the next log - and it's also tied to the user.
> - fs context should pull in fs fns like bash and write, etc
> - bug where all tool calls like bash don't show up in UI
> - also it asks for approval AND I have to hit run, feels odd
> - make sure build produces js without needing other js deps installed, it should all be bundled in there so it can be scanned for security reasons
> - do we keep track of what types each fn reads/writes like product does? Also it could be marked ready, write, etc. deeply free or not depending on fns it uses and each fn kind maybe dynamically takes a payload and returns approx cost with min and max (based on real run history or if it's like read a file it doesn't cost anything). Also have stats on history of run time so approximate time can be communicated if it's over what we consider a long running fn.
> - chat mode (none, read, write, delete, auto)
> - collapse sequential fn calls into collapsed section that has summary that condenses same fn calls and has most recent first. Maybe a chat option that by default groups and collapses
> - when looking at a fn run in chat or anywhere else I should be able to bring up a model of the fn to get more high level info, runs, stats, etc. or open the page if its not in a modal. But ideally the user wouldn't be taken away from the chat for just investigating... So make the fn page reusable?
> - double blinking terminal square animation thing in the UI should be fixed
> - make sure reasoning, tool calls, content - are displayed in the UI in the exact order the llm produces and seems them. Sometimes looks like it's not
> - add ability to specify auto mode classifier model in admin for system wide config

## What it means (my reading; the owner can overrule)

- **Use the libraries.** aeye and ayepi exist for this project. Never re-implement what they do. If one can't be used
  for something, don't work around it: say why in the report's `libraryGaps`, leave that piece, and the owner decides.
  Read product's design and code (`C:\Users\pdiff\Documents\GitHub\product`) for how things were meant to work, notably
  its agent kind, fn examples, and fn type reads/writes.
- **No local stores in input or database (owner, follow-up):** everything they make is stored in the hub: table
  types are hub types, saved queries and saved forms are hub fns (with their examples and version history in the hub),
  enrichment results live on the hub types (the schema hash is a hub type property), embeddings are hub vectors. The
  systems keep only their own connection config and state dir keys. On start they read what they need from the hub.
- **Systems define types at runtime (owner, follow-up):** any system can add, change and remove types while running
  (not only in its contract), through the SDK and the system link. The hub stores each type with the system (and
  instance) that defined it, its version history, and who may see it; lists, search and the fn facts (types read and
  written) use these stored types. This is how the database system's table types reach the hub.
- **Everything a contract can declare can also be added at runtime (owner, follow-up):** one uniform SDK and link
  API for fns, types, kinds, resources and resource roots, context, commands, renderers/components (incl. registry
  contributions), examples and providers: add, update, remove, with the hub storing each with its defining system and
  instance, version history and visibility, and telling browsers and other systems live. A contract's static entries
  are just the ones known up front; both paths end in the same hub records.
- **Everything shared lives in the hub.** Saved inputs and query fns are hub fns (and their embeddings hub vectors).
  No system keeps its own store of them, loads them all, or does vector math in memory. The hub gets a
  **fns/context search endpoint** (also on the system link and as an LLM fn): text and/or semantic, ordered by score
  optionally, with filters (kind, system, instance, visibility, reads/writes types, mode), paged, done in the hub's
  database (sqlite-vec or whatever the store uses). `get_input`, `get_query` and suggestions use it. Remove the
  in-memory stores and the copied `cosine`/`embedOne`.
- **Agent-style fns:** `get_input`, `get_query` and `edit_query` are agents: a prompt (instructions) with tools (fns:
  search fns, get examples, describe types, run a draft, save), as product's agent kind does, on aeye. Not hard-coded
  pipelines.
- **Fn instructions and examples:** every fn has real instructions (when to use it, how, what it returns, pitfalls),
  written for the model. Every fn can have any number of **examples** (args, and optionally result and a note), stored
  in their own hub table, embedded, searchable. Config sets how many examples go into the prompt with the fn (by
  relevance to the current turn); a hub fn `fn_examples(fn, query?, page)` returns a page of examples. Systems give
  examples in their fn defs; saved query and input fns get examples from their creation.
- **Fn facts like product:** each fn records the types it reads and writes, and its mode (read, write, delete),
  computed deeply: a fn that uses others (agents, code, queries) gets the union of what they do, and whether it's free.
  Each kind can estimate cost from a payload (min, typical, max), from run history when there is some, and zero for
  free work like reading a file. Run-time stats (typical and slow durations) let the chat say "this usually takes about
  N minutes" when a fn is long-running (a tunable threshold).
- **Chat mode:** per session: `none` (no fns), `read`, `write`, `delete`, `auto`. Each allows fns up to that mode.
  `auto` asks a classifier model whether a call should go ahead, as Claude Code's auto mode does. The classifier model
  is set system-wide in admin.
- **Approval once:** when a run needs approval, approving it runs it. No separate Run button after approving.
- **fs:**
  - A **file explorer** in the web app for every fs instance: browse and read files live through the fs system, without
    saving them as resources.
  - Its context pulls in its fns (bash, read, write, edit, …) so suggestions bring them along.
- **Web system:** search results and read pages become resources, using `@aeye/resources` for fetching, converting and
  link extraction (remove the hand-written HTML link parsing).
- **System builds are self-contained:** a system package's built JS bundles all its JS dependencies, so it runs without
  installing others and can be scanned as one artifact. Native addons, if any, are listed.
- **Frontend logs and traffic:** the web app sends its logs and API traffic (method, endpoint, status, duration, no
  bodies or secrets) to the hub. The hub writes them as hub resources, one file per person, rolled over by size and by
  time: a log after 5 minutes of quiet starts a new file. Admins can read them, and the person can read their own.
- **UI fixes:**
  - **Resources page:** use the full width, with no scroll area inside a scroll area. The resource tree goes in the
    left sidebar, with its own draggable divider for its width.
  - **Opening a file:** opening `hub-client.ts` in the resources page did nothing. Fix it, and any similar dead clicks.
  - **Console error:** the dev console shows `Cannot destructure property 'bum' of 'e' as it is null`. Find it and fix
    it. It is a Vue unmount of a component that is already gone.
  - **Missing fn calls:** fn calls like bash don't show in the chat. Fix it.
  - **Order:** reasoning, fn calls and content show in exactly the order the model produced them.
  - **Collapsing:** sequential fn calls collapse into one section. Its summary condenses repeated calls of the same fn
    and lists the most recent first. A chat option, on by default, groups and collapses them.
  - **Fn modal:** from any fn run in chat or elsewhere, open the fn as a modal (summary, stats, runs, examples) without
    leaving the chat, with "open page" for the full page. The fn page and the modal are one reusable component.
  - **Cursor:** fix the double blinking terminal cursor.
