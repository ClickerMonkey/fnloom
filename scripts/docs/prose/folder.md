A system is a folder in one shape, which is also what gets built, zipped and installed:

```text
systems/<name>/
  system.json      name, version, description, link protocol, server and client entries, one instance or many
  package.json     npm dependencies and scripts, for development only (its version is not the system's)
  tsconfig.json    extends the repository's base config; listed in the root tsconfig's references
  shared/index.ts  the contract: everything the system offers, with no implementation (browser safe: no Node imports)
  server/env.ts    the tunables, an @ayepi/env slice: hub URL, state folder, pairing token, and the system's own
  server/index.ts  the server's seams: an interface per outside dependency, the config type, re-exports
  server/impl.ts   createImpl(deps): the implementation, built from injected dependencies so tests use fakes
  server/main.ts   the process: parse the env, build the real dependencies, serve
  server/*.test.ts tests (vitest), over the in-memory hub
  client/index.ts  client(contract, renderers): Vue renderers, optional
  dist/            what `harness system build` makes and `harness system pack` zips
```

- **`system.json` is the one source of the name and version.** The contract's name (`system('<name>', …)`) must equal
  `system.json`'s `name`; `harness system build` and `serve()` check it. Its schema is in **Packaging**.
- **Config is not a file.** It lives in the hub's database, set by an admin and checked against the contract's config
  type. The system reads it as `ctx.config`.
- **Data has its own folders.** The hub gives each installed instance `state`, `data` and `cache` folders outside the
  package, so upgrades keep them; code reaches them as `ctx.dataDir` and `ctx.cacheDir` (**Config, events, lifecycle and
  data**). Never write into the system's own folder at runtime.
- **Name rules.** A system name is lowercase letters, digits and dashes, unique on the hub, and not `hub`, `memory` or
  `resource`. Local names (fns, types, context, …) are unique within their section. Never name a file `aux`, `con`,
  `prn`, `nul`, `com1`–`com9` or `lpt1`–`lpt9`: Windows reserves them and git cannot track them.
- **Code style the SDK expects.** Strict TypeScript, no `any`, no unchecked casts (`as` only for `as const`). Tunables in
  the env slice, never `process.env` in feature code. Structured logs: `ctx.log.info('notes.added', { id })`, a stable
  dotted key, then fields. An interface for each outside dependency, so tests inject fakes. TSDoc on every export.

### The template

`systems/template` is a system with nothing declared: every section of the contract and the implementation is a comment
naming what goes there and which builder declares it, ending in `TODO`. It typechecks and its test passes as it is.
Fill the sections you need and delete the comments of the ones you don't. These are its files, verbatim:

<!-- generate: template-files -->
