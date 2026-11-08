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
  Section, settingsSlice, systemsSlice, LlmContentPart, ModelLimits, type Display, type LinkTargetKind,
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
function endpointFn<E extends EndpointLike>(description: string, endpoint: E, tags: readonly string[], display?: Display) {
  return fn({
    description,
    args: toolArgsOf<E['cfg']['body']>(endpoint.cfg.body).args,
    returns: resultTypeOf(endpoint),
    tags: [...tags],
    ...(display === undefined ? {} : { display }),
  });
}

/** A fn for a web read, tagged `read`. Reads are bookkeeping the person needn't see as a card once done. */
function readFn<E extends EndpointLike>(description: string, endpoint: E) {
  return endpointFn(description, endpoint, [READ_TAG], 'message');
}

/** A fn for a write on resources, context or memory: it asks unless a policy allows it. */
function writeFn<E extends EndpointLike>(description: string, endpoint: E) {
  return endpointFn(description, endpoint, []);
}

/** A fn for an admin operation, tagged `admin`. */
function adminFn<E extends EndpointLike>(description: string, endpoint: E) {
  return endpointFn(description, endpoint, [ADMIN_TAG]);
}

/** The hub's read fns (`HUB_READ_ENDPOINTS`), each described for the agent that offers them. */
const readFns = {
  resource_list: readFn('List resources (files, pages, uploads) from every system and the hub, filtered, grouped and paged.', HUB_READ_ENDPOINTS.resource_list),
  resource_read: readFn('Read a resource as text: its primary form (markdown for pages, tables for spreadsheets) or a chosen form, whole or by sections.', HUB_READ_ENDPOINTS.resource_read),
  context_get: readFn('One context item (a guide, skill, memory or piece of a resource) with its text and its links both ways.', HUB_READ_ENDPOINTS.context_get),
  types_get: readFn('The definitions of named types and of every type they refer to, dependencies first.', HUB_READ_ENDPOINTS.types_get),
  runs_list: readFn('Runs, newest first, filtered by fn, status, session or system. A member sees their own runs.', HUB_READ_ENDPOINTS.runs_list),
  run_get: readFn('One run: its fn, args, status, result or error, cost and timings.', HUB_READ_ENDPOINTS.run_get),
  run_tree: readFn('The tree of runs a turn made: each run with the runs it called.', HUB_READ_ENDPOINTS.run_tree),
  llm_call: readFn('One LLM call: its whole request and response, tokens, cost and timings.', HUB_READ_ENDPOINTS.llm_call),
  model_calls: readFn('Model calls of every kind (chat, embeddings, images, transcription, speech), newest first, with cost and timings.', HUB_READ_ENDPOINTS.model_calls),
  fn_metrics: readFn('How fns have been doing: runs, outcomes, retries, durations (p50, p95), queue waits, cost and tokens.', HUB_READ_ENDPOINTS.fn_metrics),
  sessions_list: readFn('Chat sessions, most recent first.', HUB_READ_ENDPOINTS.sessions_list),
  session_messages: readFn('A session\'s messages, newest first, paged backwards.', HUB_READ_ENDPOINTS.session_messages),
  systems_list: readFn('Every system: whether it is connected, its version, instances and what it offers.', HUB_READ_ENDPOINTS.systems_list),
  system_get: readFn('One system: its status, version, instances, config state and what it offers.', HUB_READ_ENDPOINTS.system_get),
  system_fns: readFn('A system\'s fns, with whether each can be used now and its running numbers.', HUB_READ_ENDPOINTS.system_fns),
  system_logs: readFn('The end of a system\'s output, oldest first.', HUB_READ_ENDPOINTS.system_logs),
  model_roles: readFn('Which model (and provider) the hub uses for each job: chat, transcription, dictation, speech, describing images, reading text in them.', HUB_READ_ENDPOINTS.model_roles),
  model_limits: readFn('Each model\'s context window, output limit, reasoning reserve and characters per token, with where each came from.', HUB_READ_ENDPOINTS.model_limits),
} satisfies Record<HubReadFnName, unknown>;

/** The hub's write fns on resources, context and memory (`HUB_WRITE_ENDPOINTS`). */
const writeFns = {
  resource_convert: writeFn('Make a form of a resource now (convert it, describe an image, read the text in it, transcribe audio); it may cost a model call.', HUB_WRITE_ENDPOINTS.resource_convert),
  resource_import: writeFn('Import a URL or uploaded content as a hub resource, kept and converted by the hub.', HUB_WRITE_ENDPOINTS.resource_import),
  resource_rename: writeFn('Rename a hub resource.', HUB_WRITE_ENDPOINTS.resource_rename),
  resource_delete: writeFn('Delete a hub resource; says how many messages, context items and runs still point at it.', HUB_WRITE_ENDPOINTS.resource_delete),
  context_from_resource: writeFn('Make context items from a resource (one per section, under an outline parent), or update the ones made before.', HUB_WRITE_ENDPOINTS.context_from_resource),
  remember: writeFn('Remember something for later as a memory: for this session, the person, or everyone.', HUB_WRITE_ENDPOINTS.remember),
  forget: writeFn('Forget a memory.', HUB_WRITE_ENDPOINTS.forget),
} satisfies Record<HubWriteFnName, unknown>;

/** The hub's admin fns (`ADMIN_ENDPOINTS`), each described for the agent that offers them. */
const adminFns = {
  configure_provider: adminFn('Add a model provider (OpenAI, OpenRouter, Ollama) with its API key, or replace its key. The key is stored encrypted.', ADMIN_ENDPOINTS.configure_provider),
  set_model_category: adminFn('Add a model category (a named, ordered list of models), or change the one with this id.', ADMIN_ENDPOINTS.set_model_category),
  set_budget: adminFn('Add a spending budget for the hub, a group, a user, a session, a system, a fn or a model, or change the one with this id.', ADMIN_ENDPOINTS.set_budget),
  set_priority: adminFn('Add a priority rule (the default and highest priority of turns at a level), or change the one with this id.', ADMIN_ENDPOINTS.set_priority),
  set_policy: adminFn('Add a policy saying whether actors may run fns (allow, deny, or ask an approver), or change the one with this id.', ADMIN_ENDPOINTS.set_policy),
  set_actor_setting: adminFn('Set a setting a system declares for a user, group or agent.', ADMIN_ENDPOINTS.set_actor_setting),
  add_user: adminFn('Add a person who can sign in, with their role and groups.', ADMIN_ENDPOINTS.add_user),
  add_group: adminFn('Add a group of people.', ADMIN_ENDPOINTS.add_group),
  remove_rule: adminFn('Remove a budget, priority rule, policy, model category or provider.', ADMIN_ENDPOINTS.remove_rule),
  approve_pairing: adminFn('Approve or refuse a system that asked to pair with the hub, optionally naming its instance and setting its config.', ADMIN_ENDPOINTS.approve_pairing),
  create_pairing_token: adminFn('Make a one-time pairing token a new system can pair with, optionally for one system name.', ADMIN_ENDPOINTS.create_pairing_token),
  configure_system: adminFn('Set a system\'s config; refused unless it fits the system\'s config type.', ADMIN_ENDPOINTS.configure_system),
  enable_system: adminFn('Turn a system\'s functions and its renderers on or off.', ADMIN_ENDPOINTS.enable_system),
  remove_system: adminFn('Remove a system; its fns become unavailable until it pairs again.', ADMIN_ENDPOINTS.remove_system),
  install_system: adminFn('Install a system from a folder, a package or a git repository, and start it.', ADMIN_ENDPOINTS.install_system),
  start_system: adminFn('Start an installed system.', ADMIN_ENDPOINTS.start_system),
  stop_system: adminFn('Stop an installed system.', ADMIN_ENDPOINTS.stop_system),
  upgrade_system: adminFn('Upgrade an installed system to a version (the latest when none is given).', ADMIN_ENDPOINTS.upgrade_system),
  set_model_role: adminFn('Choose the model (and provider) for a job: chat, transcription, dictation (or the browser\'s own), speech, describing images, reading text in them.', ADMIN_ENDPOINTS.set_model_role),
  clear_model_role: adminFn('Clear a job\'s model choice, so it falls back to the hub\'s default (or is off).', ADMIN_ENDPOINTS.clear_model_role),
  set_model_limits: adminFn('Set a model\'s context window, output limit, reasoning reserve or characters per token; with every field absent, clear them.', ADMIN_ENDPOINTS.set_model_limits),
  create_mcp: adminFn('Make a hub MCP: an MCP endpoint with its own route and secret, exposing the systems, fns, types, context and resources its rules include.', ADMIN_ENDPOINTS.create_mcp),
  update_mcp: adminFn('Change a hub MCP\'s name, rules, tool mode or person, or turn it on or off.', ADMIN_ENDPOINTS.update_mcp),
  rotate_mcp_secret: adminFn('Give a hub MCP a new secret; every open session of it ends.', ADMIN_ENDPOINTS.rotate_mcp_secret),
  delete_mcp: adminFn('Delete a hub MCP.', ADMIN_ENDPOINTS.delete_mcp),
  preview_mcp: adminFn('What draft hub MCP rules would expose now, with warnings, before they are saved.', ADMIN_ENDPOINTS.preview_mcp),
  install_package: adminFn('Install a system package zip (made by `harness system pack`), pair it, configure it and start it.', ADMIN_ENDPOINTS.install_package),
  remove_instance: adminFn('Remove one instance of a system.', ADMIN_ENDPOINTS.remove_instance),
  export_system_data: adminFn('Zip an instance\'s data folder with its config (secret fields only when asked) and return the content.', ADMIN_ENDPOINTS.export_system_data),
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
export const FIND_KINDS = ['fn', 'context', 'resource', 'type'] as const satisfies readonly LinkTargetKind[];

/** How much of an item the model sees, as a gin type (core's `Detail`). */
const DetailType = g.enum(DETAIL_LEVELS);

/** One name `hub/load` or `hub/unload` could not take, and why. */
const RefusedName = g.obj({ name: g.text(), reason: g.text() });

/** One part of a resource sent to the model (`hub/resource_send`): an LLM message part's kind and name, and its size. */
const SentPart = ginAs(LlmContentPart.pick({ type: true, name: true }).extend({ chars: z.number().int().min(0) }));

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
        args: g.obj({ query: g.text(), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ fn: g.text(), description: g.text(), available: g.bool() })),
        tags: [READ_TAG],
        // bookkeeping the person needn't see as a card once it is done
        display: 'message',
      }),
      load_fns: fn({
        description: 'Add fns to your toolset for this session.',
        args: g.obj({ fns: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ loaded: g.list(g.text()), refused: g.list(g.obj({ fn: g.text(), reason: g.text() })) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      drop_fns: fn({
        description: 'Remove fns from your toolset.',
        args: g.obj({ fns: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ dropped: g.list(g.text()) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      search_context: fn({
        description: 'Find context (guides, skills, references) by what it covers.',
        args: g.obj({ query: g.text(), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ context: g.text(), description: g.text() })),
        tags: [READ_TAG],
        display: 'message',
      }),
      load_context: fn({
        description: 'Load context into this session.',
        args: g.obj({ context: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ loaded: g.list(g.text()) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      search_resources: fn({
        description: 'Search files and other resources by meaning and words.',
        args: g.obj({ query: g.text(), roots: g.optional(g.list(g.text())), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ uri: g.text(), section: g.optional(g.text()), title: g.text(), preview: g.text(), score: g.num() })),
        tags: [READ_TAG],
      }),
      run_status: fn({
        description: 'The status of a run, with its progress or result.',
        args: g.obj({ run: g.text() }),
        returns: g.obj({ status: RunStatusType, progress: g.optional(json()), result: g.optional(json()), error: g.optional(FnErrorType) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      run_wait: fn({
        description: 'Wait for a run (for example one moved to the background) to finish.',
        args: g.obj({ run: g.text(), timeout: g.optional(g.duration()) }),
        returns: g.obj({ status: RunStatusType, result: g.optional(json()), error: g.optional(FnErrorType) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      ask_user: fn({
        description: 'Ask a person a question and wait for the answer.',
        args: g.obj({ question: g.text(), user: g.optional(g.text()) }),
        returns: g.obj({ answer: g.text() }),
        tags: [READ_TAG],
      }),
      // ─── The static toolset's fns (`run` is not a fn: its calls become runs of the named fn) ───
      find: fn({
        description: 'Find fns, context, resources and types by what they are about. Already loaded items are marked.',
        args: g.obj({ query: g.text({ minLength: 1 }), kinds: g.optional(g.list(g.enum(FIND_KINDS))), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ name: g.text(), kind: g.enum(FIND_KINDS), description: g.text(), loaded: g.bool() })),
        tags: [READ_TAG],
        display: 'message',
      }),
      inspect: fn({
        description: 'Look at one item at a detail: a fn\'s card, a context item\'s text, a type\'s definition, or a resource\'s outline.',
        args: g.obj({ name: g.text({ minLength: 1 }), detail: g.optional(DetailType) }),
        returns: g.obj({ name: g.text(), kind: g.enum(FIND_KINDS), detail: DetailType, text: g.text() }),
        tags: [READ_TAG],
        display: 'message',
      }),
      load: fn({
        description: 'Keep fns (as cards) and context (as text) in front of you from the next step on.',
        args: g.obj({ names: g.list(g.text(), { minLength: 1 }), detail: g.optional(DetailType) }),
        returns: g.obj({ loaded: g.list(g.text()), refused: g.list(RefusedName) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      unload: fn({
        description: 'Take fns and context out of what you keep in front of you.',
        args: g.obj({ names: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ unloaded: g.list(g.text()), refused: g.list(RefusedName) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      // ─── Resources beyond the web endpoints ───
      resource_outline: fn({
        description: 'A resource\'s sections (headings, symbols, pages or tables), each with its key and place in the outline.',
        args: ginAs(ResourceOutlineArgs),
        returns: g.list(ginAs(Section)),
        tags: [READ_TAG],
        display: 'message',
      }),
      resource_send: fn({
        description: 'Show a resource (or one section) to yourself at the next step as the model can take it: text, an image, audio or a file.',
        args: ginAs(ResourceSendArgs),
        returns: g.obj({ parts: g.list(SentPart) }),
        tags: [READ_TAG],
        display: 'hidden',
      }),
      // ─── Hub MCP session tokens for grantee systems ───
      mint_mcp_token: fn({
        description: 'Mint a short-lived token for a hub MCP, for a session this system starts (a Claude session, for one). Only a grantee system\'s runs may call it.',
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
