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
   - **`@ayepi/log`:** a browser build, without `node:async_hooks`. The web app then uses it to capture `console.*`
     calls and to sanitize log lines.
   - **`@aeye/resources`:** graph nodes carry the raw fetched bytes (or a content ref), the final URL, the status and
     whether the page was rendered. The web system's crawl then uses `buildResourceGraph` instead of its own walk.

## Rules

- Lean. Browser tests only for what needs rendering. Screenshots only of the screens that changed, at 390x844 and
  1440x900.
- One review round, plus a second only if the first finds critical or major problems.
- Owner notes given during the build go into `docs/plans/build-6-feedback.md` word for word, and into the Decided
  section, committed straight away.
