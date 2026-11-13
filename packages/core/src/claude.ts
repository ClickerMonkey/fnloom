/**
 * Build 9: the `claude` system manages a fleet of Claude Code sessions with the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`). One instance per machine; its config names the folders sessions may start in.
 *
 * - **Sessions** the system starts are live in its process (the SDK's `query`): it sends messages, interrupts and
 *   stops them. Each live session is mirrored as a hub record of type `claude/Session` (`ClaudeSession`, owned by the
 *   person who started it), so the fleet is listed and searched in the hub's database. Transcripts stay in Claude's own
 *   store and are read a page at a time (`ClaudeTranscriptPage`). Sessions on disk that the system did not start are
 *   listed from Claude's store (`claude/disk_sessions`) and can be resumed, which makes them live.
 * - **Needs attention:** a tool Claude wants to use (the SDK's `canUseTool`) is a proposed run of `claude/permit`
 *   waiting for the session's person: the approval card in the chat and the inbox. A question (`AskUserQuestion`, an
 *   MCP elicitation, a user dialog) is a proposed run of `claude/answer` whose card carries a form (`ProposeRun.ask`).
 *   Approving resolves the waiting callback; declining (the run settles `cancelled`) denies it with the reason.
 * - **Tasks and workflows:** the SDK's `task_*` messages (subagents, shells, monitors, workflows) are kept on the
 *   session record as `ClaudeTask`s, and a `claude/send` run reports them as its progress.
 * - **Imports:** Claude's agents, skills and MCP servers (user, project and plugin scope) are listed by
 *   `claude/importables`; importing a skill makes a context item (with its `/command`), an agent a fn that runs a
 *   session with that agent, and an MCP server an `mcp` instance (`McpServerConfig`).
 */
import { z } from 'zod';
import { ActorId, InstanceName, Json, RunId, SessionId, Timestamp } from './primitives.ts';
import type { ConfigPath } from './config-secrets.ts';

/** The bundled system that runs Claude Code sessions. */
export const CLAUDE_SYSTEM = 'claude';
/** The hub record type a live session is mirrored as. */
export const CLAUDE_SESSION_TYPE = 'claude/Session';

/** Claude's own session id (a UUID). */
export const ClaudeSessionId = z.uuid();
export type ClaudeSessionId = z.infer<typeof ClaudeSessionId>;

/** A session on one machine. */
export const ClaudeSessionRef = z.object({ instance: InstanceName, session: ClaudeSessionId });
export type ClaudeSessionRef = z.infer<typeof ClaudeSessionRef>;

/**
 * The permission modes the harness may start or switch a session to (the SDK's `PermissionMode`, without
 * `bypassPermissions`: every tool Claude's settings don't allow comes to a person).
 */
export const ClaudePermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']);
export type ClaudePermissionMode = z.infer<typeof ClaudePermissionMode>;

/** A folder sessions may start in. */
export const ClaudeFolder = z.object({ path: z.string().min(1), label: z.string().min(1).optional() });
export type ClaudeFolder = z.infer<typeof ClaudeFolder>;

/** A `claude` instance's config. */
export const ClaudeInstanceConfig = z.object({
  /** Where sessions may start (each under one of these). */
  folders: z.array(ClaudeFolder).min(1),
  /** The model a new session uses when none is named; absent, Claude's own default. */
  model: z.string().min(1).optional(),
  permissionMode: ClaudePermissionMode.default('default'),
  /** Live sessions at once on this machine. */
  maxLive: z.number().int().min(1).max(64).default(8),
  /** A live session with nothing to do is closed (it stays resumable) after this long, in milliseconds. */
  idleClose: z.number().int().min(60_000).default(3_600_000),
  /**
   * A hub MCP (its URL and secret, a config secret) given to every session as the `harness` MCP server, so Claude can
   * call the fns that MCP's rules expose; each call is a hub run with its approvals.
   */
  hubMcp: z.object({ url: z.url(), secret: z.string().min(1) }).optional(),
});
export type ClaudeInstanceConfig = z.infer<typeof ClaudeInstanceConfig>;

/** The secret config paths of a `claude` instance. */
export const CLAUDE_CONFIG_SECRETS = ['hubMcp.secret'] as const satisfies readonly ConfigPath[];

/**
 * Where a session is. `working`: on a turn. `waiting`: blocked on a person (an approval or a question). `idle`: live,
 * between turns. `closed`: not live (resumable). `failed`: it ended with an error.
 */
export const ClaudeSessionStatus = z.enum(['starting', 'working', 'waiting', 'idle', 'closed', 'failed']);
export type ClaudeSessionStatus = z.infer<typeof ClaudeSessionStatus>;

/** What a task is (the SDK's task types). */
export const ClaudeTaskKind = z.enum(['agent', 'shell', 'workflow', 'monitor', 'other']);
export type ClaudeTaskKind = z.infer<typeof ClaudeTaskKind>;

/** One task of a session: a subagent, a background shell, a monitor or a workflow, with its progress. */
export const ClaudeTask = z.object({
  id: z.string().min(1),
  kind: ClaudeTaskKind,
  /** A workflow's name, a subagent's type. */
  name: z.string().optional(),
  description: z.string(),
  status: z.enum(['running', 'done', 'failed', 'stopped']),
  /** The latest progress line. */
  progress: z.string().optional(),
  /** The task that started it, for nesting. */
  parent: z.string().optional(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
});
export type ClaudeTask = z.infer<typeof ClaudeTask>;

/** A session as the hub keeps it (the value of a `claude/Session` record). */
export const ClaudeSession = z.object({
  instance: InstanceName,
  session: ClaudeSessionId,
  folder: z.string().min(1),
  title: z.string(),
  status: ClaudeSessionStatus,
  /** Who started (or resumed) it: approvals and questions wait for them. */
  owner: ActorId,
  /** The harness chat it was started from, where its cards also show. */
  chat: SessionId.optional(),
  model: z.string().optional(),
  permissionMode: ClaudePermissionMode,
  /** A subagent definition it runs as (an imported Claude agent). */
  agent: z.string().optional(),
  /** Open approvals and questions (the waiting runs). */
  waiting: z.array(RunId),
  /**
   * The keys of the proposals open for this session (the claude system's own bookkeeping). The hub accepts a proposal
   * `for` the owner by its key, which must start with this record's id (`proposalKeyFor(record.id, request)`), not by this list.
   */
  asking: z.array(z.string().min(1)),
  tasks: z.array(ClaudeTask),
  /** The last thing Claude said, one line. */
  lastText: z.string().optional(),
  turns: z.number().int().min(0),
  costUsd: z.number().min(0),
  startedAt: Timestamp,
  updatedAt: Timestamp,
  problem: z.string().optional(),
});
export type ClaudeSession = z.infer<typeof ClaudeSession>;

/** One entry of a transcript page. */
export const ClaudeTranscriptItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), uuid: z.string(), text: z.string() }),
  z.object({ type: z.literal('assistant'), uuid: z.string(), text: z.string() }),
  z.object({ type: z.literal('thinking'), uuid: z.string(), text: z.string() }),
  z.object({ type: z.literal('tool-use'), uuid: z.string(), id: z.string(), tool: z.string(), input: Json }),
  z.object({ type: z.literal('tool-result'), uuid: z.string(), id: z.string(), ok: z.boolean(), text: z.string() }),
  z.object({ type: z.literal('system'), uuid: z.string(), text: z.string() }),
]);
export type ClaudeTranscriptItem = z.infer<typeof ClaudeTranscriptItem>;

/**
 * Read a transcript a page at a time (`claude/transcript`). `offset` and `limit` count Claude's stored messages (one
 * message can make several items): from the start, or with `fromEnd` back from the newest, so the latest page reads first.
 */
export const ClaudeTranscriptQuery = ClaudeSessionRef.extend({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(50),
  fromEnd: z.boolean().default(false),
  /** A subagent's own transcript (a task id), instead of the main one. */
  agent: z.string().optional(),
});
export type ClaudeTranscriptQuery = z.infer<typeof ClaudeTranscriptQuery>;

/**
 * A page of a transcript, its items in order. `offset` (its first message) and `end` (just past its last) count from the
 * start, whichever way it was asked for: an earlier page ends at `offset`, and a later one starts at `end`. `next` is
 * that later page's offset, absent at the end.
 */
export const ClaudeTranscriptPage = z.object({
  items: z.array(ClaudeTranscriptItem), offset: z.number().int().min(0), end: z.number().int().min(0), next: z.number().int().min(0).optional(),
});
export type ClaudeTranscriptPage = z.infer<typeof ClaudeTranscriptPage>;

/** Start a session (`claude/start_session`): a write on the machine, so it waits for approval unless a policy allows it. */
export const ClaudeStart = z.object({
  /** A folder under one of the instance's `folders`. */
  folder: z.string().min(1),
  prompt: z.string().min(1),
  title: z.string().optional(),
  model: z.string().optional(),
  permissionMode: ClaudePermissionMode.optional(),
  /** An imported Claude agent to run as. */
  agent: z.string().optional(),
  /** Wait for the first turn to finish (its run reports progress), or answer once the session is live. */
  wait: z.boolean().default(false),
});
export type ClaudeStart = z.infer<typeof ClaudeStart>;

/** Send a message to a session (`claude/send`); resumes a closed one first. */
export const ClaudeSend = ClaudeSessionRef.extend({ text: z.string().min(1), wait: z.boolean().default(false) });
export type ClaudeSend = z.infer<typeof ClaudeSend>;

/** What a start or send answers: the session, and the turn's outcome when it waited. */
export const ClaudeTurn = ClaudeSessionRef.extend({
  status: ClaudeSessionStatus,
  /** The turn's final text, when it waited. */
  text: z.string().optional(),
  costUsd: z.number().min(0).optional(),
});
export type ClaudeTurn = z.infer<typeof ClaudeTurn>;

/**
 * Interrupt the current turn, stop the session (it closes and stays resumable), or (`mode`) only switch its permission
 * mode, leaving the turn running. `mode` is the new permission mode: needed with `mode`, switched first with the others.
 */
export const ClaudeControl = ClaudeSessionRef.extend({ action: z.enum(['interrupt', 'stop', 'mode']), mode: ClaudePermissionMode.optional() });
export type ClaudeControl = z.infer<typeof ClaudeControl>;

/**
 * The args of a proposed `claude/permit` run: one tool use Claude waits on. Approved, Claude may use it (`always`
 * adds the SDK's suggested rule for the rest of the session); declined, it is denied with the reason.
 */
export const ClaudePermit = ClaudeSessionRef.extend({
  /** The SDK's tool use id. */
  request: z.string().min(1),
  tool: z.string().min(1),
  input: Json,
  always: z.boolean().default(false),
});
export type ClaudePermit = z.infer<typeof ClaudePermit>;

/** The args of a proposed `claude/answer` run: a question Claude waits on, and the person's answer (the card's form). */
export const ClaudeAnswer = ClaudeSessionRef.extend({
  request: z.string().min(1),
  /** Where it came from: the `AskUserQuestion` tool, an MCP server's elicitation, or a dialog. */
  from: z.enum(['question', 'elicitation', 'dialog']),
  answer: Json,
});
export type ClaudeAnswer = z.infer<typeof ClaudeAnswer>;

/**
 * An MCP server Claude has configured, as a list shows it: how it is reached and the names of the secrets it signs in
 * with, never their values (those stay on the machine until an import hands them to the hub, which seals them).
 */
export const ClaudeMcpServerSummary = z.object({
  transport: z.enum(['stdio', 'http', 'sse']),
  /** The command it starts (without its args, which may hold credentials), or its URL without the query. */
  where: z.string(),
  /** The environment values (stdio) or headers (http, sse) it signs in with, by name. */
  secrets: z.array(z.string()),
});
export type ClaudeMcpServerSummary = z.infer<typeof ClaudeMcpServerSummary>;

/** A thing on the machine that can be imported. */
export const ClaudeImportable = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), name: z.string(), description: z.string(), scope: z.enum(['user', 'project', 'plugin']), folder: z.string().optional(), imported: z.boolean() }),
  z.object({ kind: z.literal('skill'), name: z.string(), description: z.string(), scope: z.enum(['user', 'project', 'plugin']), folder: z.string().optional(), imported: z.boolean() }),
  z.object({ kind: z.literal('mcp-server'), name: z.string(), description: z.string(), scope: z.enum(['user', 'project', 'local', 'plugin']), folder: z.string().optional(), imported: z.boolean(), server: ClaudeMcpServerSummary }),
]);
export type ClaudeImportable = z.infer<typeof ClaudeImportable>;

/** Import some of them (`claude/import`): skills become context, agents fns, MCP servers `mcp` instances. */
export const ClaudeImport = z.object({
  items: z.array(z.object({ kind: z.enum(['agent', 'skill', 'mcp-server']), name: z.string(), folder: z.string().optional() })).min(1),
});
export type ClaudeImport = z.infer<typeof ClaudeImport>;
