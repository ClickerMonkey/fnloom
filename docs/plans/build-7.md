# Build 7

Build 7 of 7. It starts as soon as build 6 finishes. It is lean: efficient in tokens and time. The owner's standing
rules are in the "Decided" section of `docs/harness.md`.

## The request, verbatim (2026-11-11)

> For query and input and in the future API and code - we need to behave more like product. Where there's a fn to create or edit a query for an example - and that should be passed a description of everything. And then with progressive disclosure we expose types, etc to the llm. The product hid the huge context the main chat llm would need to properly generate a complete query or gin type or gin expression etc - and put all that in a well tested pattern of progressive disclosure and a forced workflow through tools. That's why I wanted aeye usable by systems as is - so we could basically port over that logic and make sure it's well unit tested for the system. Which makes me thing maybe unit tests are a native part of a system as well and we should provide handy functions to preview components isolated in various states for an llm to review, but also do mock fn calls, some reall for llm testing, etc. something that feels native. Queue all this up next

## What it means (my reading; the owner can overrule)

### 1. Authoring fns behave like product's

- **The pattern:** for queries, inputs (gin types), and later APIs and code, the chat model calls one authoring fn
  (`get_query` / `edit_query`, `get_input`, and later `get_api`, `get_code`, …) and passes a full description of
  what it wants. It never generates the artifact itself.
- **Inside the fn:** a sub-agent, on `ctx.ai()` (aeye through the hub), does the work. Its tools force a fixed
  workflow (find existing → inspect types → draft → check → fix → save), and progressive disclosure shows it types,
  schemas, examples and docs a little at a time. The huge context these artifacts need stays inside the fn, so the
  main chat stays small.
- **Port, don't reinvent:** take product's tested logic from `C:\Users\pdiff\Documents\GitHub\product`: its query
  agent and `query_set`, its type agent, its gin expression authoring, its disclosure steps and their tests. Port it
  onto aeye as-is where possible, with its unit tests. Library pieces belong in `@aeye/query` and `@aeye/gin` (see
  `docs/research/database-vs-product.md`, recommendations 1–3: one type model via `tableToQueryType`, the typed
  authoring schema via `buildSchemas`/`buildQueryTool`, signature and arg-check helpers).
- **Shared helpers:** the forced-workflow agent is one reusable SDK helper (an "authoring agent": stages, tools per
  stage, disclosure, a check-and-fix loop, a save step). Query, input, and later API and code authoring all use it.
- **What the chat model gets back:** the saved fn's signature, what it does, the result or preview, and how to call
  it again. Never the whole working context.

### 2. Testing is native to a system

- **One SDK test kit** that system authors (and the chat, when it writes a system) use without setup:
  - **Fake hub:** a fake hub and context in one line, with every `ctx.*` faked and recorded.
  - **Fn calls:** call a fn with typed args and check its typed result, its progress and what it asked the hub for.
  - **Mock and real models:**
    - mocked LLM replies (scripted, or recorded and replayed) for fast unit tests
    - real LLM calls for a few marked tests, through the hub or a free model, skipped without keys
  - **Component previews:**
    - render a system's Vue components (renderers, visuals, inputs, editors) in isolation, in named states (empty,
      loading, error, typical data, long data, phone and desktop)
    - screenshot them so a model or a person can review them, as a gallery
  - **Kinds and contexts:** test a kind's derived fn props from a payload. Test a context folder: it is valid, its
    links resolve, and it loads its fns.
- **Native, not bolted on:**
  - `harness test` runs a system's tests from anywhere.
  - fs's `install_system` runs them before asking for approval and shows the result on the card.
  - The authoring context teaches the kit, and the chat writes tests with the systems it writes.

### 3. Database recommendations 4–5 (from the comparison)

- **Result wording:** results say "shown to the person" only when someone is actually watching. Use a headless
  wording for nested agents, MCP calls and background runs.
- **Small fixes:**
  - `run_query` declares that it can write.
  - A missing required param is refused, not bound as NULL.
  - `get_query` uses the decision model and `ask_choice` to pick a database.
- **Not this build:** product's larger features (migrations with data steps, auto-CRUD, its visual ranking, hub
  records as types). They stay as recommendations 6–8 for after build 7.

## Carry-overs

Whatever build 6 leaves open.

## Rules

- Lean. Browser tests only for what needs rendering. Screenshots only of the screens that changed.
- One review round, plus a second only if the first finds critical or major problems.
- Owner notes given during the build go into `docs/plans/build-7-feedback.md` word for word, and into the Decided
  section, committed straight away.
