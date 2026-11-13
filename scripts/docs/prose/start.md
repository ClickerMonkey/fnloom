A **system** is a Node process with a unique name that connects to the harness **hub** over one WebSocket and adds
things to it: fns (functions people, agents and other systems run), named types, context for the LLM, `@` mentions,
hooks on user messages, settings, resources, embedders, sectioners, actions and Vue renderers. The hub owns every
LLM call, user, permission, budget and record; a system only declares what it offers and implements it.

Everything a system contributes is namespaced by its name: the `notes` system's fn `add` is `notes/add`, its type
`Note` is `notes/Note`, a method of it is `notes/Note.pin`.

**To write a system, in order:**

1. Copy the template: `harness system new <name>` (it copies `systems/template` to `systems/<name>` and puts the
   name everywhere `template` stands). **The system folder and the template** shows every file of it.
2. Write the **contract** in `shared/index.ts`: `system('<name>', { description }).with({ ... })`. Every shape is a gin
   type made with `g` (**Types with gin**). The sections from **The contract** to **The hub contract** cover each part a contract can hold.
3. Implement it in `server/impl.ts`. The implementation's type is computed from the contract, so the compiler lists
   anything missing and refuses anything extra (**The server**, **The run context and services**, **Calling other fns**, **Config, events, lifecycle and data**).
4. Optionally draw it in `client/`: Vue components typed by the contract (**The client**).
5. Test it with the test kit (`testHub`, `mockModel`, `contextFolder` and `preview` from `@harness/sdk/testing`,
   **Testing**) and run the tests with `harness test`, which `fs/install_system` runs too.
6. Run it against a hub, pair it, or build, pack and install it (**Packaging**). An installed system is not live: an
   admin reviews it in the hub and presses Go live before anything it offers can be called, so tell the person to do
   that. Read **Common mistakes** before you finish.

Four rules hold everywhere; the compiler enforces the first three:

- **One source of types.** Every shape (args, results, config, payloads, settings, attachments, state, forms) is written
  once as a gin type; every TypeScript type is inferred from it. Never write a TypeScript type a gin type already
  describes: use `Infer<typeof X>` or `ValueOf<typeof T>`.
- **Refs, not strings.** Everything declared gets a typed ref (`notes.fns.find`, `notes.context.guide`,
  `notes.settings.editing`). Refer to things through refs, so a reference to something that doesn't exist doesn't compile.
- **The contract declares, the server implements.** Everything declared must be implemented, and nothing undeclared
  can be.
- **Data lives in the hub.** What a system keeps for people (notes, tasks, anything shared or looked up later) is
  records of a stored type (`type({ records })`), read and written with `ctx.data` and searched by the hub's database
  (**Stored types and the data system**). Never keep it in a file or database of the system's own, and never load a
  whole set to filter or search it in code: every read is a query with a page. A system's folder (`ctx.dataDir`) holds
  only its own config, keys and caches.

The worked example throughout is the **notes** system (`scripts/docs/example`, shown whole in **Worked examples**): notes with
titles and tags, kept and searched by the hub as records of a stored type. Every code sample in this guide is a region of a file
that `npm run typecheck` compiles, so each is correct for this version of the SDK.

**Imports.** Contracts and renderers import from `@harness/sdk` (pure, safe in the browser). Server code imports
`serve` and friends from `@harness/sdk/server`, tests import the test kit from `@harness/sdk/testing`, and a process
that builds its renderers imports `buildClient` from `@harness/sdk/build`. Wire shapes (`ResourceStat`, `RunInfo`,
`UndoOutcome`, …) are in `@harness/core`; **Core types** lists every one the SDK refers to, resolved to plain TypeScript.
