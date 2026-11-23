A system can draw its things in the chat with **Vue 3 components**. `client(contract, renderers)` in `client/index.ts`
(default export) registers them, and each component's props are typed by the contract, so a component with the wrong
props doesn't compile. Props are reactive: a running fn's renderer updates as its progress, state and result come in.
Everything is optional; without a renderer the chat draws a sensible default.

| `renderers` key | One per | Props |
|---|---|---|
| `fns` | fn | `FnViewOf<typeof contract, '<fn>'>`: `run`, `status`, `args`, `result?`, `error?`, `progress?`, `state`, `submit` (fns with a `form`), and `system` |
| `kinds` | kind (used for its fns without their own renderer) | `FnView<UntypedFn> & WithSystem<…>` |
| `results` | `{ fns, kinds }`: a finished run's result, by fn or kind | `ResultViewOf<typeof contract, '<fn>'>` (a kind's: `ResultView<UntypedFn> & WithSystem<…>`): `run`, `fn`, `args`, `result`, `title`, `system` |
| `attachments` | attachment | `AttachmentViewOf<typeof contract, '<attachment>'>`: `data`, `title`, `system` |
| `inputs` | named type | `InputViewOf<typeof contract, '<Type>'>`: `modelValue`, `problems`, `readonly`, `system`; works with `v-model` |
| `mentions` | mention provider | `MentionView<Target> & WithSystem<…>`: `label`, `target`, `type?`, `hover` |
| `resources` | resource format (`markdown`, a system's own) | `ResourceView & WithSystem<…>`: `stat`, `section?`, `forms`, `text(form?)`, `bytes()`; given as a component, or `{ component, mode: 'replace' | 'tab', label? }` |

<!-- include: scripts/docs/example/client/index.ts#client -->

In a single-file component, type the props with `defineProps<FnViewOf<typeof notes, 'find'>>()` and import the contract
with `import type`, so the renderer bundle doesn't carry it twice:

<!-- include: scripts/docs/example/client/FindView.vue -->

**Talking back.** `view.system.send.<action>(input)` sends an action and returns a `Delivery` (`id`, live `status`, and
`result`); it waits in the hub while the system is offline, and `view.system.online` says which. `view.system.run.<fn>(args)`
starts a new run of one of the system's fns in the renderer's session, as a person would. A fn with a `form` gets
`view.submit(value)` (the notes `review` form, `client/ReviewForm.vue` in **Worked examples**, calls
`view.submit({ approved, note })` and shows the answer once the run is done).

**Results.** A result renderer draws only what a finished run gave, under the chat's own run line (its status, cost and
args stay the chat's); a fn renderer, which draws the whole run as it goes, wins over it. It may draw with the app's
result view, `inject(RESULT_VIEW)` (`ResultViewProps`: a result table or a widget's result with its chips, visuals, drill
and row actions; `keepLook` lets Settings keep the look picked there), and with the app's controls,
`inject(APP_COMPONENTS)` (the same `SharedComponents` a page has as `host.components`). In a chat, `inject(CHAT_HOST)` asks the agent
(`ask(text, send)`), waits for a run the renderer started to end (`settled(run)` gives a `RunOutcome`) and moves the app
(`navigate(path)`). The widgets system draws a `make_widget` proposal's card with Save this way, and a saved widget's
result by its kind.

**Inputs** are editors (and, read-only, viewers) of a named type, used wherever the chat draws a value of it: `!` forms,
handler prompts, config forms, run cards, mention cards. They work with `v-model`: emit `update:modelValue` with a whole
new value, and show `problems`. With `readonly` the same component only shows the value (the notes input,
`client/NoteInput.vue` in **Worked examples**, draws a card then).

**Resource viewers** are shared by format: a resource is shown with the viewer for its format, whichever system serves
it, and the hub has viewers for the common ones (text, markdown, code, images, PDF, JSON, CSV, folders). A system's
viewer either replaces the hub's preview for its format (`mode: 'replace'`) or adds a tab beside it (`mode: 'tab'`, named
`label`); a bare component replaces. `view.forms` lists the forms the hub made of the resource and `view.text(form)` reads
one (the notes system's `client/WordCount.vue` adds a Words tab to every markdown resource). Inside any
renderer, `inject(RESOURCE_VIEWER)` gives the component that shows any resource (`<ResourceViewer :uri="uri" compact />`).

**Look.** Renderers sit inside the chat, so use its design tokens (`var(--space-2)`, `var(--surface)`, `var(--border)`,
`var(--text-dim)`, `var(--accent)`, `var(--danger)`, `var(--radius)`, `var(--text-sm)`, …) in scoped styles, so they
follow light and dark themes, and keep them responsive (`min-width: 0`, wrapping, no fixed widths).

**Building.** `buildClient({ entry, outDir })` (from `@harness/sdk/build`) bundles `client/index.ts` with Vite, `.vue`
files and CSS included, keeping `vue` and `@harness/sdk` external so renderers share the chat's copies. Pass `outDir`
as `serve`'s `client` option and the system uploads the bundle when it connects; `harness system build` does the same
for a packaged system.

**Visuals for a registry.** A system adds components to a registry (its own or another system's, such as
`hub/visuals`) with `client(contract, { visuals: { 'hub/visuals': { bullet: { component, veto } } } })` (`VisualEntry`).
Each must be listed in the contract's `contributes` with a declared shape (`visual({ shape })`), or `client()` throws:
the shape alone judges and ranks a fit, the same in the hub, the widget agent and the browser. `veto(table, facts)` may
only take a fit away, with a reason; keep it cheap and pure. The chat's runtime lists the visuals a result may use
(`visuals(registry, table, facts)`, in load order), leaving out a vetoed one and one whose veto throws; the result view
ranks them with the built-in ones. How to draw one with ECharts is in **Visuals and widgets**.

**Pages.** A system can add whole pages to the app, each at `/s/<system>/<segment>`. Declare each in the contract's
`pages` (`segment`, `title`, `description?`, `icon?`, `nav`: `main` puts it in the sidebar, `hidden` leaves it for links
such as one item's page; `access`: `everyone` or `admin`; and `component`), and give the component in
`client(contract, { pages: { NotesPage } })`. `client()` throws when a declared page has no component, or a component
no page names. The hub lists a page while its system is installed and live with its renderers on (an admin reviews and
can switch off each page like any component), so the page and its sidebar entry appear and disappear with the system;
an old link to a page whose system is gone keeps its URL and says the system isn't installed.

<!-- include: scripts/docs/example/shared/index.ts#pages -->

A page's props are `PageViewOf<typeof contract>`: `page` (its segment), `path` (the URL's parts under it, so
`/s/notes/note/42` gives `['42']`), `system` (its own actions and fns, as every renderer gets) and `host`:

| `host.` | What it gives |
|---|---|
| `user` | the person looking at the page (`id`, `name`, `role`, …) |
| `hub` | the app's typed hub client: `host.hub.caller('records').call({ type: 'notes/Note', search })`; calls run as that person, so the hub's access rules apply, and search, filters and counts run in the hub's database |
| `query` | the URL query, live: `values`, `get(key)`, `set({ key: value }, { push? })` (undefined or '' removes a key) and `bind(key, fallback?)`, a two-way binding for `v-model`. Keep the page's search, filters, tab and open item here, so every state is a URL |
| `href(to)` / `go(to, { replace? })` | links and moves between the system's own pages: `{ page?, path?, query? }` (this page when `page` is left out) |
| `openChat({ title, run? })` | starts a new chat as the person, runs `run` (`{ fn, args }`) there first as the person's own run, and goes to it (the widgets page opens a saved widget this way) |
| `chatHref(session)` / `goChat(session)` | a link to, and a move to, one of the person's chats (an item's own chat) |
| `runHref(run)` / `goRun(run)` | a link to, and a move to, a run's own page (`/run/<run>`: its result, tree, approval card and Undo), for a run outside any chat |
| `runs({ title })` | runs the page starts and waits on (`PageRuns`): each `run(fn, args, { on?, waiting? })` is the person's own run in a harness chat (made the first time, named by `title`, or `attach(session)`ed), so approval rules apply and the chat records it; it resolves only once the run settled with its outcome (`{ ok, output }` or `{ ok: false, problem }`, never early on the hub's `done`). The chat's `approvals` (with `argsOf(run)`) are answered with `approve`; `close()` when the page goes |
| `inbox` | the approvals waiting outside any chat, for runs the page knows wait on the person: `load(runs)`, `byRun(run)`, `decide` |
| `notify` / `format` / `live(refresh, every)` | the app's toasts (`ok`, `error`); money and times as the app writes them (`cost`, `relativeTime`, `fullTime`); and keeping the page live (every `every` ms while it is in view, once more when it comes back) |
| `components` | the app's own components, so a page looks like the rest of the app: `Frame` (the page frame: title, description, width, `actions` slot), `Input` (a search box or field), `Button`, `Select`, `Textarea`, `Dialog`, `Banner`, `Badge`, `Skeleton`, `Markdown`, `Icon`, `Empty`, `LoadState`, `FnPill`, `ResourceViewer` and `ValueEditor`; and the chat's own parts: `Reasoning`, `Typing`, `Approval` (an approval card, `inChat` when answered through `runs`), `Conversation` (`ConversationEntry`s drawn as the chat draws a thread: the person's bubbles, answers with reasoning folded, calls as run cards folded into one section) and `Composer` (`v-model`, `@send`, `@stop`). The claude system's pages are drawn this way |

A link a renderer or page builds from data (a URL a system, a model or a web page sent) goes through `safeHref(url)`
first: it gives back the URL when a link may go there (http and https, mail, places in the app, resource URIs) and
`undefined` for `javascript:`, `data:`, `//host` and the like. Show a refused URL as plain text, never as a link.

Components under the page read the same host with `inject(PAGE_HOST)`. The notes system's page searches its notes
in the hub with the words in `?q=`:

<!-- include: scripts/docs/example/client/NotesPage.vue -->
