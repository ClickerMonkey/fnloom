A system can draw its things in the chat with **Vue 3 components**. `client(contract, renderers)` in `client/index.ts`
(default export) registers them, and each component's props are typed by the contract, so a component with the wrong
props doesn't compile. Props are reactive: a running fn's renderer updates as its progress, state and result come in.
Everything is optional; without a renderer the chat draws a sensible default.

| `renderers` key | One per | Props |
|---|---|---|
| `fns` | fn | `FnViewOf<typeof contract, '<fn>'>`: `run`, `status`, `args`, `result?`, `error?`, `progress?`, `state`, `submit` (fns with a `form`), and `system` |
| `kinds` | kind (used for its fns without their own renderer) | `FnView<UntypedFn> & WithSystem<…>` |
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
