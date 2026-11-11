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
  ADMIN_TAG, adminSlice, chatSlice, CONTENT_HASH_PATTERN, ChatModeConfig, contextorSlice, contextSlice, ContextorConfig, DETAIL_LEVELS, ERROR_CLASSES,
  mcpsSlice, metricsSlice, MintMcpTokenArgs, modelsSlice, packagingSlice, READ_TAG, resourcesSlice, ResourceOutlineArgs, ResourceSendArgs, RUN_STATUSES, runsSlice,
  LIST_NAMES, querySlice, Section, settingsSlice, systemsSlice, LlmContentPart, ModelLimits, LINK_TARGET_KINDS, type Display,
  FnExample, FnExamplesPage, FnExamplesQuery, FnRouting, FnSearchPage, FnSearchQuery, ShareRule,
} from '@harness/core';
import { z } from 'zod';
import { fn } from './fn.ts';
import { kind, mention, sectioner, type } from './declare.ts';
import { g, json, type GinType } from './gin.ts';
import { system } from './system.ts';
import { ginAs, ginOf, toolArgsOf } from './zod-gin.ts';

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
  context_get: contextSlice.endpoints.contextItem,
  types_get: chatSlice.endpoints.types,
  runs_list: adminSlice.endpoints.runs,
  run_get: runsSlice.endpoints.run,
  run_tree: runsSlice.endpoints.tree,
  llm_call: runsSlice.endpoints.llmCall,
  model_calls: metricsSlice.endpoints.modelCalls,
  fn_metrics: metricsSlice.endpoints.fnMetrics,
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
  context_from_resource: resourcesSlice.endpoints.contextFromResource,
  remember: contextSlice.endpoints.remember,
  forget: contextSlice.endpoints.forget,
} as const satisfies Record<string, EndpointLike>;

/** A hub write fn's name. */
export type HubWriteFnName = keyof typeof HUB_WRITE_ENDPOINTS;

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
  remove_rule: adminSlice.endpoints.removeRule,
  approve_pairing: systemsSlice.endpoints.approvePairing,
  create_pairing_token: systemsSlice.endpoints.createPairingToken,
  configure_system: systemsSlice.endpoints.configureSystem,
  enable_system: systemsSlice.endpoints.enableSystem,
  remove_system: systemsSlice.endpoints.removeSystem,
  install_system: systemsSlice.endpoints.installSystem,
  start_system: systemsSlice.endpoints.startSystem,
  stop_system: systemsSlice.endpoints.stopSystem,
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
  remove_instance: packagingSlice.endpoints.removeInstance,
  export_system_data: packagingSlice.endpoints.exportSystemData,
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

/**
 * A fn for one web endpoint, its args and result read off the endpoint's body and response, so a system calling it
 * gets the endpoint's types and a change to the endpoint's schema reaches every caller.
 */
function endpointFn<E extends EndpointLike>(description: string, instructions: string, endpoint: E, tags: readonly string[], display?: Display) {
  return fn({
    description,
    instructions,
    args: toolArgsOf<E['cfg']['body']>(endpoint.cfg.body).args,
    returns: resultTypeOf(endpoint),
    tags: [...tags],
    ...(display === undefined ? {} : { display }),
  });
}

/** A fn for a web read, tagged `read`. Reads are bookkeeping the person needn't see as a card once done. */
function readFn<E extends EndpointLike>(description: string, instructions: string, endpoint: E) {
  return endpointFn(description, instructions, endpoint, [READ_TAG], 'message');
}

/** A fn for a write on resources, context or memory: it asks unless a policy allows it. */
function writeFn<E extends EndpointLike>(description: string, instructions: string, endpoint: E) {
  return endpointFn(description, instructions, endpoint, []);
}

/** A fn for an admin operation, tagged `admin`. */
function adminFn<E extends EndpointLike>(description: string, instructions: string, endpoint: E) {
  return endpointFn(description, instructions, endpoint, [ADMIN_TAG]);
}

/** The hub's read fns (`HUB_READ_ENDPOINTS`), each described for the agent that offers them. */
const readFns = {
  resource_list: readFn('List resources (files, pages, uploads) from every system and the hub, filtered, grouped and paged.', 'Use it to browse what exists (the files of a root, the pages a crawl kept, the uploads of a session) when you know where to look; to find something by what it says use hub/search_resources. Filter by root, system or kind and page on rather than asking for everything.', HUB_READ_ENDPOINTS.resource_list),
  resource_read: readFn('Read a resource as text: its primary form (markdown for pages, tables for spreadsheets) or a chosen form, whole or by sections.', 'Use it to read a resource you have the uri of. For a long one, read its outline first (hub/resource_outline) and then one section, or a window, so the answer fits; it says when the text was cut. Images and audio are read through their text forms (description, transcript); to look at the image itself use hub/resource_send.', HUB_READ_ENDPOINTS.resource_read),
  context_get: readFn('One context item (a guide, skill, memory or piece of a resource) with its text and its links both ways.', 'Use it to read one context item in full, with what links to it and what it links to, after a search or a mention named it. To keep it in front of you for the rest of the session use hub/load instead.', HUB_READ_ENDPOINTS.context_get),
  types_get: readFn('The definitions of named types and of every type they refer to, dependencies first.', 'Use it before writing args or a payload that use a named type (a table type, fs/Entry): it gives each type\'s fields and every type they refer to, so you need one call. Ask for several names at once.', HUB_READ_ENDPOINTS.types_get),
  runs_list: readFn('Runs, newest first, filtered by fn, status, session or system. A member sees their own runs.', 'Use it to find earlier runs (what ran, when, how it ended), for example to see why something failed. Filter by fn, status or session, newest first, and page; then hub/run_get for one run.', HUB_READ_ENDPOINTS.runs_list),
  run_get: readFn('One run: its fn, args, status, result or error, cost and timings.', 'Use it to see one run in full: its args, result or error, cost and how long it took. For a run still going use hub/run_status or hub/run_wait.', HUB_READ_ENDPOINTS.run_get),
  run_tree: readFn('The tree of runs a turn made: each run with the runs it called.', 'Use it to see everything one turn did, as a tree: each run with the runs it called. Good for explaining what happened or where a chain failed.', HUB_READ_ENDPOINTS.run_tree),
  llm_call: readFn('One LLM call: its whole request and response, tokens, cost and timings.', 'Use it to look at one model call exactly as sent and received (messages, tools, tokens, cost) when a run\'s behaviour needs explaining. It can be long: read it only when the summary in hub/run_get is not enough.', HUB_READ_ENDPOINTS.llm_call),
  model_calls: readFn('Model calls of every kind (chat, embeddings, images, transcription, speech), newest first, with cost and timings.', 'Use it for spending and timing questions across models (what cost the most today, which calls were slow). Filter and page; one call\'s detail is hub/llm_call.', HUB_READ_ENDPOINTS.model_calls),
  fn_metrics: readFn('How fns have been doing: runs, outcomes, retries, durations (p50, p95), queue waits, cost and tokens.', 'Use it to say how a fn usually behaves: how often it fails, how long it usually takes (p50) and when it is slow (p95), and what it costs. Quote these numbers rather than guessing.', HUB_READ_ENDPOINTS.fn_metrics),
  sessions_list: readFn('Chat sessions, most recent first.', 'Use it to find a person\'s earlier chats, most recent first; then hub/session_messages to read one.', HUB_READ_ENDPOINTS.sessions_list),
  session_messages: readFn('A session\'s messages, newest first, paged backwards.', 'Use it to read what was said in a session, newest first; page backwards for older messages. Read only as far back as the question needs.', HUB_READ_ENDPOINTS.session_messages),
  systems_list: readFn('Every system: whether it is connected, its version, instances and what it offers.', 'Use it to see which systems are installed, connected and configured before relying on one; a system that is not connected has no usable fns.', HUB_READ_ENDPOINTS.systems_list),
  system_get: readFn('One system: its status, version, instances, config state and what it offers.', 'Use it for one system\'s state: whether it is connected, its instances and whether its config is set. When a fn of it is unavailable this usually says why.', HUB_READ_ENDPOINTS.system_get),
  system_fns: readFn('A system\'s fns, with whether each can be used now and its running numbers.', 'Use it to list what one system offers and which of its fns can be used now, with how they have been doing.', HUB_READ_ENDPOINTS.system_fns),
  system_logs: readFn('The end of a system\'s output, oldest first.', 'Use it to see why a system misbehaves: the end of its output. Admins only; read the end first and go further back only if needed.', HUB_READ_ENDPOINTS.system_logs),
  model_roles: readFn('Which model (and provider) the hub uses for each job: chat, transcription, dictation, speech, describing images, reading text in them.', 'Use it to say which model does which job (chat, transcription, describing images, ...); to change one an admin uses hub/set_model_role.', HUB_READ_ENDPOINTS.model_roles),
  model_limits: readFn('Each model\'s context window, output limit, reasoning reserve and characters per token, with where each came from.', 'Use it when a prompt does not fit or an answer is cut: each model\'s window and output limit, and where the numbers came from.', HUB_READ_ENDPOINTS.model_limits),
  query: readFn(`Any list (${LIST_NAMES.join(', ')}) by the query standard: free text, filters on the list's fields (is, in, >, <, between, empty, contains, ...), a sort and paging.`, 'Use it for any list question with conditions (runs that failed this week, the biggest resources, fns of one system): name the list, add filters on its fields, a sort and a small page size, and page on. Never ask for everything.', HUB_READ_ENDPOINTS.query),
} satisfies Record<HubReadFnName, unknown>;

/** The hub's write fns on resources, context and memory (`HUB_WRITE_ENDPOINTS`). */
const writeFns = {
  resource_convert: writeFn('Make a form of a resource now (convert it, describe an image, read the text in it, transcribe audio); it may cost a model call.', 'Use it when a resource\'s form you need is missing (an image never described, audio not transcribed): it makes that form now, which may cost a model call, so make only the form you will read.', HUB_WRITE_ENDPOINTS.resource_convert),
  resource_import: writeFn('Import a URL or uploaded content as a hub resource, kept and converted by the hub.', 'Use it to keep a URL or an upload as a hub resource so it can be read, searched and linked later. It returns the uri; read it with hub/resource_read.', HUB_WRITE_ENDPOINTS.resource_import),
  resource_rename: writeFn('Rename a hub resource.', 'Use it when the person asks to rename a hub resource. Only hub resources (imports, uploads) can be renamed; a system\'s files are renamed through that system (fs).', HUB_WRITE_ENDPOINTS.resource_rename),
  resource_delete: writeFn('Delete a hub resource; says how many messages, context items and runs still point at it.', 'Use it only when the person asks to delete a hub resource. It reports how many messages, context items and runs still point at it: tell the person, since those links will show as gone.', HUB_WRITE_ENDPOINTS.resource_delete),
  context_from_resource: writeFn('Make context items from a resource (one per section, under an outline parent), or update the ones made before.', 'Use it to turn a document the person wants kept as knowledge (a guide, a spec) into context items, one per section; run it again after the document changes to update them.', HUB_WRITE_ENDPOINTS.context_from_resource),
  remember: writeFn('Remember something for later as a memory: for this session, the person, or everyone.', 'Use it when the person asks you to remember something, or states a lasting preference. Choose the scope: this session, the person (the default for preferences), or everyone (only when they say so). Keep one fact per memory, in a plain sentence.', HUB_WRITE_ENDPOINTS.remember),
  forget: writeFn('Forget a memory.', 'Use it when the person asks you to forget something, or a memory is wrong. Find the memory first (hub/find) and forget it by its name.', HUB_WRITE_ENDPOINTS.forget),
} satisfies Record<HubWriteFnName, unknown>;

/** The hub's admin fns (`ADMIN_ENDPOINTS`), each described for the agent that offers them. */
const adminFns = {
  configure_provider: adminFn('Add a model provider (OpenAI, OpenRouter, Ollama) with its API key, or replace its key. The key is stored encrypted.', 'Use it when an admin gives a provider key. Never repeat the key back or put it in a message; say only that it was stored.', ADMIN_ENDPOINTS.configure_provider),
  set_model_category: adminFn('Add a model category (a named, ordered list of models), or change the one with this id.', 'Use it to group models for a purpose (fast, cheap, best). Order matters: the first available model is tried first.', ADMIN_ENDPOINTS.set_model_category),
  set_budget: adminFn('Add a spending budget for the hub, a group, a user, a session, a system, a fn or a model, or change the one with this id.', 'Use it when an admin sets a spending limit. Say the scope and period back in plain words, since a low budget stops runs.', ADMIN_ENDPOINTS.set_budget),
  set_priority: adminFn('Add a priority rule (the default and highest priority of turns at a level), or change the one with this id.', 'Use it when an admin wants some turns to run before others (a group\'s work first).', ADMIN_ENDPOINTS.set_priority),
  set_policy: adminFn('Add a policy saying whether actors may run fns (allow, deny, or ask an approver), or change the one with this id.', 'Use it when an admin decides who may run which fns. Prefer ask over allow for fns that write or delete, and check what the rule covers with the person first.', ADMIN_ENDPOINTS.set_policy),
  set_actor_setting: adminFn('Set a setting a system declares for a user, group or agent.', 'Use it to set a system\'s declared setting for a user, group or agent. Read the setting\'s type first (hub/system_get) so the value fits.', ADMIN_ENDPOINTS.set_actor_setting),
  add_user: adminFn('Add a person who can sign in, with their role and groups.', 'Use it when an admin adds a person. Give the lowest role that does the job, and say what the role allows.', ADMIN_ENDPOINTS.add_user),
  add_group: adminFn('Add a group of people.', 'Use it to make a group before adding people or rules to it.', ADMIN_ENDPOINTS.add_group),
  remove_rule: adminFn('Remove a budget, priority rule, policy, model category or provider.', 'Use it only when an admin asks to remove a rule; say what stops applying once it is gone.', ADMIN_ENDPOINTS.remove_rule),
  approve_pairing: adminFn('Approve or refuse a system that asked to pair with the hub, optionally naming its instance and setting its config.', 'Use it when an admin approves or refuses a waiting system. Name the instance when there are several of one system, and set its config here if it needs one to start.', ADMIN_ENDPOINTS.approve_pairing),
  create_pairing_token: adminFn('Make a one-time pairing token a new system can pair with, optionally for one system name.', 'Use it to let a new system pair. The token is shown once: give it to the admin and do not repeat it later.', ADMIN_ENDPOINTS.create_pairing_token),
  configure_system: adminFn('Set a system\'s config; refused unless it fits the system\'s config type.', 'Use it to set a system\'s config. Read its config type first (hub/system_get); secret fields are kept encrypted and never shown back.', ADMIN_ENDPOINTS.configure_system),
  enable_system: adminFn('Turn a system\'s functions and its renderers on or off.', 'Use it to turn a system\'s fns and renderers on or off without removing it.', ADMIN_ENDPOINTS.enable_system),
  remove_system: adminFn('Remove a system; its fns become unavailable until it pairs again.', 'Use it only when an admin asks to remove a system; its fns stop working until it pairs again. To pause it, use hub/enable_system instead.', ADMIN_ENDPOINTS.remove_system),
  install_system: adminFn('Install a system from a folder, a package or a git repository, and start it.', 'Use it when an admin asks to install a system from a folder, a package or a git URL. It starts the system; pairing may still need approval.', ADMIN_ENDPOINTS.install_system),
  start_system: adminFn('Start an installed system.', 'Use it to start an installed system that is stopped, then check hub/system_get to see that it connected.', ADMIN_ENDPOINTS.start_system),
  stop_system: adminFn('Stop an installed system.', 'Use it to stop an installed system; its fns are unavailable until it starts again.', ADMIN_ENDPOINTS.stop_system),
  upgrade_system: adminFn('Upgrade an installed system to a version (the latest when none is given).', 'Use it to move an installed system to a newer version; name the version when the admin asks for one.', ADMIN_ENDPOINTS.upgrade_system),
  set_model_role: adminFn('Choose the model (and provider) for a job: chat, transcription, dictation (or the browser\'s own), speech, describing images, reading text in them.', 'Use it when an admin picks the model for a job. Check the current choices with hub/model_roles first.', ADMIN_ENDPOINTS.set_model_role),
  clear_model_role: adminFn('Clear a job\'s model choice, so it falls back to the hub\'s default (or is off).', 'Use it to undo a job\'s model choice so the hub\'s default applies again.', ADMIN_ENDPOINTS.clear_model_role),
  set_model_limits: adminFn('Set a model\'s context window, output limit, reasoning reserve or characters per token; with every field absent, clear them.', 'Use it when a model\'s known limits are wrong (answers cut, prompts refused). Leave every field empty to go back to the limits the hub found.', ADMIN_ENDPOINTS.set_model_limits),
  create_mcp: adminFn('Make a hub MCP: an MCP endpoint with its own route and secret, exposing the systems, fns, types, context and resources its rules include.', 'Use it to expose part of the hub to an MCP client. Include only what the admin asked for, and check it first with hub/preview_mcp.', ADMIN_ENDPOINTS.create_mcp),
  update_mcp: adminFn('Change a hub MCP\'s name, rules, tool mode or person, or turn it on or off.', 'Use it to change a hub MCP; preview rule changes with hub/preview_mcp first.', ADMIN_ENDPOINTS.update_mcp),
  rotate_mcp_secret: adminFn('Give a hub MCP a new secret; every open session of it ends.', 'Use it when a hub MCP\'s secret may have leaked. Every open session of it ends, so say so.', ADMIN_ENDPOINTS.rotate_mcp_secret),
  delete_mcp: adminFn('Delete a hub MCP.', 'Use it only when an admin asks to delete a hub MCP; its clients stop working.', ADMIN_ENDPOINTS.delete_mcp),
  preview_mcp: adminFn('What draft hub MCP rules would expose now, with warnings, before they are saved.', 'Use it before saving hub MCP rules, to show the admin exactly what would be exposed and any warnings.', ADMIN_ENDPOINTS.preview_mcp),
  install_package: adminFn('Install a system package zip (made by `harness system pack`), pair it, configure it and start it.', 'Use it with a package zip made by `harness system pack`: it installs, pairs, configures and starts the system in one step.', ADMIN_ENDPOINTS.install_package),
  remove_instance: adminFn('Remove one instance of a system.', 'Use it only when an admin asks to remove one instance of a system. Offer hub/export_system_data first so its data can be kept.', ADMIN_ENDPOINTS.remove_instance),
  export_system_data: adminFn('Zip an instance\'s data folder with its config (secret fields only when asked) and return the content.', 'Use it to back up an instance before removing or moving it. Include secret fields only when the admin asks.', ADMIN_ENDPOINTS.export_system_data),
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
  /** The most tokens one answer may take (as core's `ModelLimits.maxOutputTokens`); the model's own limit when absent. */
  maxOutput: g.optional(ginAs(ModelLimits.shape.maxOutputTokens.unwrap())),
});

/** A failure, as a gin type (the same shape as core's `FnError`). */
export const FnErrorType = g.obj({
  class: g.enum(ERROR_CLASSES),
  message: g.text(),
  code: g.optional(g.text()),
  data: g.optional(json()),
});

const RunStatusType = g.enum(RUN_STATUSES);

/** What `hub/find` can look for: every kind of item a context link can point at (core's `LinkTarget`). */
export const FIND_KINDS = LINK_TARGET_KINDS;

/** How much of an item the model sees, as a gin type (core's `Detail`). */
const DetailType = g.enum(DETAIL_LEVELS);

/** One name `hub/load` or `hub/unload` could not take, and why. */
const RefusedName = g.obj({ name: g.text(), reason: g.text() });

/** One part of a resource sent to the model (`hub/resource_send`): an LLM message part's kind and name, and its size. */
const SentPart = ginAs(LlmContentPart.pick({ type: true, name: true }).extend({ chars: z.number().int().min(0) }));

/** A fn as `hub/fn_get` gives it. */
export const StoredFn = g.obj({
  fn: g.text(),
  kind: g.text(),
  description: g.text(),
  instructions: g.optional(g.text()),
  payload: g.optional(json()),
  /** 1 for a fn never saved again; the hub keeps every older version. */
  version: g.num({ min: 1, whole: true }),
  /** Who owns it (a saved fn's person); absent for a system's own fns. */
  owner: g.optional(g.text()),
  routing: g.optional(ginAs(FnRouting)),
  available: g.bool(),
});

/** `hub/save_fn`'s args. */
export const SaveFnArgs = g.obj({
  kind: g.field(g.text({ minLength: 1 }), { docs: 'The qualified kind (`input/form`): one of the calling system\'s own kinds.' }),
  name: g.field(g.text({ minLength: 1 }), { docs: 'Its local name (`trip_details`, `main.overdue_invoices`); the hub names it `<system>/<name>`.' }),
  description: g.text({ minLength: 1 }),
  instructions: g.optional(g.text()),
  payload: json(),
  examples: g.optional(g.list(ginAs(FnExample))),
  tags: g.optional(g.list(g.text())),
  share: g.field(g.optional(ginAs(ShareRule)), { docs: 'Who else may use it: private to the run\'s person when absent on a new fn; saving again keeps the current sharing when absent.' }),
  routing: g.optional(ginAs(FnRouting)),
  replace: g.field(g.optional(g.bool()), { docs: 'Save over the fn of this name, keeping the old version; otherwise a taken name is refused.' }),
});

/** The error code `hub/save_fn` fails with (class `caller`) when the name is taken and `replace` is not set. */
export const SAVE_FN_TAKEN = 'fn-taken';

/** How a model should use `hub/fns_search`. */
const FNS_SEARCH_GUIDE = [
  'Use it to find a fn before writing one: describe what it should do in plain words as `text`, and narrow with filters when you know them',
  '(`kinds: ["database/query"], instance: "main"` for the saved queries of one database; `kinds: ["input/form"]` for saved forms).',
  'Each hit has a score: the higher, the closer; compare a hit\'s description with what you need before reusing it. Without `text` it lists alphabetically.',
  'Page with `offset` set to `next`. Call a hit by its name with the args its `signature` shows, or load it with hub/load_fns first.',
].join(' ');

const FNS_SEARCH_EXAMPLES = [
  { args: { text: 'invoices that are overdue', kinds: ['database/query' as const], instance: 'main', limit: 5 }, note: 'The saved queries of one database closest to a question.' },
  { args: { text: 'ask for trip dates and travellers', kinds: ['input/form' as const] }, note: 'Saved forms that might already ask this.' },
  { args: { systems: ['fs'], modes: ['read' as const], order: 'alphabetical' as const }, note: 'Every fs fn that only reads, by name.' },
];

/** The hub's contract. */
export const hub = system('hub', { description: 'The hub: search and load fns and context, follow runs, ask people, and run agents.' })
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
      search_fns: fn({
        description: 'Find fns by what they do.',
        instructions: 'Use it when no fn in front of you does what is needed: describe the job in plain words (\'rename files\', \'sales by month\'). Then load the ones you will use with hub/load_fns. For filters (kind, system, instance, mode, types read or written) and paging use hub/fns_search.',
        examples: [{ args: { query: 'send an email' }, note: 'Find a fn by its job.' }, { args: { query: 'read a spreadsheet', limit: 5 } }],
        args: g.obj({ query: g.text(), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ fn: g.text(), description: g.text(), available: g.bool() })),
        tags: [READ_TAG],
        // bookkeeping the person needn't see as a card once it is done
        display: 'message',
      }),
      load_fns: fn({
        description: 'Add fns to your toolset for this session.',
        instructions: 'Use it after hub/search_fns, with the names you will call; they can be called from your next step. A refused name says why (no such fn, not allowed, unavailable). Load only what you need: every loaded fn takes room in the prompt.',
        examples: [{ args: { fns: ['fs/read', 'fs/edit'] }, note: 'Two fns for a file change.' }],
        args: g.obj({ fns: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ loaded: g.list(g.text()), refused: g.list(g.obj({ fn: g.text(), reason: g.text() })) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      drop_fns: fn({
        description: 'Remove fns from your toolset.',
        instructions: 'Use it when you are done with fns you loaded, to free room in the prompt for the rest of the session.',
        examples: [{ args: { fns: ['fs/edit'] } }],
        args: g.obj({ fns: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ dropped: g.list(g.text()) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      fns_search: fn({
        description: 'Search fns and context in the hub by words, meaning or both, best first or by name, filtered by kind, system, instance, who shares them, the types they read or write and their mode, a page at a time.',
        instructions: FNS_SEARCH_GUIDE,
        args: ginAs(FnSearchQuery),
        returns: ginAs(FnSearchPage),
        examples: FNS_SEARCH_EXAMPLES,
        tags: [READ_TAG],
        display: 'message',
      }),
      fn_examples: fn({
        description: 'A page of a fn\'s examples (args, the result when kept, and what each shows), the closest to a query first.',
        instructions: 'Use it before calling a fn whose args are long or easy to get wrong (a saved query, a form, code): give what you are about to do as `query` and follow the shape of the closest example. Page with `offset` set to `next` until `next` is absent.',
        args: ginAs(FnExamplesQuery),
        returns: ginAs(FnExamplesPage),
        examples: [
          { args: { fn: 'database/main.sales_by_month', query: 'sales for 2025 only' }, note: 'The examples closest to filtering one year come first.' },
          { args: { fn: 'input/trip_details', offset: 10, limit: 10 }, note: 'The second page of ten.' },
        ],
        tags: [READ_TAG],
        display: 'message',
      }),
      fn_get: fn({
        description: 'One fn as the hub keeps it: its kind, description, instructions, payload (for a fn of a kind), version and where it runs.',
        instructions: 'Use it to look inside a saved fn (a saved form, a saved query) before reusing or changing it. Only fns the run\'s person may see are given; another is "no such fn".',
        args: g.obj({ fn: g.field(g.text({ minLength: 1 }), { docs: 'The qualified fn name.' }) }),
        returns: StoredFn,
        examples: [{ args: { fn: 'input/trip_details' }, note: 'A saved form: its payload is the form.' }],
        tags: [READ_TAG],
        display: 'hidden',
      }),
      save_fn: fn({
        description: 'Keep a fn of one of the calling system\'s kinds in the hub (a saved form, a saved query), owned by the run\'s person and shared as asked. Saving a name again keeps the old version in its history.',
        instructions: 'Only the system that owns the kind may save fns of it. Give a description and instructions a model can choose and call it by, and examples (args, and the result when there is one). The hub checks the payload with the kind before keeping it, embeds it for hub/fns_search, and keeps its examples for hub/fn_examples.',
        args: SaveFnArgs,
        returns: g.obj({ fn: g.text(), version: g.num({ min: 1, whole: true }), created: g.bool() }),
        examples: [{
          args: { kind: 'input/form', name: 'trip_details', description: 'Asks for a trip\'s dates, destination and travellers.', payload: { title: 'Trip details', type: { name: 'obj', props: {} } }, share: { visibility: 'private', with: [] } },
          note: 'A saved form, private to its person.',
        }],
        tags: [],
        display: 'hidden',
      }),
      search_context: fn({
        description: 'Find context (guides, skills, references) by what it covers.',
        instructions: 'Use it when a task needs know-how you don\'t have in front of you (how a system is used, a team\'s conventions, a skill). Describe the topic; then load what fits with hub/load_context.',
        examples: [{ args: { query: 'how to write a system' } }, { args: { query: 'house style for reports', limit: 3 } }],
        args: g.obj({ query: g.text(), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ context: g.text(), description: g.text() })),
        tags: [READ_TAG],
        display: 'message',
      }),
      load_context: fn({
        description: 'Load context into this session.',
        instructions: 'Use it after hub/search_context, with the names that fit; their text is in front of you from the next step. Load only what the task needs.',
        examples: [{ args: { context: ['fs/system-authoring'] } }],
        args: g.obj({ context: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ loaded: g.list(g.text()) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      search_resources: fn({
        description: 'Search files and other resources by meaning and words.',
        instructions: 'Use it to find files, pages and uploads by what they say, across every system. Give a plain description of what you look for; narrow to roots (a folder\'s uri, a crawl) when you know them. Each hit has a section and a preview: read the best with hub/resource_read rather than guessing from the preview.',
        examples: [{ args: { query: 'where the hub client retries requests' }, note: 'Code by what it does.' }, { args: { query: 'refund policy', roots: ['web://docs.example.com'], limit: 5 }, note: 'One crawled site only.' }],
        args: g.obj({ query: g.text(), roots: g.optional(g.list(g.text())), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ uri: g.text(), section: g.optional(g.text()), title: g.text(), preview: g.text(), score: g.num() })),
        tags: [READ_TAG],
      }),
      run_status: fn({
        description: 'The status of a run, with its progress or result.',
        instructions: 'Use it to check on a run that went to the background or is waiting (for approval, for input). It does not wait: to wait for the end, use hub/run_wait.',
        examples: [{ args: { run: 'run_01HZX3' } }],
        args: g.obj({ run: g.text() }),
        returns: g.obj({ status: RunStatusType, progress: g.optional(json()), result: g.optional(json()), error: g.optional(FnErrorType) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      run_wait: fn({
        description: 'Wait for a run (for example one moved to the background) to finish.',
        instructions: 'Use it when you need the result of a background run before you can go on. Give a timeout when the person is waiting; if it comes back still running, say so and how long such runs usually take (hub/fn_metrics) rather than waiting again and again.',
        examples: [{ args: { run: 'run_01HZX3', timeout: 30000 }, note: 'Wait up to 30 seconds.' }],
        args: g.obj({ run: g.text(), timeout: g.field(g.optional(g.duration()), { docs: 'How long to wait, in milliseconds (30000 is 30 seconds). Leave empty to wait as long as this call may run.' }) }),
        returns: g.obj({ status: RunStatusType, result: g.optional(json()), error: g.optional(FnErrorType) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      ask_user: fn({
        description: 'Ask a person a question and wait for the answer.',
        instructions: 'Use it only when you cannot go on without an answer that only a person has (a choice between options, a missing detail). Ask one short, specific question; for several fields at once use input/get_input. Leave `user` empty to ask the person in the chat.',
        examples: [{ args: { question: 'Should the report cover only this quarter, or the whole year?' } }],
        args: g.obj({ question: g.text(), user: g.optional(g.text()) }),
        returns: g.obj({ answer: g.text() }),
        tags: [READ_TAG],
      }),
      // ─── The static toolset's fns (`run` is not a fn: its calls become runs of the named fn) ───
      find: fn({
        description: 'Find fns, context, resources and types by what they are about. Already loaded items are marked.',
        instructions: 'Use it first when you need something you don\'t have in front of you: describe it in plain words, and narrow `kinds` when you know you need a fn, context, a resource or a type. Then hub/inspect one hit, or hub/load the ones you will use.',
        examples: [{ args: { query: 'rename a file', kinds: ['fn'] } }, { args: { query: 'invoice table', kinds: ['type'], limit: 5 } }],
        args: g.obj({ query: g.text({ minLength: 1 }), kinds: g.optional(g.list(g.enum(FIND_KINDS))), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ name: g.text(), kind: g.enum(FIND_KINDS), description: g.text(), loaded: g.bool() })),
        tags: [READ_TAG],
        display: 'message',
      }),
      inspect: fn({
        description: 'Look at one item at a detail: a fn\'s card, a context item\'s text, a type\'s definition, or a resource\'s outline.',
        instructions: 'Use it to look at one hit from hub/find before using it. `signature` shows a fn\'s args; `full` adds its instructions and examples. It does not keep the item: use hub/load for that.',
        examples: [{ args: { name: 'fs/edit', detail: 'full' }, note: 'A fn card with its examples.' }, { args: { name: 'fs/Entry' } }],
        args: g.obj({ name: g.text({ minLength: 1 }), detail: g.optional(DetailType) }),
        returns: g.obj({ name: g.text(), kind: g.enum(FIND_KINDS), detail: DetailType, text: g.text() }),
        tags: [READ_TAG],
        display: 'message',
      }),
      load: fn({
        description: 'Keep fns (as cards) and context (as text) in front of you from the next step on.',
        instructions: 'Use it to keep fns and context you will use in front of you from the next step on. Use the lowest detail that is enough (`signature` for a fn you know how to call), since everything loaded takes room in the prompt.',
        examples: [{ args: { names: ['fs/read', 'fs/edit'], detail: 'signature' } }],
        args: g.obj({ names: g.list(g.text(), { minLength: 1 }), detail: g.optional(DetailType) }),
        returns: g.obj({ loaded: g.list(g.text()), refused: g.list(RefusedName) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      unload: fn({
        description: 'Take fns and context out of what you keep in front of you.',
        instructions: 'Use it when you are done with fns or context you loaded, to keep the prompt small.',
        examples: [{ args: { names: ['fs/edit'] } }],
        args: g.obj({ names: g.list(g.text(), { minLength: 1 }) }),
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
        description: 'Show a resource (or one section) to yourself at the next step as the model can take it: text, an image, audio or a file.',
        instructions: 'Use it to look at a resource the way it is (an image, a chart, a PDF page) when its text is not enough. It costs prompt room, so send one section when you can.',
        examples: [{ args: { uri: 'upload://s1/photo.jpg' }, note: 'Look at an uploaded photo.' }],
        args: ginAs(ResourceSendArgs),
        returns: g.obj({ parts: g.list(SentPart) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      // ─── Hub MCP session tokens for grantee systems ───
      mint_mcp_token: fn({
        description: 'Mint a short-lived token for a hub MCP, for a session this system starts (a Claude session, for one). Only a grantee system\'s runs may call it.',
        instructions: 'Only a grantee system calls it, when it starts a session that should reach the hub through MCP. Pass the token to that session only and never show it to a person.',
        args: ginAs(MintMcpTokenArgs),
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
  .with({ fns: { ...readFns, ...writeFns } })
  .with(({ fns, kinds }) => {
    const tools = [fns.search_fns.name, fns.load_fns.name, fns.search_context.name, fns.load_context.name, fns.search_resources.name, fns.run_status.name, fns.run_wait.name, fns.ask_user.name];
    return {
      fns: {
        chat: kinds.llm.fn({
          description: 'The chat agent: answers people in a session with every tool the session allows.',
          payload: {
            instructions: 'You are a helpful assistant inside harness. Use tools when they help, say what you did, and keep answers short.',
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
          payload: {
            instructions: 'You are a helpful assistant inside harness. Find, inspect and run fns when they help, say what you did, and keep answers short.',
            tools,
            canLoad: {},
            maxTools: 64,
            context: [],
            hooks: [],
            toolExecution: 'sequential',
            maxIterations: 16,
            mode: { type: 'static' },
            contextor: { type: 'graph' },
          },
          args: g.obj({}),
          returns: g.text(),
        }),
      },
    };
  })
  .with({ fns: adminFns });

/** The hub's contract type. */
export type HubContract = typeof hub;
