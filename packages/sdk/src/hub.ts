/**
 * The hub's contract. The hub is a system too, built with the same SDK: other systems depend on its fns, use its
 * `llm` kind (every agent is a fn of it), refer to its sectioners, and use its named types as fields
 * (`g.nullable(hub.types.ContentRef)`). The hub implements this contract in its own process.
 */
import { RUN_STATUSES } from '@harness/core';
import { fn } from './fn.ts';
import { kind, mention, sectioner, type } from './declare.ts';
import { g, json } from './gin.ts';
import { system } from './system.ts';

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
  class: g.enum(['retry', 'caller', 'fatal']),
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
        shape: g.obj({ hash: g.text({ pattern: '^[0-9a-f]{64}$' }), size: g.num({ min: 0, whole: true }), mime: g.text() }),
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
      }),
    },
    fns: {
      search_fns: fn({
        description: 'Find fns by what they do.',
        args: g.obj({ query: g.text(), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ fn: g.text(), description: g.text(), available: g.bool() })),
        tags: ['read'],
      }),
      load_fns: fn({
        description: 'Add fns to your toolset for this session.',
        args: g.obj({ fns: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ loaded: g.list(g.text()), refused: g.list(g.obj({ fn: g.text(), reason: g.text() })) }),
        tags: ['read'],
      }),
      drop_fns: fn({
        description: 'Remove fns from your toolset.',
        args: g.obj({ fns: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ dropped: g.list(g.text()) }),
        tags: ['read'],
      }),
      search_context: fn({
        description: 'Find context (guides, skills, references) by what it covers.',
        args: g.obj({ query: g.text(), limit: g.optional(g.num({ min: 1, max: 50, whole: true })) }),
        returns: g.list(g.obj({ context: g.text(), description: g.text() })),
        tags: ['read'],
      }),
      load_context: fn({
        description: 'Load context into this session.',
        args: g.obj({ context: g.list(g.text(), { minLength: 1 }) }),
        returns: g.obj({ loaded: g.list(g.text()) }),
        tags: ['read'],
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
      }),
      run_wait: fn({
        description: 'Wait for a run (for example one moved to the background) to finish.',
        args: g.obj({ run: g.text(), timeout: g.optional(g.duration()) }),
        returns: g.obj({ status: RunStatusType, result: g.optional(json()), error: g.optional(FnErrorType) }),
        tags: ['read'],
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
  }));

/** The hub's contract type. */
export type HubContract = typeof hub;
