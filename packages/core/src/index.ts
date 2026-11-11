/**
 * `@harness/core`: the wire contracts every part of harness shares. zod schemas come first and every type is derived
 * from them, so changing a schema breaks, at compile time, everything that relies on it.
 *
 * - `primitives`: JSON, ids, units, names, priorities.
 * - `ports`: the port schema, default ports and the shared `HARNESS_PORT` env field.
 * - `gin`: gin types on the wire.
 * - `run`: who a run is for, progress, outcomes.
 * - `labels`: friendly names for qualified names.
 * - `status`: what a run says it is doing (status templates and their resolution).
 * - `resources`: resources, sections, content refs, links.
 * - `llm`: LLM requests and chunks on the wire.
 * - `manifest`: a system's contract as JSON, hooks and mentions.
 * - `link`: the system link specs (`hubLinkSpec`, `systemLinkSpec`).
 * - `records/*`: what the hub stores, and `HUB_TABLES`.
 * - `system-events`: the hub events systems subscribe to.
 * - `web`: the web API spec (`hubWebSpec`) and its events.
 * - `modes`: chat modes, contextors, model limits and what a prompt held (build 2).
 * - `context-graph`: context origins and weighted links (build 2).
 * - `resource-forms`: raw content, converted and made forms, sources, families (build 2).
 * - `model-calls`: every model call of every modality, and model roles (build 2).
 * - `metrics`: fn metrics (build 2).
 * - `package`: system packages, instances, pairing info, data exports (build 2).
 * - `records/mcps`: hub MCPs (build 2).
 * - `query`: the filter and sort standard every list shares, and each list's fields (build 3).
 * - `suggestions`: what a message was suggested and not, with reasons; the decision model setting (build 3).
 * - `auto-pair`: auto-pair secrets (build 3).
 * - `access`, `connections`, `system-providers`, `validation`, `pickers`: build 4.
 * - `registries`: registries, contributions, visual fits and result tables (build 5).
 * - `approvals`: fns that always ask, proposed runs and their previews (build 5).
 * - `decisions`: the decision model for systems (build 5).
 * - `config-secrets`: secret fields in a system's config (build 5).
 * - `context-files`: context folders (file headers, check problems) and what loading context did (build 6).
 * - `system-parts`: what a system added beyond its fns, context and types, for its admin page (build 6).
 */
export * from './primitives.ts';
export * from './modes.ts';
export * from './context-graph.ts';
export * from './objects.ts';
export * from './ports.ts';
export * from './gin.ts';
export * from './run.ts';
export * from './labels.ts';
export * from './status.ts';
export * from './resources.ts';
export * from './resource-forms.ts';
export * from './llm.ts';
export * from './model-calls.ts';
export * from './metrics.ts';
export * from './manifest.ts';
export * from './context-files.ts';
export * from './system-parts.ts';
export * from './link.ts';
export * from './records/systems.ts';
export * from './records/actors.ts';
export * from './records/spend.ts';
export * from './records/runs.ts';
export * from './records/chat.ts';
export * from './records/content.ts';
export * from './records/mcps.ts';
export * from './package.ts';
export * from './records/tables.ts';
export * from './system-events.ts';
export * from './admin.ts';
export * from './query.ts';
export * from './suggestions.ts';
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
