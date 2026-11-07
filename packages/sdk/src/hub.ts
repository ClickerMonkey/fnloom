/**
 * The hub's contract. The hub is a system too, built with the same SDK: other systems depend on its fns, use its
 * `llm` kind (every agent is a fn of it), refer to its sectioners, and use its named types as fields
 * (`g.nullable(hub.types.ContentRef)`). The hub implements this contract in its own process.
 */
import { adminSlice, CONTENT_HASH_PATTERN, ERROR_CLASSES, RUN_STATUSES, settingsSlice, systemsSlice } from '@harness/core';
import type { z } from 'zod';
import { fn } from './fn.ts';
import { kind, mention, sectioner, type } from './declare.ts';
import { g, json } from './gin.ts';
import { system } from './system.ts';
import { ginOf, toolArgsOf } from './zod-gin.ts';

/**
 * The web admin endpoints the hub also offers as fns, so whatever an admin configures can be done by asking in chat:
 * fn name → endpoint. The endpoint's body and response are the fn's args and result (one source of truth), and the
 * hub's admin fn and the web handler run the same operation.
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
} as const;

/** An admin fn's name. */
export type AdminFnName = keyof typeof ADMIN_ENDPOINTS;

/**
 * A fn for one admin operation, its args and result read off the endpoint's body and response. It is never tagged
 * `read`, so unless a policy says otherwise it waits for the person's approval, and the hub runs it only for an admin.
 */
function adminFn(description: string, endpoint: { readonly cfg: { readonly body: z.ZodType; readonly response?: z.ZodType } }) {
  return fn({ description, args: toolArgsOf(endpoint.cfg.body).args, returns: endpoint.cfg.response === undefined ? g.obj({}) : ginOf(endpoint.cfg.response) });
}

/** The hub's admin fns (`ADMIN_ENDPOINTS`), each described for the agent that offers them. */
const adminFns = {
  configure_provider: adminFn('Add a model provider (OpenAI, OpenRouter) with its API key, or replace its key. The key is stored encrypted.', ADMIN_ENDPOINTS.configure_provider),
  set_model_category: adminFn('Add a model category (a named, ordered list of models), or change the one with this id.', ADMIN_ENDPOINTS.set_model_category),
  set_budget: adminFn('Add a spending budget for the hub, a group, a user, a session, a system, a fn or a model, or change the one with this id.', ADMIN_ENDPOINTS.set_budget),
  set_priority: adminFn('Add a priority rule (the default and highest priority of turns at a level), or change the one with this id.', ADMIN_ENDPOINTS.set_priority),
  set_policy: adminFn('Add a policy saying whether actors may run fns (allow, deny, or ask an approver), or change the one with this id.', ADMIN_ENDPOINTS.set_policy),
  set_actor_setting: adminFn('Set a setting a system declares for a user, group or agent.', ADMIN_ENDPOINTS.set_actor_setting),
  add_user: adminFn('Add a person who can sign in, with their role and groups.', ADMIN_ENDPOINTS.add_user),
  add_group: adminFn('Add a group of people.', ADMIN_ENDPOINTS.add_group),
  remove_rule: adminFn('Remove a budget, priority rule, policy, model category or provider.', ADMIN_ENDPOINTS.remove_rule),
  approve_pairing: adminFn('Approve or refuse a system that asked to pair with the hub.', ADMIN_ENDPOINTS.approve_pairing),
  create_pairing_token: adminFn('Make a one-time pairing token a new system can pair with, optionally for one system name.', ADMIN_ENDPOINTS.create_pairing_token),
  configure_system: adminFn('Set a system\'s config; refused unless it fits the system\'s config type.', ADMIN_ENDPOINTS.configure_system),
  enable_system: adminFn('Turn a system\'s functions and its renderers on or off.', ADMIN_ENDPOINTS.enable_system),
  remove_system: adminFn('Remove a system; its fns become unavailable until it pairs again.', ADMIN_ENDPOINTS.remove_system),
  install_system: adminFn('Install a system from a folder, a package or a git repository, and start it.', ADMIN_ENDPOINTS.install_system),
  start_system: adminFn('Start an installed system.', ADMIN_ENDPOINTS.start_system),
  stop_system: adminFn('Stop an installed system.', ADMIN_ENDPOINTS.stop_system),
  upgrade_system: adminFn('Upgrade an installed system to a version (the latest when none is given).', ADMIN_ENDPOINTS.upgrade_system),
} satisfies Record<AdminFnName, unknown>;

/** Which model an agent or an LLM call uses: a model id, a category, or automatic selection by weights. */
export const ModelChoiceType = g.or([
  g.obj({ model: g.text({ minLength: 1 }) }),
  g.obj({ category: g.text({ minLength: 1 }) }),
  g.obj({ auto: g.obj({ cost: g.optional(g.num({ min: 0 })), speed: g.optional(g.num({ min: 0 })), accuracy: g.optional(g.num({ min: 0 })) }) }),
]);

/** The payload of a `hub/llm` fn: an agent's instructions, model, tools, context and limits. Built by `agent()`. */
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
});

/** A failure, as a gin type (the same shape as core's `FnError`). */
export const FnErrorType = g.obj({
  class: g.enum(ERROR_CLASSES),
  message: g.text(),
  code: g.optional(g.text()),
  data: g.optional(json()),
});

const RunStatusType = g.enum(RUN_STATUSES);

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
        tags: ['read'],
        // bookkeeping the person needn't see as a card once it is done
        display: 'message',
      }),
      load_fns: fn({
        description: 'Add fns to your toolset for this session.',
        args: g.obj({ fns: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ loaded: g.list(g.text()), refused: g.list(g.obj({ fn: g.text(), reason: g.text() })) }),
        tags: ['read'],
        // bookkeeping the person needn't see as a card once it is done
        display: 'hidden',
      }),
      drop_fns: fn({
        description: 'Remove fns from your toolset.',
        args: g.obj({ fns: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ dropped: g.list(g.text()) }),
        tags: ['read'],
        // bookkeeping the person needn't see as a card once it is done
        display: 'hidden',
      }),
      search_context: fn({
        description: 'Find context (guides, skills, references) by what it covers.',
        args: g.obj({ query: g.text(), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ context: g.text(), description: g.text() })),
        tags: ['read'],
        // bookkeeping the person needn't see as a card once it is done
        display: 'message',
      }),
      load_context: fn({
        description: 'Load context into this session.',
        args: g.obj({ context: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ loaded: g.list(g.text()) }),
        tags: ['read'],
        // bookkeeping the person needn't see as a card once it is done
        display: 'hidden',
      }),
      search_resources: fn({
        description: 'Search files and other resources by meaning and words.',
        args: g.obj({ query: g.text(), roots: g.optional(g.list(g.text())), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ uri: g.text(), section: g.optional(g.text()), title: g.text(), preview: g.text(), score: g.num() })),
        tags: ['read'],
      }),
      run_status: fn({
        description: 'The status of a run, with its progress or result.',
        args: g.obj({ run: g.text() }),
        returns: g.obj({ status: RunStatusType, progress: g.optional(json()), result: g.optional(json()), error: g.optional(FnErrorType) }),
        tags: ['read'],
        // bookkeeping the person needn't see as a card once it is done
        display: 'hidden',
      }),
      run_wait: fn({
        description: 'Wait for a run (for example one moved to the background) to finish.',
        args: g.obj({ run: g.text(), timeout: g.optional(g.duration()) }),
        returns: g.obj({ status: RunStatusType, result: g.optional(json()), error: g.optional(FnErrorType) }),
        tags: ['read'],
        // bookkeeping the person needn't see as a card once it is done
        display: 'hidden',
      }),
      ask_user: fn({
        description: 'Ask a person a question and wait for the answer.',
        args: g.obj({ question: g.text(), user: g.optional(g.text()) }),
        returns: g.obj({ answer: g.text() }),
        tags: ['read'],
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
    },
  })
  .with(({ fns, kinds }) => ({
    fns: {
      chat: kinds.llm.fn({
        description: 'The chat agent: answers people in a session with every tool the session allows.',
        payload: {
          instructions: 'You are a helpful assistant inside harness. Use tools when they help, say what you did, and keep answers short.',
          tools: [fns.search_fns.name, fns.load_fns.name, fns.search_context.name, fns.load_context.name, fns.search_resources.name, fns.run_status.name, fns.run_wait.name, fns.ask_user.name],
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
    },
  }))
  .with({ fns: adminFns });

/** The hub's contract type. */
export type HubContract = typeof hub;
