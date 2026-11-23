/**
 * The hub's contract. The hub is a system too, built with the same SDK: other systems depend on its fns, use its
 * `llm` kind (every agent is a fn of it), refer to its sectioners, and use its named types as fields
 * (`g.nullable(hub.types.ContentRef)`). The hub implements this contract in its own process.
 *
 * Besides its own fns (search, load, follow runs, ask people, the static toolset's `find` / `inspect` / `load` /
 * `unload`), the hub offers its web endpoints as fns through three maps, so the chat agent can see and do everything
 * a person can: `HUB_READ_ENDPOINTS` (tagged `read`), `HUB_WRITE_ENDPOINTS` (they ask) and `ADMIN_ENDPOINTS` (tagged
 * `admin`). Each such fn's args and result are its endpoint's body and response: one source of truth.
 */
import {
  ADMIN_TAG, adminSlice, AgentInjected, chatSlice, CONTENT_HASH_PATTERN, ChatModeConfig, contextorSlice, contextSlice, ContextorConfig, DETAIL_LEVELS, ERROR_CLASSES,
  graphSlice, injectionsSlice, versionsSlice, dataSlice, ContributionView, ReadTableArgs, ResultTable, RowActionsQuery, WidgetActionOption, mcpsSlice, metricsSlice, accessSlice, autoPairSlice, connectionsSlice, explorerSlice, suggestionsSlice, MintMcpTokenArgs, modelsSlice, OWN_TAG, packagingSlice, READ_TAG, resourcesSlice, ResourceOutlineArgs, ResourceSendArgs, ImageReadArgs, ImageReadResult, RUN_STATUSES, runsSlice,
  FnLive, GinTypeDef, LIST_NAMES, querySlice, Section, settingsSlice, systemsSlice, LlmContentPart, ModelLimits, LINK_TARGET_KINDS, type Display,
  FnBlock, FnExample, FnExamplesPage, FnExamplesQuery, FnRouting, FnSearchArgs, FnSearchPage, CtxSearchArgs, LoadContextResult, LoadFnsResult, ContextCrawlArgs, ContextCrawlResult, CRAWL_BATCH_MAX, NameRefusal, ShareRule, type RegistryEffect,
  type QualifiedName,
} from '@harness/core';
import { z } from 'zod';
import { CHAT_BASE, CHAT_SMALL_BASE } from './chat-prompt.ts';
import { fn, type FnExampleOf } from './fn.ts';
import { kind, mention, sectioner, type } from './declare.ts';
import { g, json, type GinType } from './gin.ts';
import { system } from './system.ts';
import { withRefText, type ContextRef } from './refs.ts';
import { BUILT_IN_CONTRIBUTIONS } from './widgets.ts';
import { ginAs, ginOf, toolArgsOf, type ToolArgs } from './zod-gin.ts';

/** A web endpoint a hub fn stands for: its body is the fn's args and its response the fn's result. */
interface EndpointLike {
  readonly cfg: { readonly body: z.ZodType; readonly response?: z.ZodType };
}

/**
 * The web reads the hub also offers as fns, so the chat agent can look at everything a person can: fn name →
 * endpoint. Each is tagged `read`; the hub runs the same operation as the endpoint's handler, as the run's person.
 */
export const HUB_READ_ENDPOINTS = {
  resource_list: resourcesSlice.endpoints.browseResources,
  resource_read: resourcesSlice.endpoints.readResource,
  ctx_get: contextSlice.endpoints.contextItem,
  types_get: chatSlice.endpoints.types,
  runs_list: adminSlice.endpoints.runs,
  run_get: runsSlice.endpoints.run,
  run_tree: runsSlice.endpoints.tree,
  llm_call: runsSlice.endpoints.llmCall,
  model_calls: metricsSlice.endpoints.modelCalls,
  fns_metrics: metricsSlice.endpoints.fnMetrics,
  sessions_list: chatSlice.endpoints.sessions,
  session_messages: chatSlice.endpoints.messages,
  systems_list: systemsSlice.endpoints.systems,
  system_get: systemsSlice.endpoints.system,
  system_fns: adminSlice.endpoints.systemFns,
  system_logs: adminSlice.endpoints.systemLogs,
  model_roles: modelsSlice.endpoints.modelRoles,
  model_limits: contextorSlice.endpoints.modelLimits,
  /** Any list by the query standard (`LIST_FIELDS`): filters, sort, paging. */
  query: querySlice.endpoints.query,
  /** The graph of systems' fns, context, types and parts, and how they connect. */
  graph: graphSlice.endpoints.graph,
  /** Build 8: any item's version history (fns, types, context, kinds, commands, components, ...). */
  item_versions: versionsSlice.endpoints.itemVersions,
} as const satisfies Record<string, EndpointLike>;

/** A hub read fn's name. */
export type HubReadFnName = keyof typeof HUB_READ_ENDPOINTS;

/**
 * The web writes on resources, context and memory the hub also offers as fns: fn name → endpoint. None is tagged
 * `read`, so unless a policy says otherwise each waits for the person's approval.
 */
export const HUB_WRITE_ENDPOINTS = {
  resource_convert: resourcesSlice.endpoints.convertResource,
  resource_import: resourcesSlice.endpoints.importResource,
  resource_rename: resourcesSlice.endpoints.renameResource,
  resource_delete: resourcesSlice.endpoints.deleteResource,
  ctx_from_resource: resourcesSlice.endpoints.contextFromResource,
  remember: contextSlice.endpoints.remember,
  forget: contextSlice.endpoints.forget,
} as const satisfies Record<string, EndpointLike>;

/** A hub write fn's name. */
export type HubWriteFnName = keyof typeof HUB_WRITE_ENDPOINTS;

/**
 * The rest of what a person does in the browser, as fns (fn name → endpoint), so the chat agent can do it
 * too, as the run's person: sessions, visibility, memory and context links, undoing a turn, background runs and
 * per-person connections. None is tagged `read`, so each asks unless a policy allows it. Answering an approval or a
 * question is left out on purpose: an agent must never answer what it asked.
 */
export const HUB_PERSON_ENDPOINTS = {
  session_create: chatSlice.endpoints.createSession,
  session_update: chatSlice.endpoints.updateSession,
  session_delete: chatSlice.endpoints.deleteSession,
  run_background: runsSlice.endpoints.background,
  turn_undo: runsSlice.endpoints.undoTurn,
  memory_update: contextSlice.endpoints.updateMemory,
  ctx_link: contextSlice.endpoints.linkContext,
  ctx_unlink: contextSlice.endpoints.unlinkContext,
  access_set: accessSlice.endpoints.setAccess,
  connection_update: connectionsSlice.endpoints.updateConnection,
  connection_disconnect: connectionsSlice.endpoints.disconnect,
} as const satisfies Record<string, EndpointLike>;

/**
 * Build 8, the data system (`core/data.ts`) as fns: stored types and their records, as the run's person. The reads
 * are tagged `read`; saving and removing a record ask unless a policy allows it.
 */
export const HUB_DATA_ENDPOINTS = {
  data_sets: dataSlice.endpoints.dataSets,
  records_find: dataSlice.endpoints.records,
  record_get: dataSlice.endpoints.record,
  records_table: dataSlice.endpoints.recordTable,
  record_versions: dataSlice.endpoints.recordVersions,
  record_save: dataSlice.endpoints.saveRecord,
  record_update: dataSlice.endpoints.updateRecord,
  record_remove: dataSlice.endpoints.removeRecord,
} as const satisfies Record<string, EndpointLike>;

/** A data fn's name. */
export type HubDataFnName = keyof typeof HUB_DATA_ENDPOINTS;

/** A person's write fn's name. */
export type HubPersonFnName = keyof typeof HUB_PERSON_ENDPOINTS;

/** The file explorer's reads as fns (tagged `read`): a system's files live, as the run's person may see them. */
export const HUB_EXPLORE_ENDPOINTS = {
  explore_roots: explorerSlice.endpoints.exploreRoots,
  explore_list: explorerSlice.endpoints.exploreList,
  explore_read: explorerSlice.endpoints.exploreRead,
} as const satisfies Record<string, EndpointLike>;

/** An explorer read fn's name. */
export type HubExploreFnName = keyof typeof HUB_EXPLORE_ENDPOINTS;

/**
 * The admin pages' reads as fns (tagged `admin` and `read`): budgets, policies, priorities, providers,
 * people, settings, hub MCPs, pairings, auto-pair secrets, instances and the suggestion decision model. They run only
 * for an admin and never through a hub MCP; reading asks nobody.
 */
export const ADMIN_READ_ENDPOINTS = {
  budgets_list: adminSlice.endpoints.budgets,
  policies_list: adminSlice.endpoints.policies,
  priority_rules_list: adminSlice.endpoints.priorityRules,
  providers_list: settingsSlice.endpoints.providers,
  actors_list: adminSlice.endpoints.actors,
  actor_settings_list: adminSlice.endpoints.actorSettings,
  mcps_list: mcpsSlice.endpoints.mcps,
  mcp_sessions_list: mcpsSlice.endpoints.mcpSessions,
  pairings_list: systemsSlice.endpoints.pairings,
  auto_pairs_list: autoPairSlice.endpoints.autoPairs,
  instances_list: packagingSlice.endpoints.instances,
  suggest_decision_get: suggestionsSlice.endpoints.suggestDecision,
  search_decision_get: suggestionsSlice.endpoints.searchDecisions,
  ctx_injections_list: injectionsSlice.endpoints.injections,
} as const satisfies Record<string, EndpointLike>;

/** An admin read fn's name. */
export type AdminReadFnName = keyof typeof ADMIN_READ_ENDPOINTS;

/**
 * The web admin endpoints the hub also offers as fns, so whatever an admin configures can be done by asking in chat:
 * fn name → endpoint. The endpoint's body and response are the fn's args and result, and the hub's admin fn and the
 * web handler run the same operation. Each is tagged `admin`: never exposed through a hub MCP, run only for an admin,
 * and it waits for the person's approval unless a policy says otherwise.
 */
export const ADMIN_ENDPOINTS = {
  configure_provider: settingsSlice.endpoints.configureProvider,
  set_model_category: settingsSlice.endpoints.setModelCategory,
  set_budget: settingsSlice.endpoints.setBudget,
  set_priority: settingsSlice.endpoints.setPriority,
  set_policy: settingsSlice.endpoints.setPolicy,
  set_actor_setting: settingsSlice.endpoints.setActorSetting,
  add_user: settingsSlice.endpoints.addUser,
  add_group: settingsSlice.endpoints.addGroup,
  update_user: settingsSlice.endpoints.updateUser,
  set_membership: settingsSlice.endpoints.setMembership,
  set_sign_in_policy: settingsSlice.endpoints.setSignInPolicy,
  set_sign_in_limits: settingsSlice.endpoints.setSignInLimits,
  set_proxy_trust: settingsSlice.endpoints.setProxyTrust,
  remove_rule: adminSlice.endpoints.removeRule,
  approve_pairing: systemsSlice.endpoints.approvePairing,
  create_pairing_token: systemsSlice.endpoints.createPairingToken,
  configure_system: systemsSlice.endpoints.configureSystem,
  enable_system: systemsSlice.endpoints.enableSystem,
  switch_item: systemsSlice.endpoints.switchItem,
  remove_system: systemsSlice.endpoints.removeSystem,
  install_system: systemsSlice.endpoints.installSystem,
  start_system: systemsSlice.endpoints.startSystem,
  stop_system: systemsSlice.endpoints.stopSystem,
  restart_system: systemsSlice.endpoints.restartSystem,
  upgrade_system: systemsSlice.endpoints.upgradeSystem,
  set_model_role: modelsSlice.endpoints.setModelRole,
  clear_model_role: modelsSlice.endpoints.clearModelRole,
  set_model_limits: contextorSlice.endpoints.setModelLimits,
  create_mcp: mcpsSlice.endpoints.createMcp,
  update_mcp: mcpsSlice.endpoints.updateMcp,
  rotate_mcp_secret: mcpsSlice.endpoints.rotateMcpSecret,
  delete_mcp: mcpsSlice.endpoints.deleteMcp,
  preview_mcp: mcpsSlice.endpoints.previewMcp,
  install_package: packagingSlice.endpoints.installPackage,
  add_instance: packagingSlice.endpoints.addInstance,
  remove_instance: packagingSlice.endpoints.removeInstance,
  export_system_data: packagingSlice.endpoints.exportSystemData,
  suggest_decision_set: suggestionsSlice.endpoints.setSuggestDecision,
  search_decision_set: suggestionsSlice.endpoints.setSearchDecision,
  auto_pair_revoke: autoPairSlice.endpoints.revokeAutoPair,
  system_reimport: systemsSlice.endpoints.reimport,
  ctx_injection_set: injectionsSlice.endpoints.setInjection,
} as const satisfies Record<string, EndpointLike>;

/** An admin fn's name. */
export type AdminFnName = keyof typeof ADMIN_ENDPOINTS;

/** The empty result of an endpoint with no response. */
const NoResponse = z.object({}).strict();

/** What an endpoint fn returns: the endpoint's response (its input side), or an empty object when it has none. */
export type EndpointResult<E extends EndpointLike> = z.input<E['cfg'] extends { readonly response: infer R extends z.ZodType } ? R : typeof NoResponse>;

/** The gin type of what an endpoint fn returns, typed as the endpoint declares it. */
function resultTypeOf<E extends EndpointLike>(endpoint: E): GinType<EndpointResult<E>> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- ginOf builds the input side of E's own response (or of none)
  return ginOf(endpoint.cfg.response ?? NoResponse) as GinType<EndpointResult<E>>;
}

/** An example call of an endpoint fn: its args as the fn takes them (the endpoint's body), checked when the contract is built. */
type EndpointExample<E extends EndpointLike> = FnExampleOf<ToolArgs<E['cfg']['body']>, EndpointResult<E>>;

/**
 * A fn for one web endpoint, its args and result read off the endpoint's body and response, so a system calling it
 * gets the endpoint's types and a change to the endpoint's schema reaches every caller.
 */
function endpointFn<E extends EndpointLike>(description: string, instructions: string, endpoint: E, examples: EndpointExample<E>[], tags: readonly string[], display?: Display, registry: readonly RegistryEffect[] = []) {
  return fn({
    description,
    instructions,
    args: toolArgsOf<E['cfg']['body']>(endpoint.cfg.body).args,
    returns: resultTypeOf(endpoint),
    examples,
    tags: [...tags],
    ...(display === undefined ? {} : { display }),
    // what it creates, updates or removes in the hub, so the chat and its mode know
    ...(registry.length === 0 ? {} : { effects: { registry: [...registry] } }),
  });
}

/** Effects on the hub, written short: `changes('create', 'fns', 'types')`. */
function changes(action: RegistryEffect['action'], ...things: Array<RegistryEffect['thing']>): RegistryEffect[] {
  return things.map((thing) => ({ thing, action }));
}

/** A fn for a web read, tagged `read`. Reads are bookkeeping the person needn't see as a card once done. */
function readFn<E extends EndpointLike>(description: string, instructions: string, endpoint: E, examples: EndpointExample<E>[]) {
  return endpointFn(description, instructions, endpoint, examples, [READ_TAG], 'message');
}

/** A fn for a write on resources, context or memory: it asks unless a policy allows it. */
function writeFn<E extends EndpointLike>(description: string, instructions: string, endpoint: E, examples: EndpointExample<E>[], tags: readonly string[] = [], registry: readonly RegistryEffect[] = []) {
  return endpointFn(description, instructions, endpoint, examples, tags, undefined, registry);
}

/** A fn for an admin page's read, tagged `admin` and `read`: only for an admin, and reading asks nobody. */
function adminReadFn<E extends EndpointLike>(description: string, instructions: string, endpoint: E, examples: EndpointExample<E>[]) {
  return endpointFn(description, instructions, endpoint, examples, [ADMIN_TAG, READ_TAG], 'message');
}

/** A fn for an admin operation, tagged `admin`. */
function adminFn<E extends EndpointLike>(description: string, instructions: string, endpoint: E, examples: EndpointExample<E>[], registry: readonly RegistryEffect[] = []) {
  return endpointFn(description, instructions, endpoint, examples, [ADMIN_TAG], undefined, registry);
}

/** The hub's read fns (`HUB_READ_ENDPOINTS`), each described for the agent that offers them. */
const readFns = {
  resource_list: readFn('List resources (files, pages, uploads) from every system and the hub, filtered, grouped and paged.', 'Use it to browse what exists (the files of a root, the pages a crawl kept, the uploads of a session) when you know where to look; to find something by what it says use hub/search_resources. Filter by root, system or kind and page on rather than asking for everything.', HUB_READ_ENDPOINTS.resource_list, [{ args: { system: 'fs', under: 'file:///repo/docs', limit: 20 }, note: 'The first 20 files under one folder.' }, { args: { source: 'upload', group: 'date' }, note: 'Uploads, grouped by day.' }]),
  resource_read: readFn('Read a resource as text: its primary form (markdown for pages, tables for spreadsheets, pages for a PDF) or a chosen form, whole or by sections.', 'Use it to read a resource you have the uri of: a file the person attached (uploads are `hub://resources/uploads/<day>/<name>`; find one with hub/search_resources or hub/resource_list), a page the web system read, a file a system serves. Read it before you say anything about what it holds. Leave out `form` to read its primary form; name a form only when you need that one, and only one it has (`forms` in a reply lists them: `pages` for a PDF, `table` for a spreadsheet or CSV, `markdown` for a page or document). A form it lacks is not refused: its primary form is read instead and `note` says so. For a long one, read its outline first (hub/resource_outline) and then one section, or a window, so the answer fits. When only part came back, `partial` says what part, how much was left out and how to read the rest: read on before you state anything from the rest. Images and audio are read through their text forms (description, transcript); to look at an image itself, use hub/resource_send. A resource with no text form at all is refused with what it has instead: try hub/resource_send, or hub/explore_read for a file a system serves.', HUB_READ_ENDPOINTS.resource_read, [{ args: { uri: 'file:///repo/docs/guide.md', section: 'Install' }, note: 'One section of a long file.' }, { args: { uri: 'hub://resources/uploads/2026-11-22/report.pdf', maxChars: 4000 }, note: 'The start of a long upload, in its primary form.' }, { args: { uri: 'hub://resources/uploads/2026-11-22/report.pdf', form: 'pages', offset: 4000, maxChars: 4000 }, note: 'Reading on where `partial` said the rest starts.' }]),
  ctx_get: readFn('One context item (a guide, skill, memory or piece of a resource) with its text and its links both ways.', 'Use it to read one context item in full, with what links to it and what it links to, after a search or a mention named it. To keep it in front of you for the rest of the session use hub/load instead.', HUB_READ_ENDPOINTS.ctx_get, [{ args: { name: 'fs/authoring' }, note: 'A guide and what it brings.' }]),
  types_get: readFn('The definitions of named types and of every type they refer to, dependencies first.', 'Use it before writing args or a payload that use a named type (a table type, fs/Entry): it gives each type\'s fields and every type they refer to, so you need one call. Ask for several names at once.', HUB_READ_ENDPOINTS.types_get, [{ args: { names: ['fs/Entry'] }, note: 'A type and the types it uses.' }]),
  runs_list: readFn('Runs, newest first, filtered by fn, status, session or system. A member sees their own runs.', 'Use it to find earlier runs (what ran, when, how it ended), for example to see why something failed. Filter by fn, status or session, newest first, and page; then hub/run_get for one run.', HUB_READ_ENDPOINTS.runs_list, [{ args: { limit: 10 }, note: 'The ten newest runs.' }]),
  run_get: readFn('One run: its fn, args, status, result or error, cost and timings.', 'Use it to see one run in full: its args, result or error, cost and how long it took. For a run still going use hub/run_status or hub/run_wait.', HUB_READ_ENDPOINTS.run_get, [{ args: { run: 'run_01HZX3' } }]),
  run_tree: readFn('The tree of runs a turn made: each run with the runs it called.', 'Use it to see everything one turn did, as a tree: each run with the runs it called. Good for explaining what happened or where a chain failed.', HUB_READ_ENDPOINTS.run_tree, [{ args: { turn: 'trn_01HZX3' }, note: 'Every run one message started.' }]),
  llm_call: readFn('One LLM call: its whole request and response, tokens, cost and timings.', 'Use it to look at one model call exactly as sent and received (messages, tools, tokens, cost) when a run\'s behaviour needs explaining. It can be long: read it only when the summary in hub/run_get is not enough.', HUB_READ_ENDPOINTS.llm_call, [{ args: { id: 'llm_01HZX3' }, note: 'What the model was sent and answered.' }]),
  model_calls: readFn('Model calls of every kind (chat, embeddings, images, transcription, speech), newest first, with cost and timings.', 'Use it for cost and timing questions across models (what cost the most today, which calls were slow). Narrow with `run` (one run\'s calls), or with `query`: its filters and sort take only these fields: modality, model, provider, system, status, session, cost, tokens, duration and createdAt (the start; `startedAt` in a result is not a filter field). Page on; one call\'s detail is hub/llm_call. Leave out an arg you don\'t use rather than sending null.', HUB_READ_ENDPOINTS.model_calls, [{ args: { run: 'run_01HZX3' }, note: 'What one run spent on models.' }]),
  fns_metrics: readFn('How fns have been doing: runs, outcomes, retries, durations (p50, p95), queue waits, cost and tokens.', 'Use it to say how a fn usually behaves: how often it fails, how long it usually takes (p50) and when it is slow (p95), and what it costs. Quote these numbers rather than guessing. `outcomes.failed` counts the fn\'s own failures; `outcomes.invalid-input` counts calls whose args didn\'t fit and went back to the caller to fix, which say nothing about the fn: leave them out of how often it fails.', HUB_READ_ENDPOINTS.fns_metrics, [{ args: { fn: 'fs/read', days: 7 }, note: 'A week of one fn.' }]),
  sessions_list: readFn('The person\'s chats (sessions), most recent first, each with its id, title and when it was last used.', 'Use it when the person refers to an earlier conversation ("what did we decide about the launch?"): look for a title that fits, then read that chat with hub/session_messages. Memories are another place earlier facts may be kept (hub/ctx_search with `origins: ["memory"]`).', HUB_READ_ENDPOINTS.sessions_list, [{ args: { limit: 20 } }]),
  session_messages: readFn('A session\'s messages, newest first, paged backwards.', 'Use it to read what was said in an earlier chat, with the session id hub/sessions_list gave. It comes newest first; page backwards for older messages, and read only as far back as the question needs. Quote or sum up what the messages say; don\'t fill gaps from memory.', HUB_READ_ENDPOINTS.session_messages, [{ args: { session: 'ses_01HZX3', limit: 30 }, note: 'The last 30 messages.' }]),
  systems_list: readFn('Every system: whether it is connected, its version, instances and what it offers.', 'Use it to see which systems are installed, connected and configured before relying on one; a system that is not connected has no usable fns.', HUB_READ_ENDPOINTS.systems_list, [{ args: {}, note: 'Every system and its status.' }]),
  system_get: readFn('One system: its status, version, instances, config state and what it offers.', 'Use it for one system\'s state: whether it is connected, its instances and whether its config is set. When a fn of it is unavailable this usually says why.', HUB_READ_ENDPOINTS.system_get, [{ args: { system: 'fs' } }]),
  system_fns: readFn('A system\'s fns, with whether each can be used now and its running numbers.', 'Use it to list what one system offers and which of its fns can be used now, with how they have been doing.', HUB_READ_ENDPOINTS.system_fns, [{ args: { system: 'database' }, note: 'Everything one system offers.' }]),
  system_logs: readFn('The end of a system\'s output, oldest first.', 'Use it to see why a system misbehaves: the end of its output. Admins only; read the end first and go further back only if needed.', HUB_READ_ENDPOINTS.system_logs, [{ args: { system: 'fs', limit: 50 }, note: 'The last 50 lines, to read a crash.' }]),
  model_roles: readFn('Which model (and provider) the hub uses for each job: chat, transcription, dictation, speech, describing images, reading text in them.', 'Use it to say which model does which job (chat, transcription, describing images, ...); to change one an admin uses hub/set_model_role.', HUB_READ_ENDPOINTS.model_roles, [{ args: {}, note: 'Which model does what.' }]),
  model_limits: readFn('Each model\'s context window, output limit, reasoning reserve and characters per token, with where each came from.', 'Use it when a prompt does not fit or an answer is cut: each model\'s window and output limit, and where the numbers came from.', HUB_READ_ENDPOINTS.model_limits, [{ args: { model: 'qwen2.5:3b' } }]),
  query: readFn(`Any list (${LIST_NAMES.join(', ')}) by the query standard: free text, filters on the list's fields (is, in, >, <, between, empty, contains, ...), a sort and paging.`, 'Use it for any list question with conditions (runs that failed this week, the biggest resources, fns of one system): name the list, add filters on its fields, a sort and a small page size, and page on. Never ask for everything.', HUB_READ_ENDPOINTS.query, [{ args: { list: 'runs', query: { text: 'install', limit: 10 } }, note: 'Runs whose words match.' }, { args: { list: 'contexts', query: { limit: 20 } }, note: 'A page of context items.' }]),
  graph: readFn(
    'The graph of what systems add (fns, context, types, kinds, commands, components, providers) and how they connect: what brings, calls, reads, writes, creates or refers to what.',
    'Use it to explain how things connect ("how does the fs authoring context reach the database fns?"): give `systems` for one system graph (what it references elsewhere comes back as `external`), or `focus` on one node (`fn:database/run_query`, `context:fs/authoring`, `type:database/main.projects`) with `hops` for its neighbourhood. Narrow with `text` and `filters`, the query standard over the `graph` list (the same as hub/query: fields name, system, nodeKind, edgeKind, fnKind, mode, effect, visibility, stage, on; ops is, in, notIn, contains, ...), and keep `limit` small; `more` says what was left out, so focus on that node to see it. The `label` of each edge says the relation in plain words.',
    HUB_READ_ENDPOINTS.graph,
    [
      { args: { focus: { node: 'context:fs/authoring', hops: 2 }, limit: 40 }, note: 'What a context item brings and what those reach, two hops out.' },
      { args: { systems: ['database'], filters: [{ field: 'nodeKind', op: 'in', values: ['fn', 'type'] }, { field: 'edgeKind', op: 'in', values: ['reads', 'writes'] }] }, note: 'Which database fns read and write which types.' },
      { args: { filters: [{ field: 'effect', op: 'is', value: 'fns' }, { field: 'nodeKind', op: 'in', values: ['fn', 'kind'] }] }, note: 'Every fn that creates or changes fns, and the kinds it makes.' },
    ],
  ),
  item_versions: readFn(
    'The version history of one item a system declared or added while running (a fn, type, context item, kind, command, component, provider, ...): each version\'s declaration, how it changed, and who saved it, newest first.',
    'Use it to say what changed in an item and when ("what did the project form look like before?", "when did fs/read change?"): give the system, the section and the name as the system page lists it (qualified, like `input/project`, or a `/command`). Each version holds the whole declaration; compare two to say what changed. Page with a small limit.',
    HUB_READ_ENDPOINTS.item_versions,
    [
      { args: { system: 'input', section: 'fns', name: 'input/project', limit: 5 }, note: 'The last five versions of a saved form.' },
      { args: { system: 'fs', section: 'context', name: 'fs/authoring' }, note: 'How a guide changed over time.' },
    ],
  ),
} satisfies Record<HubReadFnName, unknown>;

/** The data system's fns (`HUB_DATA_ENDPOINTS`). */
const dataFns = {
  data_sets: readFn(
    'The stored types (the data system\'s record sets) you can see, each with how many records it holds and when one last changed.',
    'Use it to find where data lives before reading or saving records: it names each stored type (`notes/Note`) with its description and its record count. Filter by `text` or `system`.',
    HUB_DATA_ENDPOINTS.data_sets,
    [{ args: { text: 'notes' }, note: 'The stored types about notes.' }, { args: { system: 'notes', limit: 20 } }],
  ),
  records_find: readFn(
    'Records of one stored type: filtered and sorted on its fields, searched by words (and meaning, when the type is embedded), a page at a time.',
    'Use it to answer questions about stored data ("my notes about the launch", "tasks due this week"): name the `type`, put conditions in `query.filters` on its top-level fields (is, in, >, <, between, contains, empty), a `query.sort`, and words in `search`. Keep `query.limit` small and page with the cursor. For a table to draw, use hub/records_table.',
    HUB_DATA_ENDPOINTS.records_find,
    [
      { args: { type: 'notes/Note', search: 'launch plan', query: { limit: 5 } }, note: 'The five notes that best match some words.' },
      { args: { type: 'tasks/Task', query: { filters: [{ field: 'done', op: 'is', value: false }], sort: [{ field: 'due', dir: 'asc' }], limit: 10 } }, note: 'Open tasks, soonest first.' },
    ],
  ),
  record_get: readFn(
    'One record of a stored type by its id, with its value, version and who changed it last.',
    'Use it to read one record whose id you have (from hub/records_find or a row of a table) before changing it: pass its `version` as `expect` to hub/record_save so a change made meanwhile is not lost.',
    HUB_DATA_ENDPOINTS.record_get,
    [{ args: { type: 'notes/Note', id: 'rec_01HZX3' } }],
  ),
  records_table: readFn(
    'Records of one stored type as a table (one column per field, then the record id), offset-paged: what widgets and the result view draw.',
    'Use it when the person wants to see records laid out (a grid, a chart) or to keep them as a widget (widgets/make_widget): it takes the same filters, sort and search as hub/records_find, with `offset` and `limit` for paging. Its last column is the record id, which row actions use.',
    HUB_DATA_ENDPOINTS.records_table,
    [{ args: { type: 'tasks/Task', query: { sort: [{ field: 'due', dir: 'asc' }] }, limit: 20 }, note: 'The first twenty tasks as a table.' }],
  ),
  record_versions: readFn(
    'A record\'s history, newest first: each version\'s value, how it changed, and who changed it.',
    'Use it to say what a record looked like before or who changed it ("what did the note say yesterday?"). Page with a small limit.',
    HUB_DATA_ENDPOINTS.record_versions,
    [{ args: { type: 'notes/Note', id: 'rec_01HZX3', limit: 5 } }],
  ),
  record_save: writeFn(
    'Add a record to a stored type, or replace one (with its id); the value is checked against the type.',
    'Use it when the person asks to keep or change data. Leave out `id` to add a record; to change one, read it first and pass its id with the whole new value and `expect` set to the version you read, so someone else\'s change made meanwhile is refused rather than lost. A value that does not fit the type is refused with what is wrong.',
    HUB_DATA_ENDPOINTS.record_save,
    [
      { args: { type: 'notes/Note', value: { title: 'Launch plan', body: 'Draft the timeline.' } }, note: 'A new note.' },
      { args: { type: 'tasks/Task', id: 'rec_01HZX3', value: { title: 'Pay rent', done: true }, expect: 3 }, note: 'Mark a task done, if nobody changed it since version 3.' },
    ],
    [],
    [...changes('create', 'records'), ...changes('update', 'records')],
  ),
  record_update: writeFn(
    'Change some fields of one record in place, keeping the rest; the merged value is checked against the type.',
    'Use it when the person changes a few fields of a record (a grid edit, "mark it done"): give its id and only the fields that change in `set`. Pass the version you read as `expect` so a change made meanwhile is refused rather than lost; without it the version it reads now is used.',
    HUB_DATA_ENDPOINTS.record_update,
    [{ args: { type: 'tasks/Task', id: 'rec_01HZX3', set: { done: true }, expect: 3 }, note: 'Mark a task done, if nobody changed it since version 3.' }],
  ),
  record_remove: writeFn(
    'Remove a record of a stored type; its history stays.',
    'Use it only when the person asks to delete a record. Say what you removed; its versions can still be read with hub/record_versions.',
    HUB_DATA_ENDPOINTS.record_remove,
    [{ args: { type: 'notes/Note', id: 'rec_01HZX3' } }],
    [],
    changes('remove', 'records'),
  ),
} satisfies Record<HubDataFnName, unknown>;

/** The hub's write fns on resources, context and memory (`HUB_WRITE_ENDPOINTS`). */
const writeFns = {
  resource_convert: writeFn('Make another form of a resource now (a document as markdown, a description of an image, the text read from an image, a transcript of audio); it may cost a model call.', 'Use it only when hub/resource_read says the form you need is missing (an image never described, audio not transcribed). It is not needed to look at an image: hub/resource_send shows you the image itself. Some forms need a model an admin has set up (describing images, reading text in them); when one is not set up it is refused with why: use hub/resource_send for an image instead, or tell the person.', HUB_WRITE_ENDPOINTS.resource_convert, [{ args: { uri: 'hub://resources/uploads/2026-11-22/report.pdf', kind: 'markdown' }, note: 'An uploaded PDF as markdown.' }]),
  resource_import: writeFn('Import a URL or uploaded content as a hub resource, kept and converted by the hub.', 'Use it to keep a URL or an upload as a hub resource so it can be read, searched and linked later. It returns the uri; read it with hub/resource_read.', HUB_WRITE_ENDPOINTS.resource_import, [{ args: { url: 'https://example.com/docs', render: 'auto' }, note: 'A web page, kept as a hub resource.' }], [OWN_TAG], changes('create', 'resources')),
  resource_rename: writeFn('Rename a hub resource.', 'Use it when the person asks to rename a hub resource. Only hub resources (imports, uploads) can be renamed; a system\'s files are renamed through that system (fs).', HUB_WRITE_ENDPOINTS.resource_rename, [{ args: { uri: 'hub://resources/notes.md', name: 'meeting-notes.md' } }], [], changes('update', 'resources')),
  resource_delete: writeFn('Delete a hub resource; says how many messages, context items and runs still point at it.', 'Use it only when the person asks to delete a hub resource. It reports how many messages, context items and runs still point at it: tell the person, since those links will show as gone.', HUB_WRITE_ENDPOINTS.resource_delete, [{ args: { uri: 'hub://resources/old.md' } }], [], changes('remove', 'resources')),
  ctx_from_resource: writeFn('Make context items from a resource (one per section, under an outline parent), or update the ones made before.', 'Use it to turn a document the person wants kept as knowledge (a guide, a spec) into context items, one per section; run it again after the document changes to update them.', HUB_WRITE_ENDPOINTS.ctx_from_resource, [{ args: { uri: 'file:///repo/STYLE.md', copy: 'live', tags: ['style'] }, note: 'A style guide kept in step with its file.' }], [], [...changes('create', 'context'), ...changes('update', 'context')]),
  remember: writeFn('Keep a fact for later as a memory (a context item): for this chat, for the person in all their chats, or for everyone.', 'Use it when the person asks you to remember something, or tells you a lasting fact or preference that will matter again. Choose `scope`: `session` (this chat only), `user` (the person, in every chat of theirs: the usual choice for their preferences) or `everyone` (only when they say so). One fact per memory, in a plain sentence, with a short `title`; never a password or other secret. Leave out the other args unless you need them: `about` links the memory to an item it is about (`{ "kind": "fn", "name": "database/main.expenses_create" }`; for a resource `{ "kind": "resource", "uri": … }`, with `section` only to point at one section). A memory is not shown in a new chat by itself: it is found by search (hub/ctx_search with `origins: ["memory"]`). It answers with the memory\'s name.', HUB_WRITE_ENDPOINTS.remember, [{ args: { text: 'Reports go out on Fridays.', scope: 'user', title: 'Report day' }, note: 'A fact about the person, for every session of theirs.' }], [], changes('create', 'context')),
  forget: writeFn('Forget a memory.', 'Use it when the person asks you to forget something, or a memory is wrong. Find the memory first (hub/ctx_search with `origins: ["memory"]`) and forget it by its name.', HUB_WRITE_ENDPOINTS.forget, [{ args: { name: 'hub/memory.report-day' } }], [], changes('update', 'context')),
} satisfies Record<HubWriteFnName, unknown>;

/** A person's write fns (`HUB_PERSON_ENDPOINTS`): each asks unless a policy allows it. */
const personFns = {
  session_create: writeFn('Start a chat session for the person, with an agent and the systems it may use.', 'Use it when the person asks for a fresh conversation, or one with only some systems. It returns the session; tell the person its title.', HUB_PERSON_ENDPOINTS.session_create, [{ args: { title: 'Quarterly report', systems: ['database', 'fs'] }, note: 'A session that uses two systems only.' }]),
  session_update: writeFn('Change a session: its title, systems, agent, priority, model, chat mode or contextor, or archive it.', 'Use it when the person asks to rename, archive or reconfigure a session. Give only the fields that change.', HUB_PERSON_ENDPOINTS.session_update, [{ args: { session: 'ses_01HZX3', title: 'Q3 report' } }, { args: { session: 'ses_01HZX3', archived: true }, note: 'Archive it.' }]),
  session_delete: writeFn('Delete a session and its messages.', 'Use it only when the person asks to delete a session by name; it can\'t be undone, so say which session first.', HUB_PERSON_ENDPOINTS.session_delete, [{ args: { session: 'ses_01HZX3' } }]),
  run_background: writeFn('Move a running run to the background, so the chat can go on while it works.', 'Use it for a long run the person need not wait for; check on it later with hub/run_status.', HUB_PERSON_ENDPOINTS.run_background, [{ args: { run: 'run_01HZX3' } }]),
  turn_undo: writeFn('Undo what one message\'s runs did, where their fns can undo, and take the message out of the chat.', 'Messages are undone newest first: one can only be undone while no later message in its chat stands, so from inside a chat this can\'t undo an earlier message of the same chat (the message you are answering is later). When the person asks to take back an earlier message, tell them to use Undo on that message in the chat (it undoes what came after it too), or reverse the one change with the fn that changes it back. It reports what was undone and what could not be.', HUB_PERSON_ENDPOINTS.turn_undo, [{ args: { turn: 'trn_01HZX3' } }]),
  memory_update: writeFn('Change a memory: its text, title, weight, tags, the fns it brings or where it applies.', 'Use it to correct or narrow a memory rather than forgetting it and remembering again. Give its name and only what changes.', HUB_PERSON_ENDPOINTS.memory_update, [{ args: { name: 'hub/memory.report-day', text: 'Reports go out on Thursdays.' } }], [], changes('update', 'context')),
  ctx_link: writeFn('Link a context item to another item (context, fn, type or resource), with a relation and weight.', 'Use it to say what a context item imports, brings or relates to, so it loads with its context and fns. `imports` and `brings` always load with it.', HUB_PERSON_ENDPOINTS.ctx_link, [{ args: { from: 'hub/memory.report-day', to: { kind: 'fn', name: 'database/sales_by_month' }, relation: 'brings', weight: 1 }, note: 'A memory that brings the fn its work needs.' }], [], changes('update', 'context')),
  ctx_unlink: writeFn('Remove one link from a context item.', 'Use it when a link is wrong or no longer needed; give the link\'s target key and relation as hub/ctx_get shows them.', HUB_PERSON_ENDPOINTS.ctx_unlink, [{ args: { from: 'hub/memory.report-day', toKey: 'fn:database/sales_by_month', relation: 'brings' } }], [], changes('update', 'context')),
  access_set: writeFn('Set who may see a system, fn, context item, resource root or connection: private, shared with some, or public.', 'Use it when the person asks to share something or make it private. Only its owner or an admin may change it; say who will see it after.', HUB_PERSON_ENDPOINTS.access_set, [{ args: { target: { kind: 'fn', fn: 'input/project_details' }, sharing: { visibility: 'shared', with: ['act_01HZX3'] } }, note: 'Share a saved form with one person.' }]),
  connection_update: writeFn('Change one of the person\'s connected accounts: its settings, which fns use it, or who it is shared with.', 'Use it when the person asks to change how a connected account is used. Never show its credentials.', HUB_PERSON_ENDPOINTS.connection_update, [{ args: { connection: 'cnx_01HZX3', share: { visibility: 'private', with: [] } }, note: 'Stop sharing it.' }], [], changes('update', 'connections')),
  connection_disconnect: writeFn('Disconnect one of the person\'s connected accounts.', 'Use it only when the person asks to disconnect an account; the fns that act as them stop working until they connect again.', HUB_PERSON_ENDPOINTS.connection_disconnect, [{ args: { connection: 'cnx_01HZX3' } }], [], changes('remove', 'connections')),
};

/** The explorer's reads (`HUB_EXPLORE_ENDPOINTS`), tagged `read`. */
const exploreFns = {
  explore_roots: readFn('The roots one system instance serves files from (folders, sites), live.', 'Use it first to see where a system keeps its files, then list a root with hub/explore_list. Nothing is copied into the hub.', HUB_EXPLORE_ENDPOINTS.explore_roots, [{ args: { system: 'fs', instance: 'main' } }]),
  explore_list: readFn('What a folder holds, live from the system that serves it, a page at a time.', 'Use it to walk a folder you got from hub/explore_roots or an earlier listing; page with `cursor`. To find files by what they say, use hub/search_resources.', HUB_EXPLORE_ENDPOINTS.explore_list, [{ args: { uri: 'file:///repo/docs' } }]),
  explore_read: readFn('One file\'s text (or its bytes by content ref) or its links, live from the system that serves it, without keeping it in the hub.', 'Use it to look at a file a system serves while browsing, or when hub/resource_read has no text form of it (a PDF on disk): it asks the serving system for the text. To keep and search it later, import it with hub/resource_import.', HUB_EXPLORE_ENDPOINTS.explore_read, [{ args: { uri: 'file:///repo/README.md', want: ['text'] } }]),
};

/** The admin pages' reads (`ADMIN_READ_ENDPOINTS`), tagged `admin` and `read`. */
const adminReadFns = {
  budgets_list: adminReadFn('Every budget rule with what it has spent so far.', 'Use it before changing a budget, or to say why a call was refused or is waiting.', ADMIN_READ_ENDPOINTS.budgets_list, [{ args: {} }]),
  policies_list: adminReadFn('Every policy: who it is for, which fns, and whether they run, ask or are refused.', 'Use it to explain why a fn asks or is refused, and before adding a policy that might clash.', ADMIN_READ_ENDPOINTS.policies_list, [{ args: {} }]),
  priority_rules_list: adminReadFn('Every priority rule: the default and highest priority of the hub, groups, people and sessions.', 'Use it before changing priorities, or to say why work waits.', ADMIN_READ_ENDPOINTS.priority_rules_list, [{ args: {} }]),
  providers_list: adminReadFn('The model providers set up, with how many models each offers.', 'Use it to check a provider is set up before choosing its models. Keys are never shown.', ADMIN_READ_ENDPOINTS.providers_list, [{ args: {} }]),
  actors_list: adminReadFn('People, groups, agents, systems and hub MCPs the hub knows, optionally of one kind.', 'Use it to find a person\'s or group\'s id before sharing, adding a policy or a budget.', ADMIN_READ_ENDPOINTS.actors_list, [{ args: { kind: 'user' }, note: 'Every person.' }]),
  actor_settings_list: adminReadFn('The settings systems declare, and the values set for people and groups.', 'Use it before changing a setting with hub/set_actor_setting.', ADMIN_READ_ENDPOINTS.actor_settings_list, [{ args: {} }]),
  mcps_list: adminReadFn('The hub MCPs: what each exposes, for whom, and whether it is on.', 'Use it before creating or changing a hub MCP.', ADMIN_READ_ENDPOINTS.mcps_list, [{ args: {} }]),
  mcp_sessions_list: adminReadFn('The clients connected to one hub MCP now.', 'Use it to see who uses a hub MCP before switching it off.', ADMIN_READ_ENDPOINTS.mcp_sessions_list, [{ args: { mcp: 'mcp_01HZX3' } }]),
  pairings_list: adminReadFn('Pairing requests, newest first, optionally of one status.', 'Use it to find a waiting pairing to approve with hub/approve_pairing.', ADMIN_READ_ENDPOINTS.pairings_list, [{ args: { status: 'pending' } }]),
  auto_pairs_list: adminReadFn('The auto-pair secrets granted, optionally for one system.', 'Use it before revoking one with hub/auto_pair_revoke.', ADMIN_READ_ENDPOINTS.auto_pairs_list, [{ args: { system: 'fs' } }]),
  instances_list: adminReadFn('One system\'s instances, with their status, version, config (secrets masked) and host.', 'Use it to see every copy of a system and who hosts each.', ADMIN_READ_ENDPOINTS.instances_list, [{ args: { system: 'database' } }]),
  suggest_decision_get: adminReadFn('The suggestions setting: who picks what each message is offered (a decision model, an LLM, or none: the best by similarity over the threshold), and its limits.', 'Use it before changing it with hub/suggest_decision_set.', ADMIN_READ_ENDPOINTS.suggest_decision_get, [{ args: {} }]),
  search_decision_get: adminReadFn('The search decisions: who filters search hits before they are returned, for fns and for context (none, a decision model or an LLM).', 'Use it before changing one with hub/search_decision_set.', ADMIN_READ_ENDPOINTS.search_decision_get, [{ args: {} }]),
  ctx_injections_list: adminReadFn(
    'What is injected into agents\' system prompts: for each agent (a fn that runs a model, such as hub/chat), the context items and hook notes the hub puts into its instructions, in order, each with its text as the model reads it, its tokens, whether an admin left it on for that agent, and why it is left out if it is (switched off, waiting for review, declined, its system off, its fns unusable, the other chat mode, replaced by another item, or no room).',
    'Use it when an admin asks what an agent is told, why an agent knows or does not know something, or before switching an item with hub/ctx_injection_set. Give `agent` for one agent\'s list, `context` for one item in every agent it reaches (the answer then also lists its targets and the agents each hits), or both. Each entry\'s `via` is the target that took it in (an agent\'s name or a pattern such as `hub/chat*`). It shows what a new chat with that agent would be told, every system on; give `mode` (`tools` or `static`) or `fnMode` (`read`, `write`, `delete`, `none`) to see it as a chat with that setting gets it. Tokens are estimates.',
    ADMIN_READ_ENDPOINTS.ctx_injections_list,
    [
      { args: { agent: 'hub/chat' }, note: 'Everything the chat agent is told, in order.' },
      { args: { context: 'input/asking' }, note: 'One item: which agents get it, and how it reads in each.' },
      { args: { agent: 'hub/chat', fnMode: 'read' }, note: 'What the chat agent is told in a chat that may only read.' },
    ],
  ),
};

/** The hub's admin fns (`ADMIN_ENDPOINTS`), each described for the agent that offers them. */
const adminFns = {
  configure_provider: adminFn('Add a model provider (OpenAI, OpenRouter, Ollama) with its API key, or replace its key. The key is stored encrypted.', 'Use it when an admin gives a provider key. Never repeat the key back or put it in a message; say only that it was stored.', ADMIN_ENDPOINTS.configure_provider, [{ args: { provider: 'ollama', baseURL: 'http://127.0.0.1:11434' }, note: 'A local Ollama.' }], changes('update', 'secrets')),
  set_model_category: adminFn('Add a model category (a named, ordered list of models), or change the one with this id.', 'Use it to group models for a purpose (fast, cheap, best). Order matters: the first available model is tried first.', ADMIN_ENDPOINTS.set_model_category, [{ args: { name: 'small', description: 'Fast local models.', models: ['qwen2.5:3b'] } }]),
  set_budget: adminFn('Add a spending budget for the hub, a group, a user, a session, a system, a fn or a model, or change the one with this id.', 'Use it when an admin sets a spending limit. Say the scope and period back in plain words, since a low budget stops runs.', ADMIN_ENDPOINTS.set_budget, [{ args: { target: { scope: 'system', system: 'web' }, period: 'per-turn', maxCost: 0.5, onLimit: 'ask' }, note: 'Fifty cents a message for one system.' }]),
  set_priority: adminFn('Add a priority rule (the default and highest priority of turns at a level), or change the one with this id.', 'Use it when an admin wants some turns to run before others (a group\'s work first).', ADMIN_ENDPOINTS.set_priority, [{ args: { target: { scope: 'hub' }, default: 'normal', max: 'interactive' } }]),
  set_policy: adminFn('Add a policy saying whether actors may run fns (allow, deny, or ask an approver), or change the one with this id.', 'Use it when an admin decides who may run which fns. `subject` is who: `{ "actor": … }`, `{ "group": … }`, `{ "kind": "user" }` or `{ "everyone": true }`. `target` is which fns, and every field given must match: `fn` (a fn\'s name as your tools spell it, or a glob over names such as `fs/*`, every fs fn), `system`, `kind` (`native` or a system\'s kind such as `database/query`; `*` is not a kind: leave `kind` out to cover every kind), `tags` (fns carrying all of these tags, such as `["admin"]`). There is no target for "every fn that deletes" or "everything that costs money": name the fns or systems. `decision` is `{ "effect": "allow" }`, `{ "effect": "deny", "reason": … }` or `{ "effect": "ask", "approver": { "by": "turn-user" } }`. Deny beats ask beats allow, and a narrower match beats a broader one; with no policy, fns tagged read run and the rest ask the person. Prefer ask over allow for fns that write or delete. Before saving, tell the person in plain words exactly which fns the rule covers (a glob or a system also covers fns added later that match it, a fn\'s name only that fn).', ADMIN_ENDPOINTS.set_policy, [{ args: { description: 'Members may read files without asking.', subject: { kind: 'user' }, target: { fn: 'fs/read' }, decision: { effect: 'allow' }, priority: 10 } }]),
  set_actor_setting: adminFn('Set a setting a system declares for a user, group or agent.', 'Use it to set a system\'s declared setting for a user, group or agent. Read the setting\'s type first (hub/system_get) so the value fits.', ADMIN_ENDPOINTS.set_actor_setting, [{ args: { setting: 'fs/editor', actor: 'act_01HZX3', value: 'vim' } }]),
  add_user: adminFn('Add a person who can sign in, with their role and groups.', 'Use it when an admin adds a person. Give the lowest role that does the job, and say what the role allows.', ADMIN_ENDPOINTS.add_user, [{ args: { email: 'ann@example.com', name: 'Ann', role: 'member' } }]),
  add_group: adminFn('Add a group of people.', 'Use it to make a group before adding people or rules to it.', ADMIN_ENDPOINTS.add_group, [{ args: { name: 'Finance', about: 'The finance team.' } }]),
  update_user: adminFn('Change a person: their name, their role (admin or member), or whether they can sign in.', 'Use it when an admin renames a person, changes their role or turns their sign-in off or back on. Turning sign-in off signs them out everywhere. The break-glass admin always stays an enabled admin, and a role a sign-in provider manages is set again at their next sign-in.', ADMIN_ENDPOINTS.update_user, [{ args: { user: 'act_01HZX3', role: 'admin' }, note: 'Make Ann an admin.' }, { args: { user: 'act_01HZX3', disabled: true }, note: 'Sign Ann out and keep her out.' }]),
  set_membership: adminFn('Put a person in a group, or take them out.', 'Use it to change who is in a group. A group a sign-in provider syncs from its claims is set again at the person\x27s next sign-in.', ADMIN_ENDPOINTS.set_membership, [{ args: { group: 'act_01HZX4', user: 'act_01HZX3', member: true }, note: 'Add Ann to Finance.' }]),
  set_sign_in_policy: adminFn('Set who may make an account by signing in through a sign-in provider for the first time: only invited people, people at some email domains, or anyone.', 'Use it when an admin decides who can join through single sign-on. Invite only is the safest; say back what the choice lets in.', ADMIN_ENDPOINTS.set_sign_in_policy, [{ args: { mode: 'invite' }, note: 'Only people an admin added.' }, { args: { mode: 'domains', domains: ['example.com'] }, note: 'Anyone with a verified example.com email.' }]),
  set_sign_in_limits: adminFn('Set how many password sign-ins the hub takes: tries for one email from one address, and tries from one address in all, each in a time window (ms).', 'Use it when an admin wants sign-in guessing slowed down more or less. Lower limits are safer; say back how many tries each allows and over how long.', ADMIN_ENDPOINTS.set_sign_in_limits, [{ args: { account: { limit: 10, window: 900000 }, address: { limit: 100, window: 900000 } }, note: 'The defaults: per address, 10 tries for one email and 100 in all every 15 minutes.' }]),
  set_proxy_trust: adminFn('Set how many proxies in front of the hub say where requests come from (X-Forwarded-For); 0 means none, and the connection\'s own address counts.', 'Use it only when an admin says the hub runs behind a reverse proxy. Trusting a proxy that isn\'t there lets anyone pick the address their requests seem to come from.', ADMIN_ENDPOINTS.set_proxy_trust, [{ args: { proxies: 1 }, note: 'One reverse proxy (nginx, Caddy) in front of the hub.' }, { args: { proxies: 0 }, note: 'No proxy: the default.' }]),
  remove_rule: adminFn('Remove a budget, priority rule, policy, model category or provider.', 'Use it only when an admin asks to remove a rule; say what stops applying once it is gone.', ADMIN_ENDPOINTS.remove_rule, [{ args: { kind: 'policy', id: 'pol_01HZX3' } }]),
  approve_pairing: adminFn('Approve or refuse a system that asked to pair with the hub, optionally naming its instance and setting its config.', 'Use it when an admin approves or refuses a waiting system. Name the instance when there are several of one system, and set its config here if it needs one to start.', ADMIN_ENDPOINTS.approve_pairing, [{ args: { pairing: 'par_01HZX3', approve: true }, note: 'The code on the system matches.' }]),
  create_pairing_token: adminFn('Make a one-time pairing token a new system can pair with, optionally for one system name.', 'Use it to let a new system pair. The token is shown once: give it to the admin and do not repeat it later.', ADMIN_ENDPOINTS.create_pairing_token, [{ args: { name: 'notes', expiresIn: 600000 }, note: 'A ten-minute token for one system.' }]),
  configure_system: adminFn('Set a system\'s config; refused unless it fits the system\'s config type.', 'Use it to set a system\'s config. Read its config type first (hub/system_get); secret fields are kept encrypted and never shown back.', ADMIN_ENDPOINTS.configure_system, [{ args: { system: 'database', config: { url: 'sqlite:./data.db' } } }]),
  enable_system: adminFn('Turn a system\'s functions, its renderers and all of its context on or off.', 'Use it to turn a system\'s fns, renderers or all of its context on or off without removing it. To switch one fn or context item, use hub/switch_item.', ADMIN_ENDPOINTS.enable_system, [{ args: { system: 'web', functions: false }, note: 'Switch off its fns, keep its renderers.' }, { args: { system: 'fs', context: false }, note: 'Leave all of fs\'s context out of chats; its fns still work.' }], changes('update', 'fns', 'context')),
  switch_item: adminFn('Turn one fn or context item of a system on or off.', 'Use it when an admin asks to switch a single fn or context item off or back on. A fn switched off cannot run; a context item switched off is never selected, searched or loaded. To switch a whole system, use hub/enable_system.', ADMIN_ENDPOINTS.switch_item, [{ args: { section: 'fns', name: 'fs/delete', on: false }, note: 'Stop fs/delete from running.' }, { args: { section: 'context', name: 'fs/guide', on: true }, note: 'Bring a context item back.' }], changes('update', 'fns', 'context')),
  remove_system: adminFn('Remove a system; its fns become unavailable until it pairs again.', 'Use it only when an admin asks to remove a system; its fns stop working until it pairs again. To pause it, use hub/enable_system instead.', ADMIN_ENDPOINTS.remove_system, [{ args: { system: 'random' } }], changes('update', 'fns')),
  install_system: adminFn('Install a system from a folder, a package or a git repository, and start it.', 'Use it when an admin asks to install a system from a folder, a package or a git URL. It starts the system; pairing may still need approval.', ADMIN_ENDPOINTS.install_system, [{ args: { source: { package: '@acme/notes', version: '1.2.0' } } }], changes('create', 'fns', 'types', 'context', 'kinds', 'components')),
  start_system: adminFn('Start an installed system.', 'Use it to start an installed system that is stopped, then check hub/system_get to see that it connected.', ADMIN_ENDPOINTS.start_system, [{ args: { system: 'fs' } }]),
  stop_system: adminFn('Stop an installed system.', 'Use it to stop an installed system; its fns are unavailable until it starts again.', ADMIN_ENDPOINTS.stop_system, [{ args: { system: 'fs' } }]),
  restart_system: adminFn('Restart a system instance, with the reason.', 'Use it when a system is stuck or after changing something it reads only at start. A system installed from the chat is restarted by its host with the approved code as it is. Say why in `reason`; it is kept in the log.', ADMIN_ENDPOINTS.restart_system, [{ args: { system: 'random', reason: 'it stopped answering' } }]),
  upgrade_system: adminFn('Upgrade an installed system to a version (the latest when none is given).', 'Use it to move an installed system to a newer version; name the version when the admin asks for one.', ADMIN_ENDPOINTS.upgrade_system, [{ args: { system: 'web' }, note: 'To the newest version.' }], changes('update', 'fns', 'types', 'context', 'kinds', 'components')),
  set_model_role: adminFn('Choose the model (and provider) for a job: chat, transcription, dictation (or the browser\'s own), speech, describing images, reading text in them.', 'Use it when an admin picks the model for a job. Check the current choices with hub/model_roles first.', ADMIN_ENDPOINTS.set_model_role, [{ args: { role: 'chat', model: { model: 'qwen2.5:3b' }, provider: 'ollama' } }]),
  clear_model_role: adminFn('Clear a job\'s model choice, so it falls back to the hub\'s default (or is off).', 'Use it to undo a job\'s model choice so the hub\'s default applies again.', ADMIN_ENDPOINTS.clear_model_role, [{ args: { role: 'describe' } }]),
  set_model_limits: adminFn('Set a model\'s context window, output limit, reasoning reserve or characters per token; with every field absent, clear them.', 'Use it when a model\'s known limits are wrong (answers cut, prompts refused). Leave every field empty to go back to the limits the hub found.', ADMIN_ENDPOINTS.set_model_limits, [{ args: { model: 'qwen2.5:3b', limits: { contextWindow: 32768 } } }]),
  create_mcp: adminFn('Make a hub MCP: an MCP endpoint with its own route and secret, exposing the systems, fns, types, context and resources its rules include.', 'Use it to expose part of the hub to an MCP client. Include only what the admin asked for, and check it first with hub/preview_mcp.', ADMIN_ENDPOINTS.create_mcp, [{ args: { slug: 'notes', name: 'Notes', instructions: 'Read and search notes.', rules: { include: { systems: ['notes'] }, exclude: {} }, toolMode: 'each', user: 'act_01HZX3', grantees: [], origins: [], enabled: true } }]),
  update_mcp: adminFn('Change a hub MCP\'s name, rules, tool mode or person, or turn it on or off.', 'Use it to change a hub MCP; preview rule changes with hub/preview_mcp first.', ADMIN_ENDPOINTS.update_mcp, [{ args: { mcp: 'mcp_01HZX3', enabled: false }, note: 'Switch one off.' }]),
  rotate_mcp_secret: adminFn('Give a hub MCP a new secret; every open session of it ends.', 'Use it when a hub MCP\'s secret may have leaked. Every open session of it ends, so say so.', ADMIN_ENDPOINTS.rotate_mcp_secret, [{ args: { mcp: 'mcp_01HZX3' } }]),
  delete_mcp: adminFn('Delete a hub MCP.', 'Use it only when an admin asks to delete a hub MCP; its clients stop working.', ADMIN_ENDPOINTS.delete_mcp, [{ args: { mcp: 'mcp_01HZX3' } }]),
  preview_mcp: adminFn('What draft hub MCP rules would expose now, with warnings, before they are saved.', 'Use it before saving hub MCP rules, to show the admin exactly what would be exposed and any warnings.', ADMIN_ENDPOINTS.preview_mcp, [{ args: { rules: { include: { systems: ['fs'] }, exclude: { fns: [{ fn: 'fs/bash' }] } } }, note: 'What an MCP with these rules would expose.' }]),
  install_package: adminFn('Install a system package zip (made by `harness system pack`), pair it, configure it and start it.', 'Use it with a package zip made by `harness system pack`: it installs, pairs, configures and starts the system in one step.', ADMIN_ENDPOINTS.install_package, [{ args: { zip: { hash: '0000000000000000000000000000000000000000000000000000000000000000', size: 2048, mime: 'application/zip' } } }], changes('create', 'fns', 'types', 'context', 'kinds', 'components')),
  add_instance: adminFn('Add an instance of a bundled fleet system (an MCP server, an API service) with its config: installed, paired and started on the hub machine.', 'Use it when an admin asks to add an MCP server or an API service. Ask for the secret fields only when the server needs them, and never repeat them back.', ADMIN_ENDPOINTS.add_instance, [{ args: { system: 'mcp', instance: 'linear', description: 'Linear issues', config: { label: 'Linear', transport: { type: 'http', url: 'https://mcp.linear.app/mcp' }, auth: { kind: 'oauth', per: 'person' } } }, note: 'A remote MCP server people sign in to.' }], changes('create', 'fns', 'types', 'context')),
  remove_instance: adminFn('Remove one instance of a system.', 'Use it only when an admin asks to remove one instance of a system. Offer hub/export_system_data first so its data can be kept.', ADMIN_ENDPOINTS.remove_instance, [{ args: { system: 'database', instance: 'old' } }], changes('remove', 'fns', 'types')),
  suggest_decision_set: adminFn('Choose who picks what each message is offered: none (no model: the best by similarity over the threshold), a decision model (one yes/no question per candidate, the decide role\'s threshold), or an LLM; how many candidates it sees and picks; and a model\'s action: suggest (cards the chat model may load, the default) or load (what it picks is loaded for the turn: fns join the tools, context is brought into the message).', 'Use it when an admin wants a model to pick what each message is offered, or to let the score alone decide. An LLM needs a model; a decision model uses the decide role\'s unless one is named. Set action load only when the admin wants the picks loaded without the chat model asking; none (the score alone) only suggests, and context that doesn\'t fit the prompt\'s room is suggested instead.', ADMIN_ENDPOINTS.suggest_decision_set, [
    { args: { by: 'none' }, note: 'Let the score decide again.' },
    { args: { by: 'decision', messages: 3, candidates: 20, cap: 6, floor: 0.2 }, note: 'The decide role\'s decision model picks; its picks are suggested.' },
    { args: { by: 'decision', messages: 3, candidates: 20, cap: 6, floor: 0.2, action: 'load' }, note: 'The decide role\'s decision model picks, and what it picks is loaded for the turn.' },
  ]),
  search_decision_set: adminFn('Choose who filters search hits before they are returned, for fns or for context: none (as ranked), a decision model (one yes/no question per hit, kept at the decide role\'s threshold) or an LLM; and a model\'s action: suggest (the kept hits are returned, the default) or load (hub/fns_search, for fns, and hub/ctx_search, for context, in a chat also load the best kept hits, up to the hub\'s limit, and say so).', 'Use it when an admin wants searches (hub/fns_search, hub/ctx_search and the web\'s) to drop hits that don\'t fit what was searched for, or to have the model\'s searches load what fits. Set fns and context apart; an LLM needs a model, a decision model uses the decide role\'s unless one is named. Each filter call is a model call charged to the run that searched; the web\'s search only filters.', ADMIN_ENDPOINTS.search_decision_set, [
    { args: { item: 'fn', value: { by: 'decision' } }, note: 'The decide role\'s decision model filters fn hits.' },
    { args: { item: 'context', value: { by: 'none' } }, note: 'Context hits as ranked again.' },
    { args: { item: 'fn', value: { by: 'decision', action: 'load' } }, note: 'The decision model filters fn hits, and hub/fns_search loads the best kept ones.' },
    { args: { item: 'context', value: { by: 'decision', action: 'load' } }, note: 'The decision model filters context hits, and hub/ctx_search loads the best kept ones.' },
  ]),
  auto_pair_revoke: adminFn('Revoke an auto-pair secret, so its instance must pair again by code or token.', 'Use it when a machine is lost or retired; find the secret with hub/auto_pairs_list.', ADMIN_ENDPOINTS.auto_pair_revoke, [{ args: { id: 'apk_01HZX3' } }]),
  system_reimport: adminFn('Import a system\'s stored contract again, re-checking every entry.', 'Use it after a hub upgrade or when a system\'s fns look stale; it reports what was added, updated, removed or refused.', ADMIN_ENDPOINTS.system_reimport, [{ args: { system: 'database' } }], changes('update', 'fns', 'types', 'context', 'kinds')),
  export_system_data: adminFn('Zip an instance\'s data folder with its config (secret fields only when asked) and return the content.', 'Use it to back up an instance before removing or moving it. Include secret fields only when the admin asks.', ADMIN_ENDPOINTS.export_system_data, [{ args: { system: 'database', instance: 'main' } }]),
  ctx_injection_set: adminFn(
    'Switch one injected item off or back on for one agent, or move it earlier or later in that agent\'s instructions. Other agents keep it as they had it.',
    'Use it when an admin asks to stop telling an agent something (or to tell it again), or to change where an item sits in what the agent is told. Find the agent and item names with hub/ctx_injections_list first. `on: false` leaves the item out of that agent\'s prompt from its next turn (its fns stop being added with it); `order` is a number from 0 to 1000, lower first (the hub\'s own items sit at 10 to 30, systems\' at 100 by default); `order: null` goes back to the item\'s own order. It answers the item as that agent now gets it.',
    ADMIN_ENDPOINTS.ctx_injection_set,
    [
      { args: { agent: 'hub/chat', context: 'hub/limits', on: false }, note: 'Stop telling the chat agent what the app can\'t do.' },
      { args: { agent: 'hub/chat_small', context: 'input/asking', order: 20 }, note: 'Move an item near the start for the small chat agent.' },
      { args: { agent: 'hub/chat', context: 'input/asking', on: true, order: null }, note: 'Back on, at its own order.' },
    ],
  ),
} satisfies Record<AdminFnName, unknown>;

/** Which model an agent or an LLM call uses: a model id, a category, or automatic selection by weights. */
export const ModelChoiceType = g.or([
  g.obj({ model: g.text({ minLength: 1 }) }),
  g.obj({ category: g.text({ minLength: 1 }) }),
  g.obj({ auto: g.obj({ cost: g.optional(g.num({ min: 0 })), speed: g.optional(g.num({ min: 0 })), accuracy: g.optional(g.num({ min: 0 })) }) }),
]);

/** A chat mode's settings, as a gin type: core's `ChatModeConfig` input (defaults may be left out). */
export const ChatModeType = ginAs(ChatModeConfig);
/** A contextor's settings, as a gin type: core's `ContextorConfig` input (defaults may be left out). */
export const ContextorType = ginAs(ContextorConfig);

/** The payload of a `hub/llm` fn: an agent's instructions, model, tools, context, mode and limits. Built by `agent()`. */
export const LlmPayloadType = g.obj({
  /** Handlebars; `{{args.x}}` reads the args. */
  instructions: g.text(),
  model: g.optional(ModelChoiceType),
  /** Qualified fn names. */
  tools: g.list(g.text()),
  /** Fns the agent may add to its toolset while running. */
  canLoad: g.or([
    g.literal('none'),
    g.obj({ fns: g.optional(g.list(g.text())), systems: g.optional(g.list(g.text())), tags: g.optional(g.list(g.text())) }),
  ]),
  maxTools: g.num({ min: 1, whole: true }),
  /** Qualified context names, always loaded. */
  context: g.list(g.text()),
  /** Qualified hook names to run on each user message. */
  hooks: g.list(g.text()),
  toolExecution: g.enum(['parallel', 'sequential']),
  maxIterations: g.num({ min: 1, whole: true }),
  /** How fns reach the model (strict tools or the static toolset); the hub's default (`tools`) when absent. A session may override it. */
  mode: g.optional(ChatModeType),
  /** What goes into each prompt (plain, suggest or graph); the hub's default (`plain`) when absent. A session may override it. */
  contextor: g.optional(ContextorType),
  /**
   * The most tokens one answer may take (as core's `ModelLimits.maxOutputTokens`, and never past the model's own
   * limit); the hub's `HARNESS_AGENT_MAX_OUTPUT` when absent.
   */
  maxOutput: g.optional(ginAs(ModelLimits.shape.maxOutputTokens.unwrap())),
  /**
   * How it takes its injected section (`{{injectedContext}}`): `none`, or its detail (`summary` for a small window) and
   * a cap on the section's tokens. Absent: every item in full, uncapped.
   */
  injected: g.optional(ginAs(AgentInjected)),
});

/** A failure, as a gin type (the same shape as core's `FnError`). */
export const FnErrorType = g.obj({
  class: g.enum(ERROR_CLASSES),
  message: g.text(),
  code: g.optional(g.text()),
  data: g.optional(json()),
});

const RunStatusType = g.enum(RUN_STATUSES);

/** What `hub/inspect` can show: every kind of item a context link can point at (core's `LinkTarget`). */
export const FIND_KINDS = LINK_TARGET_KINDS;

/** How much of an item the model sees, as a gin type (core's `Detail`). */
const DetailType = g.enum(DETAIL_LEVELS);

/** One name `hub/load` or `hub/unload` could not take, and why. */
const RefusedName = g.obj({ name: g.text(), reason: g.text() });

/** One part of a resource sent to the model (`hub/resource_send`): an LLM message part's kind and name, and its size. */
const SentPart = ginAs(LlmContentPart.pick({ type: true, name: true }).extend({ chars: z.number().int().min(0) }));

/** A fn as `hub/fns_get` gives it. */
export const StoredFn = g.obj({
  fn: g.fnName(),
  kind: g.text(),
  description: g.text(),
  instructions: g.optional(g.text()),
  payload: g.optional(json()),
  /** 1 for a fn never saved again; the hub keeps every older version. */
  version: g.num({ min: 1, whole: true }),
  /** Who owns it (a saved fn's person); absent for a system's own fns. */
  owner: g.optional(g.text()),
  routing: g.optional(ginAs(FnRouting)),
  /** Whether the run's person can use it now (as `hub/fns_search`'s hits say it); what blocks it when false, in the hub's words. */
  available: g.bool(),
  blocked: g.optional(ginAs(FnBlock)),
  /** Its args type, as the hub describes it (a fn of a kind: as its kind works it out), so a widget plans each arg. */
  args: g.optional(ginAs(GinTypeDef)),
  /** Its declared return type, so a widget checks that it is a table. */
  returns: g.optional(ginAs(GinTypeDef)),
  /** Its rows change on their own (`FnDecl.live`), so a widget over it may re-run while shown. */
  live: g.optional(ginAs(FnLive)),
});

/** `hub/fns_save`'s args. */
export const SaveFnArgs = g.obj({
  kind: g.field(g.text({ minLength: 1 }), { docs: 'The qualified kind (`input/form`): one of the calling system\'s own kinds.' }),
  name: g.field(g.text({ minLength: 1 }), { docs: 'Its local name (`project_details`, `main.overdue_invoices`); the hub names it `<system>/<name>`.' }),
  description: g.text({ minLength: 1 }),
  instructions: g.optional(g.text()),
  payload: json(),
  examples: g.optional(g.list(ginAs(FnExample))),
  tags: g.optional(g.list(g.text())),
  share: g.field(g.optional(ginAs(ShareRule)), { docs: 'Who else may use it: private to the run\'s person when absent on a new fn; saving again keeps the current sharing when absent.' }),
  routing: g.optional(ginAs(FnRouting)),
  replace: g.field(g.optional(g.bool()), { docs: 'Save over the fn of this name, keeping the old version; otherwise a taken name is refused.' }),
});

/**
 * How a run of `hub/fns_save` is undone: the fn, the version the save made, and whether it made the fn. Undoing it puts
 * back the version before (or removes a fn the save made), unless the fn was saved again or removed since.
 */
export const SavedFn = g.obj({ fn: g.fnName(), version: g.num({ min: 1, whole: true }), created: g.bool() });

/** What `hub/fns_remove` gives, and how its run is undone: the fn, and the version it had (the one restored). */
export const RemovedFn = g.obj({ fn: g.fnName(), version: g.num({ min: 1, whole: true }) });

/** The error code `hub/fns_save` fails with (class `caller`) when the name is taken and `replace` is not set. */
export const SAVE_FN_TAKEN = 'fn-taken';

/** How a model should use `hub/fns_search`. */
const FNS_SEARCH_GUIDE = [
  'It searches every fn of every system you can use (fns do things; for guides, memories and pieces of files, which are context, use hub/ctx_search). Use it whenever you need a fn that is not in your tools, and before making a new fn, to reuse a saved one that already does the job.',
  'Put what you need in plain words in `text` (what it should do, not a fn name you guess). Leave out every filter you don\'t need. Narrow when you know how: `systems: ["database"]`, `modes: ["read"]`.',
  'With `text`, hits come best first: `rank` is a hit\'s place in that order (1 = first, whatever it is), and `similarity`, when given, is how close its meaning is (0 to 1; under about 0.45 is likely unrelated);',
  'read each hit\'s description and keep only those that fit what you need: the first hit is not always right. If nothing fits, search again with other words or another filter, at most once or twice, then say what you could not find. Without `text` it lists by name.',
  'Page with `offset` set to the `next` it gave. A hit must be loaded (hub/fns_load) before you can call it, with the args its `signature` shows. In the static toolset (find, find_ctx, inspect, load, unload, run) you run a hit by its name with run.',
  'When the page has `loaded`, the hub loaded those hits for you: call them from your next step, without loading them again.',
  'When you know a fn\'s exact name, give it in `names` (or as the text): an item named exactly always comes back first, marked `exact`, whatever the other filters; a name no fn you may use has is listed in `missing`.',
  'A hit with `available: false` can\'t be used now: `blocked.reason` says why, in the hub\'s words. Don\'t load or call it; if you need it, tell the person what blocks it.',
].join(' ');

const FNS_SEARCH_EXAMPLES = [
  { args: { text: 'keep a list of tasks and who does each one' }, note: 'Fns for a request in plain words.' },
  { args: { text: 'invoices that are overdue', systems: ['database'], limit: 5 }, note: 'The database fns closest to a question, saved queries among them.' },
  { args: { systems: ['fs'], modes: ['read' as const], order: 'name' as const }, note: 'Every fs fn that only reads, by name.' },
];

/** How a model should use `hub/ctx_search`. */
const CTX_SEARCH_GUIDE = [
  'It searches context (guides, memories, pieces of files) of every system you can use; fns are found with hub/fns_search. Use it for a system\'s guide before you first use the system, or for memories about the person.',
  'Put what you need in plain words in `text`; narrow only when you know how (`origins: ["memory"]` for what was remembered). Hits come best first; keep only those whose description fits. Page with `offset` set to `next`.',
  'Load a hit with hub/ctx_load. A hit with `inPrompt` is in front of you already (`injected`: in your instructions; `loaded`: loaded in this chat), so don\'t load it again. When the page has `loaded`, the hub loaded those hits for you.',
  'When you know an item\'s exact name (a system\'s guide is `<system>/guide`), give it in `names` (or as the text): an item named exactly always comes back first, marked `exact`, whatever the other filters; a name nothing you may use has is listed in `missing`.',
].join(' ');

const CTX_SEARCH_EXAMPLES = [
  { args: { text: 'how to work with tables and saved queries' }, note: 'Guides for a request in plain words.' },
  { args: { text: 'the person\'s preferences and constraints', origins: ['memory' as const] }, note: 'Memories about the person.' },
];

/**
 * How `hub/ctx_crawl` works, for the model (plan item 7): levels, the one conditional step, the limits, and what it
 * answers.
 */
const CONTEXT_CRAWL_GUIDE = [
  'Use it when a task needs several connected pieces of context and you know where to start (a guide\'s key from hub/ctx_search or a choice), rather than loading choices one step at a time.',
  'It works in levels. Level 0 is the context you name plus everything it imports (imports always come along, at every level).',
  'Each level\'s items may list choices: links to more context, each with a condition ("load X when: …"). Every choice not loaded yet becomes one yes/no question about your `guidance`, and the decision model answers them all together',
  `(in calls of up to ${CRAWL_BATCH_MAX} questions). The choices answered yes (at or above the admin's threshold) load, most likely first, with their imports, while they fit \`maxTokens\`; they are the next level.`,
  'It stops when no choice is left, or at `maxDepth` levels, `maxDecisions` questions in all, or `maxTokens`. Write `guidance` as the task in one or two plain sentences: it is all the decision model reads.',
  'It answers with what it took (`<crawled_ctx>`, each with how it was reached), the fns that context brings (`<brought_fns>`), the choices it skipped and why (`<skipped_ctx>`: declined, over the token budget, out of questions or past the last level), and why it stopped.',
  'Without `metadataOnly` what it took is loaded into this session like hub/ctx_load, its text in front of you from your next step. With `metadataOnly: true` nothing is loaded: you get each item\'s key, title, description and size, and load what fits with hub/ctx_load.',
].join(' ');

/** The hub's contract as declared (`hub` adds the refs to its own context items). */
const hubContract = system('hub', {
  description: 'The hub: search and load fns and context, follow runs, ask people, and run agents.',
  registries: {
    visuals: { description: 'Every visual a table result can be drawn with (a table, value cards, the chart families): each system adds its own, with the shape of data it draws.', data: ginAs(ResultTable) },
  },
  // the app's own visuals (the table, value cards and the chart families), drawn by the web app; systems add the rest
  contributes: [...BUILT_IN_CONTRIBUTIONS],
})
  .with({
    types: {
      ContentRef: type({
        description: 'Stored content by reference: an upload, or an earlier version of a file.',
        shape: g.obj({ hash: g.text({ pattern: CONTENT_HASH_PATTERN }), size: g.num({ min: 0, whole: true }), mime: g.text() }),
        display: { label: 'Content', plural: 'Contents', icon: 'file', title: 'hash', subtitle: 'mime' },
      }),
      LongText: type({
        description: 'Text that runs over many lines, such as a file body or a plan. Its input is a growing text area.',
        shape: g.text(),
        display: { label: 'Text', icon: 'text' },
      }),
    },
    kinds: {
      llm: kind({
        description: 'An agent: an LLM with instructions, tools and context, callable like any fn.',
        applicability: 'Use for work that needs judgement, reading or writing in natural language, or several tool calls.',
        payload: LlmPayloadType,
        status: {
          active: { one: 'Asking {fn}…', many: 'Asking {n} agents…' },
          retry: { one: 'Asking {fn} again…', many: 'Asking {n} agents again…' },
          done: { one: '{fn} answered', many: '{n} agents answered' },
          failed: { one: '{fn} could not answer', many: '{n} agents could not answer' },
        },
      }),
    },
    fns: {
      fns_load: fn({
        description: 'Add fns to your tools for the rest of this chat, by their names: each becomes a tool you can call from your next step.',
        instructions: 'Use it after hub/fns_search or a suggestion, with the names of the fns you will call, exactly as the hits and suggestions spell them (`database/main.tasks_create`); they can be called from your next step. It answers with the cards of what it loaded (`<loaded_fns>`) and of each name it refused (`<refused_fns>`) with why, in the hub\'s words (no such fn, another system, waits for an admin to approve it): do not load a refused one again; tell the person what blocks it. Load only what you need: every loaded fn takes room in the prompt.',
        examples: [{ args: { fns: ['fs/read', 'fs/edit'] }, note: 'Two fns for a file change.' }],
        args: g.obj({ fns: g.list(g.fnName(), { minLength: 1 }) }),
        returns: ginAs(LoadFnsResult),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      fns_drop: fn({
        description: 'Remove fns from your tools.',
        instructions: 'Use it when you are done with fns you loaded, to free room in the prompt for the rest of the session.',
        examples: [{ args: { fns: ['fs/edit'] } }],
        args: g.obj({ fns: g.list(g.fnName(), { minLength: 1 }) }),
        returns: g.obj({ dropped: g.list(g.text()) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      fns_search: fn({
        description: 'Search fns in the hub by words, meaning or both, best first or by name, filtered by system, instance, who shares them, the types they read or write and their mode, a page at a time.',
        instructions: FNS_SEARCH_GUIDE,
        args: ginAs(FnSearchArgs),
        returns: ginAs(FnSearchPage),
        examples: FNS_SEARCH_EXAMPLES,
        tags: [READ_TAG],
        display: 'message',
      }),
      ctx_search: fn({
        description: 'Search context (guides, memories, pieces of files) by words or meaning, a page at a time.',
        instructions: CTX_SEARCH_GUIDE,
        args: ginAs(CtxSearchArgs),
        returns: ginAs(FnSearchPage),
        examples: CTX_SEARCH_EXAMPLES,
        tags: [READ_TAG],
        display: 'message',
      }),
      fns_examples: fn({
        description: 'A page of one fn\'s example calls (its args, the result when kept, and what each shows), the closest to what you are about to do first.',
        instructions: 'Use it before calling a fn whose args are long or easy to get wrong (a saved query, a form, a table\'s fns): give the fn\'s name as `fn` (it needn\'t be loaded) and what you are about to do as `query`, then follow the shape of the closest example exactly. Page with `offset` set to `next` until `next` is absent.',
        args: ginAs(FnExamplesQuery),
        returns: ginAs(FnExamplesPage),
        examples: [
          { args: { fn: 'database/main.sales_by_month', query: 'sales for 2025 only' }, note: 'The examples closest to filtering one year come first.' },
          { args: { fn: 'input/project_details', offset: 10, limit: 10 }, note: 'The second page of ten.' },
        ],
        tags: [READ_TAG],
        display: 'message',
      }),
      fns_get: fn({
        description: 'One fn as the hub keeps it: its kind, description, instructions, payload (for a fn of a kind), version and where it runs.',
        instructions: 'Use it to look inside a saved fn (a saved form, a saved query) before reusing or changing it. Only fns the run\'s person may see are given; another is "no such fn".',
        args: g.obj({ fn: g.fnName() }),
        returns: StoredFn,
        examples: [{ args: { fn: 'input/project_details' }, note: 'A saved form: its payload is the form.' }],
        tags: [READ_TAG],
        display: 'hidden',
      }),
      fns_save: fn({
        description: 'Keep a fn of one of the calling system\'s kinds in the hub (a saved form, a saved query), owned by the run\'s person and shared as asked. Saving a name again keeps the old version in its history; undoing the run puts back the version before (or removes a fn it made).',
        instructions: 'Only the system that owns the kind may save fns of it. Give a description and instructions a model can choose and call it by, and examples (args, and the result when there is one). The hub checks the payload with the kind before keeping it, embeds it for hub/fns_search, and keeps its examples for hub/fns_examples.',
        args: SaveFnArgs,
        returns: g.obj({ fn: g.fnName(), version: g.num({ min: 1, whole: true }), created: g.bool() }),
        undo: SavedFn,
        examples: [{
          args: { kind: 'input/form', name: 'project_details', description: 'Asks for a project\'s name, owner, due date and priority.', payload: { title: 'Project details', type: { name: 'obj', props: {} } }, share: { visibility: 'private', with: [] } },
          note: 'A saved form, private to its person.',
        }],
        tags: [OWN_TAG],
        display: 'hidden',
        // a fn that saves through it creates or updates fns of its kind: the hub checks that it said so
        effects: { registry: [{ thing: 'fns', action: 'create' }, { thing: 'fns', action: 'update' }] },
      }),
      fns_remove: fn({
        description: 'Remove a fn of one of the calling system\'s kinds that a person saved (a saved form, a saved query): it is no longer listed, called or run. The hub keeps its versions, and undoing the run brings back the version it had.',
        instructions: 'Only the system that owns the kind may remove fns of it, and only for the fn\'s owner or an admin. A system\'s own fns (its contract\'s) can\'t be removed.',
        args: g.obj({ fn: g.field(g.fnName(), { docs: 'The fn to remove, by its name.' }) }),
        returns: RemovedFn,
        undo: RemovedFn,
        examples: [{ args: { fn: 'input/project_details' }, result: { fn: 'input/project_details', version: 3 }, note: 'A saved form its person no longer wants.' }],
        tags: [OWN_TAG],
        display: 'hidden',
        // a fn that removes through it removes fns of its kind: the hub checks that it said so
        effects: { mode: 'delete', registry: [{ thing: 'fns', action: 'remove' }] },
      }),
      ctx_load: fn({
        description: 'Load context items (guides, memories, pieces of files) into this chat by their full names: their text is in your prompt from your next step, with what they import, and the fns they bring join your tools.',
        instructions: [
          'Use it with names a search (hub/ctx_search) or a suggestion gave you, or a choice under "Where to go next" in a loaded context, copied exactly; load a system\'s guide before you first use the system. Their text is in front of you from the next step.',
          'Each loads with the context it imports, and the fns it brings go into your tools; it answers with the cards of both (`<loaded_ctx>`, `<brought_fns>`). A brought fn that could not be added is named with the reason the hub gave (`available="no"`): it is not in your tools. A name you got wrong is refused with the closest names (`<refused_ctx>`).',
          'A line copied as `name: description` is fine. Load only what the task needs, one step at a time.',
        ].join(' '),
        examples: [
          { args: { context: ['database/guide'] }, note: 'A system\'s guide before its first use: its text, and the fns it brings join your tools.' },
          { args: { context: ['fs/authoring.kinds: how to declare a kind'] }, note: 'A choice under "Where to go next", copied with its line.' },
        ],
        args: g.obj({ context: g.list(g.text(), { minLength: 1 }) }),
        returns: ginAs(LoadContextResult),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      ctx_drop: fn({
        description: 'Take context items out of this chat: their text leaves your prompt from your next step.',
        instructions: 'Use it when you are done with context you loaded (a guide, a memory, a piece of a file), to free room in the prompt for the rest of the session. The fns it brought stay in your tools: drop them with hub/fns_drop.',
        examples: [{ args: { context: ['database/guide'] }, note: 'Done with a system\'s guide.' }],
        args: g.obj({ context: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ dropped: g.list(g.text()) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      ctx_crawl: fn({
        description: 'Gather the context a task needs by following context links from starting keys, a level at a time, with the decision model choosing which links to follow.',
        instructions: CONTEXT_CRAWL_GUIDE,
        examples: [
          { args: { context: ['fs/authoring'], guidance: 'Declare a new kind with a payload type and examples.' }, note: 'From a guide\'s index: follow its choices up to 3 levels, loading what the decision model says this task needs.' },
          { args: { context: ['database/guide'], guidance: 'Write a saved query that joins two tables.', maxDepth: 1, maxTokens: 3000 }, note: 'One level of choices, within 3000 tokens.' },
          { args: { context: ['fs/authoring', 'database/guide'], guidance: 'Store uploaded files as records.', metadataOnly: true, maxDecisions: 64 }, note: 'See what a crawl would find (keys, sizes, why) without loading it; load what fits with hub/ctx_load.' },
        ],
        args: ginAs(ContextCrawlArgs),
        returns: ginAs(ContextCrawlResult),
        tags: [READ_TAG],
        display: 'hidden',
        // it asks the decision model which links to follow: off until an admin sets the decide role
        roles: ['decide'],
      }),
      search_resources: fn({
        description: 'Search files and other resources by meaning and words.',
        instructions: 'Use it to find files, pages and uploads by what they say, across every system. Give a plain description of what you look for; narrow to roots (a folder\'s uri, a crawl) when you know them. Each hit has a section and a preview: read the best with hub/resource_read rather than guessing from the preview.',
        examples: [{ args: { query: 'where the hub client retries requests' }, note: 'Code by what it does.' }, { args: { query: 'refund policy', roots: ['web://docs.example.com'], limit: 5 }, note: 'One crawled site only.' }],
        args: g.obj({ query: g.text(), roots: g.optional(g.list(g.text())), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ uri: g.text(), section: g.optional(g.text()), title: g.text(), preview: g.text(), rank: g.num() })),
        tags: [READ_TAG],
      }),
      run_status: fn({
        description: 'The status of one run (one call of a fn): running, waiting (for approval or for a form), done with its result, failed with its error, or cancelled, with its progress.',
        instructions: 'Use it to check on a call that went to the background: its result said "Running in the background as run <id>", and `run` is that id (such as `run_01HZX3`), never a fn name. It answers at once and does not wait: to wait for the end, use hub/run_wait. You don\'t need it to learn that a background run finished: its result comes to you by itself as a `<background-result>` message.',
        examples: [{ args: { run: 'run_01HZX3' } }],
        args: g.obj({ run: g.text() }),
        returns: g.obj({ status: RunStatusType, progress: g.optional(json()), result: g.optional(json()), error: g.optional(FnErrorType) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      run_wait: fn({
        description: 'Wait for one run (such as a call that went to the background) to finish, up to a timeout, and give its result.',
        instructions: 'Use it when you can\'t go on without the result of a background run (`run` is the id its result named). Give a `timeout` when the person is waiting (30000 is 30 seconds). If it comes back still running, say so and how long such runs usually take (hub/fns_metrics) rather than waiting again and again; its result will still reach you as a `<background-result>` message when it ends.',
        examples: [{ args: { run: 'run_01HZX3', timeout: 30000 }, note: 'Wait up to 30 seconds.' }],
        args: g.obj({ run: g.text(), timeout: g.field(g.optional(g.duration()), { docs: 'How long to wait, in milliseconds (30000 is 30 seconds). Leave empty to wait as long as this call may run.' }) }),
        returns: g.obj({ status: RunStatusType, result: g.optional(json()), error: g.optional(FnErrorType) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      ask_user: fn({
        description: 'Ask a person one plain question and wait for their answer: your call stays open until they reply, and the reply is its result.',
        instructions: 'Use it in the middle of a task when one detail only the person has decides what you do next (which of two options, how many people), and you will carry on as soon as you have it. For a question you can simply put in your answer (and end your turn), just ask there. For several typed fields at once, use a form (input/get_input). Ask one short, specific question, with the options when there are some. Leave `user` out to ask the person in the chat.',
        examples: [{ args: { question: 'Should the report cover only this quarter, or the whole year?' }, note: 'One detail that decides the next step.' }],
        args: g.obj({ question: g.text(), user: g.optional(g.text()) }),
        returns: g.obj({ answer: g.text() }),
        tags: [READ_TAG],
      }),
      // ─── The static toolset's fns (`run` is not a fn: its calls become runs of the named fn) ───
      inspect: fn({
        description: 'Look at one item by its full name, at a detail: a fn\'s card, a context item\'s text, a type\'s definition, or a resource\'s outline.',
        instructions: 'Use it on a hit from a search (hub/fns_search or hub/ctx_search, or find and find_ctx) before you run it, to see the exact args it takes. `signature` shows a fn\'s args and result; `full` adds its instructions and examples (use it for a fn whose args are long). It shows the item once and does not keep it: use hub/load to keep it in your prompt.',
        examples: [{ args: { name: 'fs/edit', detail: 'full' }, note: 'A fn card with its examples.' }, { args: { name: 'fs/Entry' } }],
        args: g.obj({ name: g.fnName(), detail: g.optional(DetailType) }),
        returns: g.obj({ name: g.text(), kind: g.enum(FIND_KINDS), detail: DetailType, text: g.text() }),
        tags: [READ_TAG],
        display: 'message',
      }),
      load: fn({
        description: 'Keep fns (as cards) and context items (as text) in your prompt from the next step on, by their full names.',
        instructions: 'Use it for fns you will run more than once and for guides you need while you work (load a system\'s guide before you first use it). A context item brings the items it imports and its fns along. Use the lowest detail that is enough (`signature` for a fn you know how to call), since everything loaded takes room in the prompt.',
        examples: [{ args: { names: ['fs/read', 'fs/edit'], detail: 'signature' }, note: 'Two fns for a file change.' }, { args: { names: ['database/guide'] }, note: 'A system\'s guide, before its first use.' }],
        args: g.obj({ names: g.list(g.fnName(), { minLength: 1 }), detail: g.optional(DetailType) }),
        returns: g.obj({ loaded: g.list(g.text()), refused: g.list(ginAs(NameRefusal)) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      unload: fn({
        description: 'Take fns and context out of what you keep in front of you.',
        instructions: 'Use it when you are done with fns or context you loaded, to keep the prompt small.',
        examples: [{ args: { names: ['fs/edit'] }, note: 'Done editing files.' }],
        args: g.obj({ names: g.list(g.fnName(), { minLength: 1 }) }),
        returns: g.obj({ unloaded: g.list(g.text()), refused: g.list(RefusedName) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      // ─── Resources beyond the web endpoints ───
      resource_outline: fn({
        description: 'A resource\'s sections (headings, symbols, pages or tables), each with its key and place in the outline.',
        instructions: 'Use it before reading a long resource: pick the section you need from its outline and read only that with hub/resource_read.',
        examples: [{ args: { uri: 'file:///repo/docs/guide.md' } }],
        args: ginAs(ResourceOutlineArgs),
        returns: g.list(ginAs(Section)),
        tags: [READ_TAG],
        display: 'message',
      }),
      resource_send: fn({
        description: 'Show yourself a resource (or one section of it) as it is, at your next step: an image you can see, audio, a PDF page or text.',
        instructions: 'Use it to look at a photo, a screenshot, a chart or a scanned page the person attached, or any resource whose text form is not enough. You see it yourself at your next step: describe what you see then, with no other tool. If the model you run on can\'t see images, an image comes as an `<image id="…">` block instead: ask about it with hub/image_read. It costs prompt room, so send one section (a page) of a long document when you can.',
        examples: [{ args: { uri: 'hub://resources/uploads/2026-11-22/photo.jpg' }, note: 'Look at a photo the person attached.' }],
        args: ginAs(ResourceSendArgs),
        returns: g.obj({ parts: g.list(SentPart) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      image_read: fn({
        description: 'Ask a question about an image you can\'t see: another model that can see images looks at it and answers.',
        instructions: 'Use it when an image comes to you as an `<image id="…">` block instead of the picture itself (the model you run on can\'t see images). Pass the block\'s id as `image` and ask one clear question, saying exactly what you need: "What does the text in it say, word for word?", "List every item it shows with its number", "What is in the top left corner?". Ask for the exact words or numbers you need rather than a summary, and ask again with a sharper question if the answer leaves something out. The answer is only what that model saw: say so if it is unsure, and confirm anything important with the person before you act on it. Don\'t use it on an image you can see.',
        examples: [
          { args: { image: 'hub://resources/uploads/2026-11-22/photo.jpg', question: 'Write out all of the text in this image exactly, line by line.' }, note: 'The words in an attached picture.' },
          { args: { image: 'file:///docs/diagram.png', question: 'What are the labelled parts, and how are they connected?' }, note: 'What a diagram shows.' },
        ],
        args: ginAs(ImageReadArgs),
        returns: ginAs(ImageReadResult),
        tags: [READ_TAG],
        // a vision model answers: off until an admin sets the describe role
        roles: ['describe'],
      }),
      // ─── Bookkeeping ───
      system_calls: fn({
        description: 'Holds the model calls a system makes outside its own runs (hooks, timers, start-up, its own aeye), so they are charged to its budgets and show as its.',
        instructions: 'Never call it: the hub makes its runs itself when a system calls a model outside a run. Read them with hub/runs_list filtered by this fn to see what a system spent on its own.',
        examples: [{ args: {}, note: 'Its runs are made by the hub; calling it is refused.' }],
        args: g.obj({}),
        returns: g.obj({}),
        visibility: 'none',
        display: 'hidden',
      }),
      // ─── Hub MCP session tokens for grantee systems ───
      mint_mcp_token: fn({
        description: 'Mint a short-lived token for a hub MCP, for a session this system starts (a Claude session, for one). Only a grantee system\'s runs may call it.',
        instructions: 'Only a grantee system calls it, when it starts a session that should reach the hub through MCP. Pass the token to that session only and never show it to a person.',
        args: ginAs(MintMcpTokenArgs),
        examples: [{ args: { mcp: 'mcp_01HZX3', label: 'claude session for the release notes', ttl: 600000 }, note: 'A ten-minute token for one session.' }],
        returns: g.obj({ token: g.text(), expiresAt: g.timestamp() }),
        tags: [ADMIN_TAG],
      }),
    },
    mentions: {
      fns: mention({ title: 'Functions', description: 'Any fn the session can use.', target: g.obj({ fn: g.text() }) }),
      context: mention({ title: 'Context', description: 'Guides, skills and references.', target: g.obj({ context: g.text() }) }),
      resources: mention({ title: 'Resources', description: 'Files and other resources from every system.', target: g.obj({ uri: g.text(), section: g.optional(g.text()) }) }),
    },
    sectioners: {
      whole: sectioner({ description: 'The whole resource as one section.', match: {} }),
      headings: sectioner({ description: 'One section per heading.', match: { format: 'markdown' } }),
      symbols: sectioner({ description: 'One section per top-level symbol (function, class, type).', match: { glob: '**/*.{ts,tsx,js,mjs,cjs,vue,py,go,rs,java,cs}' } }),
      pages: sectioner({ description: 'One section per page.', match: { format: 'pdf' } }),
      paragraphs: sectioner({ description: 'One section per paragraph.', match: { format: 'text' } }),
      tables: sectioner({ description: 'One section per table (large tables in row groups, the header repeated).', match: { form: 'table' } }),
    },
  })
  .with({ fns: { ...readFns, ...writeFns, ...personFns, ...exploreFns, ...dataFns } })
  .with(({ fns, kinds }) => {
    // the tools mode's own six: search, load and drop for fns and for context. Every other fn the chat starts with
    // (examples, following runs, asking people…) comes with the injected item that explains it (packages/hub/context/)
    const tools = [fns.fns_search.name, fns.fns_load.name, fns.fns_drop.name, fns.ctx_search.name, fns.ctx_load.name, fns.ctx_drop.name];
    return {
      fns: {
        read_table: fn({
          description: 'Run a read fn that returns a table, as a child run of the caller, as its person, and give the table.',
          instructions: 'The widgets system calls it to run a widget\'s source or a sample of one. It refuses a fn that is not a read (worked out deeply) or does not return a table.',
          examples: [{ args: { fn: 'hub/records_table', args: { type: 'tasks/Task', limit: 5 } }, note: 'Five tasks as a table.' }],
          args: ginAs(ReadTableArgs), returns: ginAs(ResultTable), tags: [READ_TAG], visibility: 'none', display: 'hidden',
        }),
        visuals: fn({
          description: 'Every visual of the hub\'s visual registry (hub/visuals), with its declared shape and the system that draws it, in registry order.',
          instructions: 'The widgets system calls it to rank the visuals that fit a result (rankVisuals): the hub\'s own first, then each system\'s in name order.',
          examples: [{ args: {}, note: 'The whole registry.' }],
          args: g.obj({}), returns: g.list(ginAs(ContributionView)), tags: [READ_TAG], visibility: 'none', display: 'hidden',
        }),
        row_actions: fn({
          description: 'The actions rows of some types offer, as the run\'s person may use them: each type\'s methods, narrowed and relabelled by a widget\'s list, with any fn it binds to the row\'s columns.',
          instructions: 'The widgets system calls it to give a widget\'s rows their menu. Anything that is not a read confirms first; what follows is derived (a table opens, a write refreshes).',
          examples: [{ args: { types: ['tasks/Task'] }, note: 'Every method of a task.' }],
          args: ginAs(RowActionsQuery), returns: g.list(ginAs(WidgetActionOption)), tags: [READ_TAG], visibility: 'none', display: 'hidden',
        }),
        chat: kinds.llm.fn({
          description: 'The chat agent: answers people in a session with every tool the session allows.',
          instructions: 'The hub runs it for every message in a session that names no other agent. Call it from another fn only to hand a whole conversation turn to the chat agent.',
          examples: [{ args: {}, note: 'Its input is the session itself: it takes no args.' }],
          payload: {
            instructions: CHAT_BASE,
            tools,
            canLoad: {},
            maxTools: 64,
            context: [],
            hooks: [],
            toolExecution: 'parallel',
            maxIterations: 24,
          },
          args: g.obj({}),
          returns: g.text(),
        }),
        chat_small: kinds.llm.fn({
          description: 'The chat agent for small local models: the static toolset and the graph contextor, so each prompt fits a small window.',
          instructions: 'Pick it for a session on a small local model (a few thousand tokens of window): it sees six fixed tools and only the context and fn cards that fit each prompt.',
          examples: [{ args: {}, note: 'Its input is the session itself: it takes no args.' }],
          payload: {
            instructions: CHAT_SMALL_BASE,
            tools,
            canLoad: {},
            maxTools: 64,
            context: [],
            hooks: [],
            toolExecution: 'sequential',
            maxIterations: 16,
            // a small window: each injected item at its summary, the section within 600 tokens
            injected: { detail: 'summary', maxTokens: 600 },
            mode: { type: 'static' },
            contextor: { type: 'graph' },
          },
          args: g.obj({}),
          returns: g.text(),
        }),
      },
    };
  })
  .with({ fns: { ...adminFns, ...adminReadFns } });

/**
 * The keys of the hub's own context items: the markdown files in the hub's `context/` folder, which join its manifest
 * at boot, so they are not declared in the contract. A test keeps this list and the folder the same.
 */
export const HUB_CONTEXT_KEYS = [
  'asking', 'attached_files', 'background_runs', 'earlier_chats', 'examples', 'finding_fns', 'images', 'later', 'limits', 'memory', 'resources',
  'saved_fns', 'undo',
] as const;
/** One of the hub's own context items, by key. */
export type HubContextKey = (typeof HUB_CONTEXT_KEYS)[number];

/** Refs to the hub's own context items, by key. */
export type HubContextRefs = { readonly [K in HubContextKey]: ContextRef<QualifiedName<'hub', K>, {}> };

const hubContextRefs = Object.fromEntries(HUB_CONTEXT_KEYS.map((key) => [key, withRefText({ ref: 'context' as const, name: `hub/${key}` as const })])) as HubContextRefs;

/**
 * The hub's contract, with refs to its own context items beside what it declares, so a system can name one where a
 * context ref is asked for (`inject: { replaces: [hub.context.later] }`).
 */
export const hub: Omit<typeof hubContract, 'context'> & { readonly context: (typeof hubContract)['context'] & HubContextRefs } = {
  ...hubContract,
  context: { ...hubContract.context, ...hubContextRefs },
};

/** The hub's contract type. */
export type HubContract = typeof hub;
