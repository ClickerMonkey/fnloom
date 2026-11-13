/**
 * The claude system's contract (`shared/`): a fleet of Claude Code sessions on one machine per instance, driven with
 * the Claude Agent SDK (build-9-design.md §6 is binding; the shared shapes are `@harness/core`'s `claude.ts`).
 *
 * - **Sessions:** `start_session` starts one in a configured folder, `send` messages it (resuming a closed one),
 *   `control` interrupts or stops it and switches its permission mode, `transcript` reads it a page at a time from
 *   Claude's own store. Each live session is a `claude/Session` record of its person, so the fleet is listed and
 *   searched with `hub/records_*`; `disk_sessions` lists every session in Claude's store.
 * - **Needs attention:** a tool Claude wants to use is a proposed run of `permit`, a question Claude (or an MCP server
 *   through it) asks is a proposed run of `answer` with a form; both wait for the session's person in the inbox and in
 *   the chat the session started from. Neither is ever called by the model.
 * - **Tasks and workflows** are kept on the record (`ClaudeSession.tasks`) and reported as a waiting run's progress.
 * - **Imports:** `importables` lists Claude's agents, skills and MCP servers in a folder; `import` (an admin's
 *   approval) makes skills context with their `/command`, agents `claude/agent` fns, and MCP servers `mcp` instances.
 */
import {
  CLAUDE_CONFIG_SECRETS, CLAUDE_SYSTEM, ClaudeAnswer, ClaudeControl, ClaudeImport, ClaudeInstanceConfig, ClaudePermit, ClaudeSession, ClaudeSend, ClaudeStart,
  ClaudeTranscriptPage, ClaudeTranscriptQuery, ClaudeTurn,
} from '@harness/core';
import { context, fn, ginAs, hub, kind, linear, system, type } from '@harness/sdk';
import {
  AgentPayload, AnswerOutcome, ControlOutcome, DiskSessionsPage, DiskSessionsQuery, ImportOutcome, ImportablesList, ImportablesQuery, ImportedSkill, PermitOutcome,
} from './shapes.ts';

export * from './shapes.ts';

/** The kind of an imported Claude agent's fn, qualified. */
export const AGENT_KIND = `${CLAUDE_SYSTEM}/agent`;

/** An example session id, as the examples write it. */
const SESSION = '0b7c3c56-2f7e-4d2a-9d55-5c1f0f4e8a21';

const status = (active: string, done: string, failed: string) => ({
  active: { one: active, many: active },
  retry: { one: `${active} (again)`, many: `${active} (again)` },
  done: { one: done, many: done },
  failed: { one: failed, many: failed },
});

/** A live (or once live) session, mirrored as its person's record: the fleet is listed and searched in the hub. */
export const Session = type({
  description: 'A Claude Code session the harness runs: its folder, status, owner, open approvals and questions, tasks and workflows, and the last thing Claude said.',
  shape: ginAs(ClaudeSession),
  display: { label: 'Claude session', plural: 'Claude sessions', icon: 'terminal', title: 'title', subtitle: 'folder' },
  records: { shape: 'table', owner: 'person', search: { text: ['title', 'folder', 'lastText'], embed: false } },
});
/** An imported skill, kept so it is declared as context again after a restart. */
export const Skill = type({
  description: 'A Claude skill imported as harness context, kept so it is offered again after a restart.',
  shape: ginAs(ImportedSkill),
  display: { label: 'Claude skill', plural: 'Claude skills', icon: 'book', title: 'name', subtitle: 'description' },
  records: { shape: 'table', owner: 'shared', search: { text: ['name', 'description'], embed: false } },
});

/** The claude system's contract. */
export const claude = system(CLAUDE_SYSTEM, {
  description: 'A fleet of Claude Code sessions: start them in folders, message them, answer what they ask, follow their tasks and workflows, and import Claude\'s agents, skills and MCP servers.',
  groups: [
    { name: 'sessions', title: 'Sessions', description: 'Start, message, interrupt and stop Claude Code sessions, and read their transcripts.' },
    { name: 'attention', title: 'Needs attention', description: 'The approvals and questions Claude waits on, answered by the session\'s person; never called by the model.' },
    { name: 'imports', title: 'Imports', description: 'Claude\'s agents, skills and MCP servers, made harness fns, context and MCP servers.' },
  ],
  configSecrets: [...CLAUDE_CONFIG_SECRETS],
  // sessions are person-owned records; approvals and questions are proposed runs; agents are saved as fns
  grants: { hub: ['data', 'approvals', 'fns'], calls: ['hub/save_fn', 'hub/add_instance', 'hub/system_get'] },
})
  .with({
    config: ginAs(ClaudeInstanceConfig),
    types: {
      Session,
      Skill,
    },
    kinds: {
      agent: kind({
        description: 'An imported Claude agent: running it starts a Claude Code session as that agent with the task as its first message.',
        applicability: 'A Claude subagent definition (a code reviewer, a test writer) the harness should be able to hand work to, imported by claude/import.',
        payload: ginAs(AgentPayload),
        // starting a session is a write on the machine: every run asks unless a policy allows it
        approveChanges: false,
        status: status('Starting {fn}…', 'Ran {fn}', '{fn} failed'),
      }),
    },
    fns: {
      start_session: fn({
        group: 'sessions',
        description: 'Start a Claude Code session in a folder with a first message; it keeps working on its own and asks the person when it needs approval or an answer.',
        instructions: 'Use it to hand a coding task to Claude Code. `folder` must be under one of the instance\'s folders. Leave `wait` off for long work: the session shows in the fleet and reports its tasks; set it to have this run wait for the first turn\'s answer.',
        args: ginAs(ClaudeStart),
        returns: ginAs(ClaudeTurn),
        progress: linear,
        examples: [
          { args: { folder: 'C:/code/shop', prompt: 'Fix the failing checkout test and explain the cause.', wait: false }, result: { instance: 'main', session: SESSION, status: 'working' } },
          { args: { folder: 'C:/code/shop', prompt: 'List the scripts in package.json.', permissionMode: 'plan', wait: true }, note: 'A short question answered in this run.' },
        ],
        status: status('Starting a Claude session…', 'Started a Claude session', 'Starting a Claude session failed'),
        effects: { mode: 'write' },
        tags: ['claude', 'write'],
      }),
      send: fn({
        group: 'sessions',
        description: 'Send a message to a Claude Code session (a closed one is resumed first).',
        instructions: 'Use it to answer, redirect or continue a session the person names. With `wait` this run follows the turn (its tool uses and tasks as progress) and answers with Claude\'s reply.',
        args: ginAs(ClaudeSend),
        returns: ginAs(ClaudeTurn),
        progress: linear,
        examples: [{ args: { instance: 'main', session: SESSION, text: 'Also add a test for the empty cart.', wait: false }, result: { instance: 'main', session: SESSION, status: 'working' } }],
        status: status('Messaging Claude…', 'Messaged Claude', 'Messaging Claude failed'),
        effects: { mode: 'write' },
        tags: ['claude', 'write'],
      }),
      control: fn({
        group: 'sessions',
        description: 'Interrupt a Claude Code session\'s current turn, or stop the session (it stays resumable); `mode` also switches its permission mode.',
        instructions: 'Use `interrupt` when the person wants Claude to stop what it is doing now and wait; `stop` when they are done with the session.',
        args: ginAs(ClaudeControl),
        returns: ginAs(ControlOutcome),
        examples: [{ args: { instance: 'main', session: SESSION, action: 'interrupt' }, result: { instance: 'main', session: SESSION, status: 'idle' } }],
        status: status('Controlling a Claude session…', 'Done', 'Controlling the session failed'),
        effects: { mode: 'write', free: true },
        tags: ['claude', 'write'],
      }),
      transcript: fn({
        group: 'sessions',
        description: 'Read a page of a Claude Code session\'s transcript (or one subagent\'s): what was said, thought, the tool uses and their results.',
        instructions: 'Page with `offset` set to `next`. Name a task id as `agent` for a subagent\'s own transcript.',
        args: ginAs(ClaudeTranscriptQuery),
        returns: ginAs(ClaudeTranscriptPage),
        examples: [{ args: { instance: 'main', session: SESSION, offset: 0, limit: 20 } }],
        effects: { mode: 'read', free: true },
        tags: ['claude', 'read'],
      }),
      disk_sessions: fn({
        group: 'sessions',
        description: 'Every Claude Code session in Claude\'s own store on this machine (also ones the harness did not start), newest first, a page at a time.',
        instructions: 'Admins only: the store holds every session on the machine. Resume one with claude/send.',
        args: ginAs(DiskSessionsQuery),
        returns: ginAs(DiskSessionsPage),
        examples: [{ args: { folder: 'C:/code/shop', offset: 0, limit: 10 } }],
        effects: { mode: 'read', free: true },
        tags: ['claude', 'read'],
      }),
      permit: fn({
        group: 'attention',
        description: 'Let Claude use a tool it waits on (the person\'s approval of the proposed run); a decline denies it with the reason.',
        instructions: 'Proposed by the system for the session\'s person; the model never calls it.',
        args: ginAs(ClaudePermit),
        returns: ginAs(PermitOutcome),
        examples: [{ args: { instance: 'main', session: SESSION, request: 'req_1', tool: 'Bash', input: { command: 'npm test' }, always: false } }],
        visibility: 'none',
        display: 'hidden',
        status: status('Allowing {args.tool}…', 'Allowed {args.tool}', 'Allowing {args.tool} failed'),
        effects: { mode: 'write', free: true },
        tags: ['claude'],
      }),
      answer: fn({
        group: 'attention',
        description: 'Give Claude the person\'s answer to a question it waits on (the form on the proposed run); a decline tells Claude the person did not answer.',
        instructions: 'Proposed by the system for the session\'s person; the model never calls it.',
        args: ginAs(ClaudeAnswer),
        returns: ginAs(AnswerOutcome),
        examples: [{ args: { instance: 'main', session: SESSION, request: 'req_2', from: 'question', answer: { q1: 'Postgres' } } }],
        visibility: 'none',
        display: 'hidden',
        status: status('Answering Claude…', 'Answered Claude', 'Answering Claude failed'),
        effects: { mode: 'write', free: true },
        tags: ['claude'],
      }),
      importables: fn({
        group: 'imports',
        description: 'The agents, skills and MCP servers Claude sees in a folder (user, project and plugin scope), and whether each is imported.',
        instructions: 'Use it before claude/import to see what there is. `folder` must be under one of the instance\'s folders.',
        args: ginAs(ImportablesQuery),
        returns: ginAs(ImportablesList),
        // the mcp system's instances say which MCP servers are imported already
        deps: { system: hub.fns.system_get },
        examples: [{ args: { folder: 'C:/code/shop' } }],
        effects: { mode: 'read', free: true },
        tags: ['claude', 'read'],
      }),
      import: fn({
        group: 'imports',
        description: 'Import some of Claude\'s agents, skills and MCP servers: skills become context with a /command, agents claude/agent fns, MCP servers mcp instances. An admin approves it.',
        instructions: 'Name each item as claude/importables lists it (its kind, name and folder).',
        args: ginAs(ClaudeImport),
        returns: ginAs(ImportOutcome),
        deps: { saveFn: hub.fns.save_fn, addInstance: hub.fns.add_instance },
        examples: [{ args: { items: [{ kind: 'skill', name: 'release-notes', folder: 'C:/code/shop' }, { kind: 'agent', name: 'code-reviewer' }] } }],
        approval: { preview: false, remember: false, approver: 'admins' },
        status: status('Importing from Claude…', 'Imported from Claude', 'Importing from Claude failed'),
        effects: { mode: 'write', free: true, registry: [{ thing: 'fns', action: 'create', kind: AGENT_KIND }, { thing: 'context', action: 'create' }, { thing: 'fns', action: 'create' }] },
        tags: ['claude', 'write'],
      }),
    },
  })
  .with(({ fns }) => ({
    context: {
      guide: context({
        description: 'How to work with the Claude Code sessions the harness runs.',
        content: [
          'Claude Code sessions run on a machine (an instance of the claude system) in configured folders; the person\'s sessions are claude/Session records, listed with hub/records_find.',
          'Start one with claude/start_session and message it with claude/send. Claude works on its own: the tools it wants and the questions it asks come to the person as approval cards; never answer them yourself.',
          'Read what a session did with claude/transcript; interrupt or stop it with claude/control.',
        ].join(' '),
        fns: [fns.start_session, fns.send, fns.control, fns.transcript],
        tags: ['claude'],
      }),
    },
  }));

/** The claude contract's type. */
export type ClaudeContract = typeof claude;
