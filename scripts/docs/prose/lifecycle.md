### Config

A system declares what it needs before it can be used as `config: g.obj({ … })` (folders to serve, a database URL, an
API key). An admin sets the value in the hub (or a person does by asking in chat), checked against the type; until a
valid value is set the system shows as needing config and its fns, mentions and hooks are unavailable. The current
value is `ctx.config` in every context, typed; a run keeps the value it started with. Config lives in the hub's
database, never in a file of the system. Mark secrets plainly in the field docs; never log them.

The hub draws the config as a form from its gin type, on the review, system and pairing pages. A system whose config
needs more (a connection test, a picker that lists what the service has) draws its own: `system(name, {
configComponent: { component: 'connection', mode: 'replace' } })` names a component in its client's `configs`
(`client(contract, { configs: { connection: Component } })`), drawn instead of the form (`replace`) or under it
(`beside`). It gets `ConfigView` props: the saved `config`, its gin `type`, `validate(value)` (the problems, one per
line) and `change(value)` to hand the edited config to the page, plus `system` to send its actions. The page saves the
value, and the hub still checks it with the gin type before storing it.

### Events

`events` handles hub events by type, and the system is subscribed to exactly the types it handles: `message` (a chat
message), `run` (a run's status, progress, operations or cost changed), `resources` (resources changed), `system` (a
system connected, disconnected or was removed) and `fns` (fns were `added`, `removed`, or `changed`: saved again, or
their availability moved). The update that settles a run also says `notified`: whether it, or a run under it, told its
person something. Each handler is `async (event, ctx) => void`, with the event typed by its `type`.

### Lifecycle

`lifecycle` handles moments in the system's life, each `async (ctx) => void` with the system context:

- `installed`: the first connect after being paired or installed, with a valid config;
- `started`: every connect with a valid config, once the contract is imported;
- `configured`: the config changed; `ctx.previous` is the value it replaced (or `undefined`). React if it matters
  (watch new folders, reconnect to a new database); runs already going keep their value;
- `stopping`: before it stops, with `ctx.reason` (`restart`, `upgrade`, `shutdown`, `removed`) and `ctx.timeout`;
- `upgraded`: the first start of a new version, with `ctx.from`;
- `uninstalled`: an admin removed it; clean up anything kept outside the hub.

<!-- include: scripts/docs/example/server/impl.ts#impl-lifecycle -->

### Data, cache and instances

The hub gives each installed instance its own folders, outside the package, so upgrades and rollbacks keep them:
`<hub data>/systems/<name>/instances/<instance>/{state,data,cache}`. Code reaches them through every context:

- `ctx.dataDir`: what is the system's alone (its keys, a working copy of something it syncs). Data kept for people is
  never here: it is hub records (**Stored types and the data system**). The hub exports this folder with the
  instance's config (`harness system export-data`) and installs it back.
- `ctx.cacheDir`: what can be made again (client builds, indexes). Never exported; may be cleared.
- `ctx.instance`: this instance's name, `main` for a system that runs one copy. Several copies of one system can be
  attached at once (a fleet: `fs@laptop`, `fs@desk`); fn names and refs stay the same, and the hub picks the instance
  for each call. Set `"instances": "many"` in `system.json` for a system meant to run as a fleet.

Open anything kept in `ctx.dataDir` lazily (one per folder) rather than at import time.
Outside the hub (a system started by hand) the folders default to `.harness/systems/<name>/<instance>/…`. Never write
into the system's own source folder at runtime.
