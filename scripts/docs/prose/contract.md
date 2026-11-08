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
