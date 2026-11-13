`system(name, { description })` starts a contract; `.with(part)` adds sections to it and returns a new contract, any
number of times. A part is an object of sections, or a **function of the refs declared so far** that returns one, so a
later part can use earlier declarations (an agent's tools, a context's fns, a mention's type, fns of a kind):

<!-- include: scripts/docs/example/shared/index.ts#with-refs -->

The sections, all optional:

| Section | Holds | Made with |
|---|---|---|
| `config` | what the system needs before it can be used (one gin object type; a later `config` replaces an earlier one) | `g.obj({ … })` |
| `types` | named types other systems can use as fields, with display and methods | `type()` |
| `settings` | typed per-actor controls admins set for users, groups or agents | `setting()` |
| `attachments` | kinds of data fns attach to assistant messages | `attachment()` |
| `kinds` | fn kinds the system runs | `kind()` |
| `fns` | native fns, agents, and fns of a kind | `fn()`, `agent()`, `kinds.<k>.fn()` |
| `context` | text for the LLM, static or made by the server, optionally a `/command` | `context()` |
| `hooks` | additions to each user message before the LLM sees it | `hook()` |
| `mentions` | `@` mention providers | `mention()` |
| `embedders` | embed functions the hub can index with | `embedder()` |
| `sectioners` | ways of cutting resources into sections | `sectioner()` |
| `actions` | typed messages the system's renderers send it | `action()` |

The contract is a value with typed refs for everything in it: `notes.fns.add` is a `FnRef<'notes/add', Args, Result,
Handlers>`, `notes.types.Note` a `TypeRef`, `notes.context.recent` a `ContextRef` whose command args are typed. `notes.defs`
holds the declarations themselves; `SystemImpl<(typeof notes)['defs']>` is the implementation's type, and
`ConfigOf<(typeof notes)['defs']>` the config's. A name declared twice (in one part or across parts) throws when the
contract is built.

The whole notes contract is in **Worked examples**. Keep `shared/` free of Node imports: other systems and the browser import it.

**Registries, contributions and secrets.** `system(name, info)` also takes (`SystemInfo`): `registries`, the
registries this system hosts by local name (`RegistryDef`: a description and the gin type of the data each entry
draws); `contributes`, the entries this system adds to any registry (`{ registry: 'hub/visuals', name:
'map', label: 'Map' }`), whose components are in its client bundle; and `configSecrets`, the dot paths of its config's
secret text fields (`connection.password`), which the hub seals and only `configure` carries in plain. A secret path
that is not a text field of the config fails the manifest.

**Grants and what the hub enforces.** `system(name, info)` also takes `grants` (`SystemGrants`): what the system may
do through the hub, and on its machine when fs hosts it. The hub checks every call a system makes over the link
against them. A system that declares none gets the base only: the handshake, its manifest and patches, uploading
content, its own runs (progress, outcomes, handlers, control, logs), calling its own fns, `ctx.types` and its fleet.
Anything else needs a capability in `grants.hub`:

| What the system calls | Grant it needs |
|---|---|
| `ctx.llm` (`text`, `object`, `stream`, `image`, `transcribe`, `speak`), `ctx.ai()`, `hubAi()` | `hub: ['ai']`, and `models` to limit roles, models and spend (`perRun`, `perDay`) |
| `ctx.llm.embed` | `hub: ['embed']` (or `ai`) |
| `ctx.resources` (`stat`, `text`, `links`, `sections`, downloading content) | `hub: ['resources']` |
| `ctx.fns.<dep>(…)` where the dep is another system's fn or a hub fn (`hub.fns.ask_user`) | `hub: ['fns']` and the fn (`hub/ask_user`) or its system (`database`) in `calls` |
| `ctx.searchFns`, `ctx.fnExamples`, `running.examples` | `hub: ['search']` |
| `ctx.decide` | `hub: ['decide']` |
| `ctx.propose`, `running.grantPairing`, `running.reportRefusal` (hosting other systems) | `hub: ['approvals']` |
| handing back refreshed credentials of a `connect` system | `hub: ['connections']` |
| `ctx.setting(ref)` | `hub: ['settings']` |
| `ctx.state` (`get`, `set`, `update`, `clear`) | `hub: ['state']` |
| `ctx.data` (`find`, `get`, `table`, `save`, `remove`) | `hub: ['data']` |
| a hub secret by name | its name in `secrets` (its own config secrets are always its own) |
| a host on the network, a path outside its folders (hosted by fs only) | the host in `network`, the path in `files` |

Beyond the grants, the hub enforces what each fn declares in `effects`: a fn declared `read` can't call or propose a
fn that writes or deletes (a hub fn tagged `own`, which changes only what the system owns, aside), a `write` fn can't
call one that deletes, and a run whose fn declares the types it reads and writes asks `ctx.types` for no others. The
notes system declares:

<!-- include: scripts/docs/example/shared/index.ts#grants -->

A refused call throws in the system: the hub answers 403 with the code `NOT_GRANTED` and a line saying what was
missing (`it didn't declare the state capability, which stateSet needs`), and a fn that doesn't catch it fails with
that text. Every refusal is logged where the admin reviews the system, and a system that keeps going past its grants
(`HARNESS_REFUSALS_PAUSE` refusals in `HARNESS_REFUSALS_WINDOW`) has its fns switched off until an admin turns them back
on. So declare everything the code calls, and nothing more: the review page and the install card show the grants to
the admin, who goes live on them.
