Every implementation gets a context (`ctx`) typed by what it implements.

**A fn's run (`FnCtx`)** has, besides the services below:

- `ctx.config`: the system's config as it was when the run started (a run keeps that value even if it changes).
- `ctx.run`: who the run is for and where it sits (`RunInfo`): its id, fn, turn and session; `user` (id, name, email,
  role, groups, time zone, locale); `time` (`now`, the zone, and the local time with its offset); this system and
  instance, and `system.from` when another system's fn called it; the caller, the attempt and the priority.
- `ctx.fns`, `ctx.handlers`, `ctx.progress`, `ctx.state`, `ctx.form`: typed by the fn's declaration.
- `ctx.done`, `ctx.invalid`, `ctx.fail`, `ctx.pause`, `ctx.cancelled`; `ctx.undoWith`, `ctx.onPause`, `ctx.allow`,
  `ctx.resume`; `ctx.signal` (**Outcomes**).
- `ctx.budget`, for information: `remaining()` (the least money and time left across every budget that applies),
  `limitedBy()`, and `spend(cost, what)` to report a cost the hub can't see (a paid API call). The hub enforces LLM
  spend itself.
- `ctx.expose(fnRef, detail?)`: show the agent another fn with this result (a search showing the fn that opens what it
  found), so it can use it next.

**Services** every run, undo and action gets:

- `ctx.llm`: model calls, always through the hub, which picks the model, enforces budgets and records every call:
  `text({ prompt, system?, model? })`, `object({ prompt, output: ginType })` (an answer checked against a gin type),
  `stream(...)`, `embed(texts)`, `image(...)`, `transcribe(...)`, `speak(...)`. Never call a model provider directly.
  For aeye prompts, tools and agents, `harnessAiOf(ctx.llm)` gives an `@aeye/ai` instance backed by the hub.
- `ctx.files`: file operations the system allows (`read`, `readText`, `write`, `list`, `remove`, and `share(path)` to
  upload to the hub and get a `ContentRef`).
- `ctx.fetch`: `fetch` through the system's outbound rules.
- `ctx.resources`: resources from any system the person may see (`stat`, `text`, `links`, `sections`, `search`).
- `ctx.types.definitions(names)`: named types of any system, with what they reference.
- `ctx.attach(attachmentRef, data, title)` and `ctx.link(link)`: add to the assistant message.
- `ctx.setting(settingRef)`: the effective value of a setting for the run's person.
- `ctx.log`: structured logs, `ctx.log.info('notes.added', { id })`.
- `ctx.instance`, `ctx.dataDir`, `ctx.cacheDir`: which instance this is and its folders (**Config, events, lifecycle and
  data**).

**Everything else** (hooks, mentions, actions, dynamic context, events, lifecycle) gets a `SystemCtx`: the system's
name and current config, `llm`, `resources`, `types`, `log`, a `signal`, and the instance and its folders. Mentions,
actions and dynamic context also get who is asking (`AskerCtx`: `session`, `user`, `time`); actions also get the run
services, the delivery and session state. An undo gets an `UndoCtx`: config, run info, signal and the services.
