# Build 6

Build 6 of 7. It starts as soon as build 5 finishes. It is lean: efficient in tokens and time. The owner's standing
rules are in the "Decided" section of `docs/harness.md`, including the review notes of 2026-11-10.

## Work

1. **Install a system from the chat:** `docs/plans/system-install-flow.md`, all of it.
   - Its owner decisions hold: run under tsx, and build it now.
   - Part 1 (a context brings its fns) is done in build 5 if build 5 finished it. Otherwise it is done here first.
2. **Whatever build 5 leaves open:** its finish report and review findings, plus every item in the "Departures" section
   of `docs/reference/hub-surface.md` that build 5 didn't close.
3. **Systems use aeye through the hub:** `ctx.ai()` / `hubAi()` anywhere, with real models, if build 5 didn't finish
   it. See `docs/plans/build-5-feedback.md`, last section.
4. **Library gaps from build 5** (owner: "You can do it when it makes sense"). Fix these in the libraries on the local
   `harness` branches, never pushed, then remove the harness workarounds:
   - **`@aeye/gin` (aits):** `RefWalker` must skip `enum` values and `literal` values, so an enum value `name` isn't
     read as a TypeDef. Restore any option that was renamed to get past it.
   - **Not `@ayepi/log`.** The owner: "ayepi/log was never intended for browser log capture". So it isn't a library
     gap. The web app's own log client in `packages/web` captures browser logs: `console.*` calls, errors and
     traffic, sanitized with no bodies or secrets. It is still sent to the hub as per-person resources.
   - **`@aeye/resources`:** graph nodes carry the raw fetched bytes (or a content ref), the final URL, the status and
     whether the page was rendered. The web system's crawl then uses `buildResourceGraph` instead of its own walk.

## Rules

- Lean. Browser tests only for what needs rendering. Screenshots only of the screens that changed, at 390x844 and
  1440x900.
- One review round, plus a second only if the first finds critical or major problems.
- Owner notes given during the build go into `docs/plans/build-6-feedback.md` word for word, and into the Decided
  section, committed straight away.

## Context folders (owner, 2026-11-11)

> Maybe in the next build also add a way for in a service there is a context folder that's filled with markdown files where each has a yaml header with everything you can specify in metadata and after that is the content. Then the build it imports all that and serves that as context back to the hub and also makes sure the context files are valid with no broken links to fns or other context. Context should have stable readable non human visible keys to ensure we update context in hub even if some part of it changes. Because with fs I'm going to want it to build a massive context graph like choose your own adventure through the documentation and code examples and types etc based on the users request. And make sure the context that's linked to be loaded with another actually functions that always in context_load fn if that's what it's called. I know the API interface for systems and everything is going to grow and be huge potentially but I need it efficiently organized so a small model can reason about it

How I read it (the owner can overrule):

- **Context folders:** a system can have a `context/` folder of markdown files. Each file starts with a YAML header
  holding any context metadata, then its content.
  - **The header's schema** is the zod ContextDecl, so every option a contract can set can be set here: key, title,
    summary, fns it brings, the context it loads with it, next choices, tags, types, visibility, alwaysFor, command,
    parent, examples.
  - **Build and dev:** the system's build reads the folder, checks it, and serves the entries to the hub as context.
    In dev it watches the folder and updates the hub live, through the runtime add/update/remove API.
- **Checks:** the build fails, with file and line, on:
  - a header that doesn't match the schema
  - a duplicate key
  - a link to a fn or context that doesn't exist (links in the header, and `[text](context:key)` / `fn:name`
    references in the body)
  - a context that loads itself in a cycle
  - a missing summary
- **Stable keys:** each file has a `key` (readable, e.g. `fs.authoring.kinds`). People never see it. It is never
  derived from the path, so files can move and be renamed. The hub updates context by key, so a changed title, text
  or place updates the same record and keeps its links, stats and embeddings.
- **Choose-your-own-adventure:** a context can list `next` choices. Each is a key plus a one-line "pick this when…"
  line. The model walks a big graph a step at a time and loads only what the request needs. This covers docs, code
  examples and types: fs turns its authoring guide into such a graph.
- **Linked context really loads:** `load_context` (and every contextor) loads the context an item declares it loads
  with, and the fns it brings, every time. A test covers it.
- **Organised for small models:**
  - short summaries
  - one idea per item
  - a shallow index at the top
  - choices worded as decisions
  - token sizes shown next to choices
  - never a huge flat list

  The same goes for the hub and system API as it grows: it is grouped and searchable, with a short index, so a small
  model can find what it needs.
