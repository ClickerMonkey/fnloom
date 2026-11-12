/**
 * The authoring guide as a context graph, the way fs serves it from its `context/` folder: a shallow index
 * (`fs/authoring`), a few topic groups under it, then one item per part of the guide (and its API reference beside it).
 * Every item has a short summary, and every step down is a choice worded as a decision, so a small model walks the
 * graph a step at a time and loads only what the request needs. The hub shows each choice with its token size.
 *
 * The words live here; `parts.ts` writes the files from them and the guide (`npm run docs:authoring`).
 */

/** A group of parts under the index. */
export interface AuthoringGroup {
  /** Its stable key's last part (`fs/authoring.topics.<id>`). */
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** The index's choice line for it: when to pick it. */
  readonly when: string;
  /** Its parts, by topic id, in reading order. */
  readonly topics: readonly string[];
}

/** One part's words: its summary and the group's choice line for it. */
export interface PartWords {
  readonly summary: string;
  readonly when: string;
}

/** The index item's words. */
export const AUTHORING_INDEX = {
  key: 'authoring',
  title: 'Writing a harness system',
  summary: 'How to write, test and install a harness system: start at a topic group, then load only the parts the work needs.',
  body: [
    'A **system** is a Node process that connects to the hub and adds fns, types, context, mentions, hooks, settings,',
    'resources and renderers. You write one with the fs fns this context brings: fn:fs/read, fn:fs/write, fn:fs/edit and',
    'fn:fs/bash. fs/write makes parent folders itself, so never `mkdir` first; in bash, paths use forward slashes.',
    '',
    'The steps, in order:',
    '',
    '1. Copy the template system (`harness system new <name>`, or copy `systems/template` and rename `template`).',
    '2. Write the contract in `shared/index.ts`, the implementation in `server/impl.ts` and tests beside it.',
    '3. Run its tests with fs/bash (`harness test systems/<name>`); fs/install_system typechecks the folder and runs them too.',
    '4. Install it with fn:fs/install_system: once an admin approves the card, it builds, checks and starts the system on',
    '   this machine and connects it to the hub. Call it again after every change.',
    '5. Installed is not live: nothing it offers can be called until an admin reviews it in the hub and presses Go live.',
    '   Tell the person so, with the review page (`/admin/systems/<name>/review`). A later change to its contract waits',
    '   for the same review; the live version keeps serving meanwhile.',
    '',
    'Pick one group below and load it with `hub/load_context`; each group lists its parts as choices with their sizes.',
  ].join('\n'),
} as const;

/** The groups, in the order the index offers them. */
export const AUTHORING_GROUPS: readonly AuthoringGroup[] = [
  {
    id: 'begin',
    title: 'Making a system: folder, contract, install and tests',
    summary: 'The folder and the template, the contract, packaging and installing, testing, and the usual mistakes.',
    when: 'Pick this first when you make a new system or install, test or fix one.',
    topics: ['start', 'folder', 'contract', 'packaging', 'testing', 'mistakes'],
  },
  {
    id: 'types',
    title: 'Types: gin and named types',
    summary: 'How every shape is written with gin, and named types with methods.',
    when: 'Pick this when you write args, results, config or a named type.',
    topics: ['gin', 'named-types'],
  },
  {
    id: 'fns',
    title: 'Fns: declaring, running and calling them',
    summary: 'Fns, handlers and progress, session state and forms, outcomes, kinds and agents, and calling other fns.',
    when: 'Pick this when you declare or implement a fn, a kind or an agent.',
    topics: ['fns', 'handlers-progress', 'state-forms', 'outcomes', 'kinds-agents', 'calling'],
  },
  {
    id: 'declare',
    title: 'Other things a contract declares',
    summary: 'Settings and attachments, context and commands, hooks, mentions, actions, model providers and resources.',
    when: 'Pick this when the system adds context, a hook, a mention, an action, a provider or resources.',
    topics: ['settings-attachments', 'context', 'hooks', 'mentions', 'actions', 'providers', 'resources'],
  },
  {
    id: 'server',
    title: 'The server and the hub',
    summary: 'The hub contract, serve and the implementation, the run context, config and lifecycle, and the internals.',
    when: 'Pick this when you write server code, call the hub, or handle config and lifecycle.',
    topics: ['hub', 'server', 'ctx', 'lifecycle', 'internals'],
  },
  {
    id: 'client',
    title: 'The client: renderers and views',
    summary: 'Vue renderers, inputs and resource views typed by the contract.',
    when: 'Pick this when the system draws its results, inputs or resources in the app.',
    topics: ['client'],
  },
  {
    id: 'examples',
    title: 'Worked examples and the core types',
    summary: 'Complete compiled example systems, and every core type the SDK refers to.',
    when: 'Pick this to copy from a complete example, or to look up a core type.',
    topics: ['examples', 'core-types'],
  },
];

/** Each part's words, by topic id. */
export const PART_WORDS: Readonly<Record<string, PartWords>> = {
  start: { summary: 'What a system is, and the steps to write one.', when: 'Pick this to see the whole path once, before anything else.' },
  folder: { summary: 'The system folder and every file of the template system.', when: 'Pick this when you copy the template or wonder what a file is for.' },
  contract: { summary: 'The contract in shared/index.ts: system(), with() and its sections.', when: 'Pick this when you write or change shared/index.ts.' },
  gin: { summary: 'Every shape is a gin type made with g; Infer gives its TypeScript type.', when: 'Pick this when you write args, results or config with g.' },
  'named-types': { summary: 'Named types (type()) and the methods on them.', when: 'Pick this when a value needs a name others can refer to, or methods.' },
  fns: { summary: 'Declaring a native fn: description, instructions, args, returns, examples and every option.', when: 'Pick this when you declare a fn.' },
  'handlers-progress': { summary: 'Handlers a caller supplies, and progress a fn reports.', when: 'Pick this when a fn reports progress or calls back into its caller.' },
  'state-forms': { summary: 'Session state, forms that ask the person, and how runs display.', when: 'Pick this when a fn keeps session state or asks the person with a form.' },
  outcomes: { summary: 'How a run ends: done, invalid input, failed, paused, cancelled, and undo.', when: 'Pick this when you decide what a fn returns on success or failure.' },
  'kinds-agents': { summary: 'Kinds that make fns from a payload, and agents that are a prompt with tools.', when: 'Pick this when you write a kind or an agent.' },
  'settings-attachments': { summary: 'Settings people set, and attachments a run adds.', when: 'Pick this when the system has a setting or attaches data to a run.' },
  context: { summary: 'Context items and /commands, static or dynamic, and the context/ folder.', when: 'Pick this when the system offers context or a command.' },
  hooks: { summary: 'Hooks that add information to a user message.', when: 'Pick this when the system adds to messages before the model sees them.' },
  mentions: { summary: '@ mentions: search, hover cards and the text the model gets.', when: 'Pick this when people should @ mention the system\'s things.' },
  actions: { summary: 'Actions: stored buttons that call the system later.', when: 'Pick this when a message offers a button that calls the system.' },
  providers: { summary: 'Model providers a system can add to the hub.', when: 'Pick this when the system serves a model.' },
  resources: { summary: 'Resources, embedders and sectioners a system serves.', when: 'Pick this when the system serves files or documents as resources.' },
  hub: { summary: 'The hub contract: the hub fns a system can call and what each does.', when: 'Pick this when the system calls hub fns.' },
  server: { summary: 'serve() and the implementation object the contract types.', when: 'Pick this when you write server/impl.ts or server/main.ts.' },
  ctx: { summary: 'The run context: logging, models, files, resources, state and calls.', when: 'Pick this when a fn needs ctx (models, files, state, the hub).' },
  calling: { summary: 'Calling other fns from a run, with deps and handlers.', when: 'Pick this when a fn calls another system\'s fn.' },
  lifecycle: { summary: 'Config, events, the lifecycle hooks and the data folders.', when: 'Pick this when the system has config, reacts to events or keeps data.' },
  client: { summary: 'Vue renderers, inputs and resource views, typed by the contract.', when: 'Pick this when you write client/ components.' },
  packaging: { summary: 'system.json, building, packing and installing, from the chat with fs/install_system or the CLI.', when: 'Pick this when you build or install a system.' },
  testing: { summary: 'Testing a system against a fake hub, and the live tests.', when: 'Pick this when you write or run the system\'s tests.' },
  mistakes: { summary: 'The mistakes the compiler refuses, each with its fix.', when: 'Pick this when the typecheck fails and the error is unclear.' },
  examples: { summary: 'Complete compiled example systems to copy from.', when: 'Pick this to copy a whole working system.' },
  internals: { summary: 'How the runtime works inside: the link, runs and replays.', when: 'Pick this only to debug the SDK itself.' },
  'core-types': { summary: 'Every core type the SDK refers to, with its fields.', when: 'Pick this to look up one core type by name.' },
};
