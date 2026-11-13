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
- `await ctx.ai()`: the way to use AI beyond that. An `@aeye/ai` instance whose provider is the hub, with the hub's real
  models listed (capabilities, prices, limits) and one `role/<role>` model per hub role, so aeye's selection, tools,
  structured output, prompts, agents, images, speech and embeddings work as usual. Every ctx has it (runs, hooks,
  lifecycle, actions); outside any ctx (a timer, a background job) `hubAi(running)` gives the same, paid by the
  system's own budget. The hub still decides access and budgets and records every call.

  ```ts
  const ai = await ctx.ai();
  const summarize = ai.prompt({
    name: 'summarize',
    description: 'Summarizes a note in one line.',
    content: 'Summarize this note in one line:

{{note}}',
    input: (input: { note: string }) => input,
  });
  const line = await summarize.get('result', { note: args.text }, { metadata: { model: 'role/chat' } });
  ```

  In tests, `fakeHubAi({ models, reply })` (from `@harness/sdk/server/testing`) gives the same type with scripted answers.
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

**Proposed runs and the decision model.** `ctx.propose(fn, args, { preview, approver?, key? })` (`Proposals`, on run
and system contexts) adds a run of one of this system's own fns that waits for approval, with the preview already
worked out: from a run it is that run's child and waits for its person (`approver: 'person'`), from anywhere else
(a schema change found at start) for an admin (`'admins'`). Pass a fn ref for typed args, or a runtime fn's local name
with JSON args. The same `key` (by default a hash of the fn, the args and the proposing run) never makes a second run.
Outside a run a proposal can also wait for one person: `for` names them, and `key` (required then) must start with
the id of a record of this system they own, such as a Claude session, or of a run of this system they started
(`proposalKeyFor(id, what)`; the hub refuses anything else), and `approver` then defaults
to `'person'`. `chat` puts the card in that harness chat too (it is always in the inbox). `ask: { type, into }` makes
the card a form: the approver fills a value of the gin type `type`, and the run goes ahead with it at `args[into]`
(a question Claude asks, an MCP elicitation). The system hears how the run settled through the `run` event
(`events.run`): `done` when approved, `cancelled` when declined, with the approver's words in the status text.
`ctx.decide(question, candidates, { max })` (`Decisions`, runs only) asks the admin's decision model to pick
candidates to reuse (each `{ id, text, score }`); `by: 'off'` or `'failed'` means go by the scores yourself.
