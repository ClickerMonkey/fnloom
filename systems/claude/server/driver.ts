/**
 * The seam between the claude system and Claude Code. `ClaudeDriver` starts and resumes live sessions and reads
 * Claude's own store; `AgentSdkDriver` (`agent-sdk.ts`) is the real one over the Claude Agent SDK, `FakeClaudeDriver`
 * (`fake-driver.ts`) the scripted one every test uses. What a live session reports comes back as `DriverEvent`s and
 * the three requests a person answers (`PermitRequest`, `QuestionRequest`), already in the harness's words, so the
 * fleet never sees an SDK message.
 */
import type { ClaudeImportable, ClaudePermissionMode, McpServerConfig, ClaudeSessionId, ClaudeTask, ClaudeTranscriptItem, GinTypeDef, Json, JsonObject } from '@harness/core';

/** How to open a live session: a new one (with its id minted by the fleet) or one resumed from Claude's store. */
export interface DriverOpen {
  readonly session: ClaudeSessionId;
  readonly resume: boolean;
  readonly folder: string;
  readonly model?: string | undefined;
  readonly permissionMode: ClaudePermissionMode;
  /** An imported Claude agent the main thread runs as. */
  readonly agent?: string | undefined;
  /** The hub MCP every session gets as the `harness` server. */
  readonly hubMcp?: { readonly url: string; readonly secret: string } | undefined;
}

/** A change to one of the session's tasks: the fields it reports, the rest kept. */
export type TaskChange = Pick<ClaudeTask, 'id'> & Partial<Omit<ClaudeTask, 'id' | 'startedAt' | 'updatedAt'>>;

/** What a live session reports, in the harness's words. */
export type DriverEvent =
  /** Claude said something (a whole assistant text block). */
  | { readonly type: 'text'; readonly text: string }
  /** Claude used a tool (one line: the tool and what it was given). */
  | { readonly type: 'tool'; readonly tool: string; readonly line: string }
  /** A subagent, shell, monitor or workflow started, moved on or ended. */
  | { readonly type: 'task'; readonly change: TaskChange }
  /** A turn ended: Claude's final text, whether it failed, its cost so far and the turns taken. */
  | { readonly type: 'result'; readonly ok: boolean; readonly text: string; readonly costUsd: number; readonly turns: number }
  /** The session's process ended (closed, or failed with `problem`). */
  | { readonly type: 'ended'; readonly problem?: string | undefined };

/** A tool use Claude waits on. */
export interface PermitRequest {
  readonly tool: string;
  readonly input: JsonObject;
  /** Why Claude asks, in its words, when it says. */
  readonly reason?: string | undefined;
  /** Whether "always allow" can be offered (Claude suggested a rule for the rest of the session). */
  readonly canAlways: boolean;
}

/** The person's decision on a tool use. */
export type PermitDecision = { readonly allow: true; readonly always: boolean } | { readonly allow: false; readonly reason: string };

/** A question Claude waits on: what it asks, and the form whose value answers it. */
export interface QuestionRequest {
  readonly from: 'question' | 'elicitation' | 'dialog';
  /** One line for the card's title. */
  readonly title: string;
  /** The question in full, in markdown. */
  readonly text: string;
  /** The form the person fills (a gin type); absent when approving is the whole answer (an MCP sign-in link). */
  readonly form?: GinTypeDef | undefined;
}

/** The person's answer: the form's value, or that they declined (with why). */
export type QuestionReply = { readonly answer: Json } | { readonly declined: string };

/** What a live session asks of the fleet. Each request waits until the fleet answers it or `signal` aborts it. */
export interface SessionListener {
  event(event: DriverEvent): void;
  permit(request: PermitRequest, signal: AbortSignal): Promise<PermitDecision>;
  question(request: QuestionRequest, signal: AbortSignal): Promise<QuestionReply>;
}

/** A live session. */
export interface LiveSession {
  /** Queue a user message; Claude takes it when the current turn ends. */
  send(text: string): void;
  /** Stop the current turn; the session stays live. */
  interrupt(): Promise<void>;
  setMode(mode: ClaudePermissionMode): Promise<void>;
  /** End the process; Claude's store keeps the session for a resume. */
  close(): void;
}

/** One session in Claude's store. */
export interface StoredSession {
  readonly session: ClaudeSessionId;
  readonly folder?: string | undefined;
  readonly title: string;
  readonly updatedAt: number;
  readonly branch?: string | undefined;
}

/** A page of something with whether more follows. */
export interface DriverPage<T> {
  readonly items: readonly T[];
  readonly more: boolean;
}

/** A transcript page asked of the driver: `offset` and `limit` count stored messages, from the start or (`fromEnd`) back from the newest. */
export interface TranscriptRequest {
  readonly session: ClaudeSessionId;
  readonly folder?: string | undefined;
  readonly agent?: string | undefined;
  readonly offset: number;
  readonly limit: number;
  readonly fromEnd: boolean;
}

/** A transcript page: its items, its first message and the one past its last (from the start), and `more` when later ones follow. */
export interface TranscriptSlice {
  readonly items: readonly ClaudeTranscriptItem[];
  readonly offset: number;
  readonly end: number;
  readonly more: boolean;
}

/**
 * The messages of one page out of `count` stored ones, as start (inclusive) and end (exclusive) from the start:
 * `offset` counts from the start, or with `fromEnd` back from the newest.
 */
export function sliceOf(count: number, request: Pick<TranscriptRequest, 'offset' | 'limit' | 'fromEnd'>): { readonly start: number; readonly end: number } {
  if (!request.fromEnd) { return { start: Math.min(request.offset, count), end: Math.min(request.offset + request.limit, count) }; }
  const end = Math.max(0, count - request.offset);
  return { start: Math.max(0, end - request.limit), end };
}

/** An importable as a list shows it, before the harness says whether it has imported it. */
type Unmarked<I> = I extends { imported: boolean } ? Omit<I, 'imported'> : never;

/**
 * What Claude sees in a folder that can be imported, before the harness says what it has imported. An MCP server
 * carries its whole config here (secrets included, for `import` to hand to the hub); lists show only its summary.
 */
export type FoundImportable =
  | Unmarked<Exclude<ClaudeImportable, { kind: 'mcp-server' }>>
  | (Omit<Unmarked<Extract<ClaudeImportable, { kind: 'mcp-server' }>>, 'server'> & { readonly server: McpServerConfig });

/** Claude Code on one machine. */
export interface ClaudeDriver {
  /** Start or resume a live session; it reports to `listener` until it ends. */
  open(open: DriverOpen, listener: SessionListener): LiveSession;
  /** A page of Claude's store, newest first (one folder's, or every folder's). */
  sessions(query: { readonly folder?: string | undefined; readonly offset: number; readonly limit: number }): Promise<DriverPage<StoredSession>>;
  /** One session in the store, or `undefined`. */
  session(session: ClaudeSessionId): Promise<StoredSession | undefined>;
  /** A page of a session's transcript (or of one subagent's), counted in stored messages from the start or (`fromEnd`) the newest. */
  transcript(query: TranscriptRequest): Promise<TranscriptSlice>;
  /** The agents, skills and MCP servers Claude sees in a folder. */
  importables(folder: string): Promise<FoundImportable[]>;
  /** A skill's instructions (its `SKILL.md` body), or `undefined` when it has no file to read (a plugin's). */
  skillText(name: string, folder: string): Promise<string | undefined>;
}
