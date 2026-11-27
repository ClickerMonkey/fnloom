/**
 * `@harness/core`: the wire contracts every part of harness shares. zod schemas come first and every type is derived
 * from them, so changing a schema breaks, at compile time, everything that relies on it.
 *
 * - `primitives`: JSON, ids, units, names, priorities; `model-names`: the one name the model sees for a fn.
 * - `ports`: the port schema, default ports and the shared `HARNESS_PORT` env field.
 * - `gin`: gin types on the wire; `gin-record`: the harness's own `record<V>` type and the registries that define it.
 * - `run`: who a run is for, progress, outcomes.
 * - `labels`: friendly names for qualified names.
 * - `status`: what a run says it is doing (status templates and their resolution).
 * - `resources`: resources, sections, content refs, links.
 * - `llm`: LLM requests and chunks on the wire.
 * - `manifest`: a system's contract as JSON, hooks and mentions; `inject`: injected context's targets and patterns.
 * - `link`: the system link specs (`hubLinkSpec`, `systemLinkSpec`).
 * - `records/*`: what the hub stores, and `HUB_TABLES`.
 * - `system-events`: the hub events systems subscribe to.
 * - `web`: the web API spec (`hubWebSpec`) and its events.
 * - `modes`: chat modes, contextors, model limits and what a prompt held.
 * - `context-graph`: context origins and weighted links; `people-only`: fields only a person sets, by hand.
 * - `resource-forms`: raw content, converted and made forms, sources, families; `media-types`: what content is, from its bytes then its name.
 * - `model-calls`: every model call of every modality, and model roles.
 * - `metrics`: fn metrics.
 * - `package`: system packages, instances, pairing info, data exports.
 * - `records/mcps`: hub MCPs.
 * - `query`: the filter and sort standard every list shares, and each list's fields.
 * - `suggestions`: what a message was suggested and not, with reasons; the decision model setting.
 * - `claims`: parallel claims, what a fn's calls operate on so an agent's clashing calls run one after another.
 * - `image-embeddings`: where the index embeds images (a second vector space, or the text one).
 * - `auto-pair`: auto-pair secrets.
 * - `access`, `connections`, `system-providers`, `validation`, `pickers`: build 4.
 * - `registries`: registries, contributions, visual fits and result tables.
 * - `approvals`: fns that always ask, proposed runs and their previews.
 * - `decisions`: the decision model for systems.
 * - `config-secrets`: secret fields in a system's config.
 * - `context-files`: context folders (file headers, check problems) and what loading context did.
 * - `system-parts`: what a system added beyond its fns, context and types, for its admin page.
 * - `checks`: the bundle scan, a system's test report and component previews.
 * - `grants`: what a system may do through the hub, its config component and its stage.
 * - `system-pages`: whole pages a system adds to the web app (`/s/<system>/<page>`).
 * - `lifecycle`: installed vs live, reviews, item switches and refusals; `review-summary`: what a set of contract changes amounts to.
 * - `graph`: the graph of systems' items and their relations.
 * - build 8: `sensitivity` (sensitive files and their rules), `changes` (what a command changed), `identity` (the hub's
 *   display name), `versions` (every item's version history), `data` (the data system's records), widget pass: `visuals` (column facts,
 *   coverage-first ranking, the built-in families), `widgets` (the `widgets` system's specs, results, actions and
 *   routing) and `widgets-v1` (build 8's hub widget contracts, for the migration), `api-index` (API groups and their index items), `mention-search` (resource
 *   search tied to a mention request).
 */
export * from './primitives.ts';
export * from './model-names.ts';
export * from './urls.ts';
export * from './https.ts';
export * from './modes.ts';
export * from './context-graph.ts';
export * from './people-only.ts';
export * from './objects.ts';
export * from './ports.ts';
export * from './gin.ts';
export * from './gin-record.ts';
export * from './gin-a.ts';
export * from './issues.ts';
export * from './partial.ts';
export * from './run.ts';
export * from './labels.ts';
export * from './status.ts';
export * from './resources.ts';
export * from './resource-forms.ts';
export * from './media-types.ts';
export * from './llm.ts';
export * from './model-calls.ts';
export * from './metrics.ts';
export * from './manifest.ts';
export * from './inject.ts';
export * from './context-files.ts';
export * from './system-parts.ts';
export * from './link.ts';
export * from './fn-block.ts';
export * from './records/systems.ts';
export * from './records/actors.ts';
export * from './records/spend.ts';
export * from './records/runs.ts';
export * from './records/chat.ts';
export * from './compare.ts';
export * from './records/content.ts';
export * from './owner-runs.ts';
export * from './records/mcps.ts';
export * from './records/injections.ts';
export * from './package.ts';
export * from './records/tables.ts';
export * from './system-events.ts';
export * from './admin.ts';
export * from './query.ts';
export * from './suggestions.ts';
export * from './claims.ts';
export * from './image-embeddings.ts';
export * from './auto-pair.ts';
export * from './web.ts';
export * from './access.ts';
export * from './connections.ts';
export * from './system-providers.ts';
export * from './validation.ts';
export * from './pickers.ts';
export * from './registries.ts';
export * from './approvals.ts';
export * from './decisions.ts';
export * from './config-secrets.ts';
export * from './fn-facts.ts';
export * from './fn-renames.ts';
export * from './checks.ts';
export * from './grants.ts';
export * from './system-pages.ts';
export * from './lifecycle.ts';
export * from './review-summary.ts';
export * from './graph.ts';
export * from './sensitivity.ts';
export * from './changes.ts';
export * from './identity.ts';
export * from './versions.ts';
export * from './data.ts';
export * from './visuals.ts';
export * from './widgets.ts';
export * from './csv.ts';
export * from './widgets-v1.ts';
export * from './api-index.ts';
export * from './mention-search.ts';
export * from './remote-auth.ts';
export * from './mcp-servers.ts';
export * from './sso.ts';
export * from './programs.ts';
export * from './flow.ts';
