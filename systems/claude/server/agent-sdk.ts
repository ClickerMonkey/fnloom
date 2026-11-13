/**
 * The real driver: Claude Code through the Claude Agent SDK. A live session is one `query()` with streaming input (a
 * queue the fleet pushes messages into), so it takes messages, interrupts and mode switches while it runs. The SDK's
 * callbacks become the fleet's requests: `canUseTool` (the `AskUserQuestion` tool is a question, every other tool a
 * permit), `onElicitation` (an MCP server's form or sign-in link) and `onUserDialog` (only the kinds the settings name;
 * any other is answered `cancelled`). Its messages become `DriverEvent`s. Transcripts and the session list are read a
 * page at a time from Claude's own store; importables come from a session opened only to ask what it sees.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, query,
  type CanUseTool, type McpServerStatus, type OnElicitation, type OnUserDialog, type Options, type PermissionResult, type Query, type SDKMessage, type SDKSessionInfo, type SDKUserMessage, type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSessionId, McpServerConfig, isJsonObject, jsonOf, type ClaudeTask, type ClaudeTaskKind, type ClaudeTranscriptItem, type JsonObject } from '@harness/core';
import { g, wireType } from '@harness/sdk';
import { sliceOf, type ClaudeDriver, type DriverEvent, type DriverOpen, type DriverPage, type FoundImportable, type LiveSession, type SessionListener, type StoredSession, type TaskChange, type TranscriptRequest, type TranscriptSlice } from './driver.ts';
import { AskUserQuestionInput, askUserQuestionForm, elicitationForm } from './questions.ts';
import { itemsOf, toolLine } from './transcript.ts';

/** The driver's tunables. */
export interface AgentSdkOptions {
  /** The Claude Code executable; absent, the SDK's bundled one. */
  readonly executable?: string | undefined;
  /** The dialog kinds answered with a form. */
  readonly dialogKinds: readonly string[];
  /** The longest text a transcript item carries. */
  readonly textMax: number;
  /** The environment Claude Code runs with (`sessionEnv`): never all of this process's, which holds the harness's keys. */
  readonly env: Readonly<Record<string, string>>;
}

/** A queue of user messages the SDK reads as its streaming input; `end` finishes it. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #items: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #ended = false;

  push(text: string): void {
    this.#items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) { yield next; continue; }
      if (this.#ended) { return; }
      await new Promise<void>((resolve) => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}

/** A task type the SDK names, as the harness's kind. */
function taskKind(type: string | undefined, subagent: string | undefined): ClaudeTaskKind {
  const t = type ?? '';
  if (t.includes('workflow')) { return 'workflow'; }
  if (t.includes('monitor')) { return 'monitor'; }
  if (t.includes('bash') || t.includes('shell')) { return 'shell'; }
  if (t.includes('agent') || subagent !== undefined) { return 'agent'; }
  return 'other';
}

/** A finished task's status, as the harness says it. */
function endedStatus(status: string): ClaudeTask['status'] {
  return status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'stopped' : 'running';
}

/** A task message as a change to one of the session's tasks; other system messages say nothing the fleet keeps. */
function taskChangeOf(message: Extract<SDKMessage, { type: 'system' }>): TaskChange | undefined {
  if (message.subtype === 'task_started') {
    const name = message.workflow_name ?? message.subagent_type;
    return {
      id: message.task_id, kind: taskKind(message.task_type, message.subagent_type), description: message.description, status: 'running',
      ...(name === undefined ? {} : { name }), ...(message.parent_task_id === undefined ? {} : { parent: message.parent_task_id }),
    };
  }
  if (message.subtype === 'task_progress') {
    return { id: message.task_id, description: message.description, progress: message.summary ?? (message.last_tool_name === undefined ? message.description : `${message.last_tool_name}…`) };
  }
  if (message.subtype === 'task_updated') {
    return {
      id: message.task_id,
      ...(message.patch.status === undefined ? {} : { status: endedStatus(message.patch.status) }),
      ...(message.patch.description === undefined ? {} : { description: message.patch.description }),
      ...(message.patch.error === undefined ? {} : { progress: message.patch.error }),
    };
  }
  if (message.subtype === 'task_notification') { return { id: message.task_id, status: endedStatus(message.status), progress: message.summary }; }
  return undefined;
}

/** An SDK message as the fleet's events (most messages say nothing the fleet keeps). */
export function eventsOf(message: SDKMessage): DriverEvent[] {
  if (message.type === 'assistant') {
    return message.message.content.flatMap((block): DriverEvent[] => {
      if (block.type === 'text' && message.parent_tool_use_id === null) { return [{ type: 'text', text: block.text }]; }
      if (block.type === 'tool_use') { return [{ type: 'tool', tool: block.name, line: toolLine(block.name, block.input) }]; }
      return [];
    });
  }
  if (message.type === 'result') {
    return [message.subtype === 'success'
      ? { type: 'result', ok: !message.is_error, text: message.result, costUsd: message.total_cost_usd, turns: message.num_turns }
      : { type: 'result', ok: false, text: message.errors.join('\n') || message.subtype, costUsd: message.total_cost_usd, turns: message.num_turns }];
  }
  if (message.type === 'system') {
    const change = taskChangeOf(message);
    return change === undefined ? [] : [{ type: 'task', change }];
  }
  return [];
}

/** A tool input as JSON (the SDK gives a plain object). */
function inputOf(input: Record<string, unknown>): JsonObject {
  const json = jsonOf(input);
  return isJsonObject(json) ? json : {};
}

/** The callbacks of one session, answering through the fleet's listener. */
function callbacks(listener: SessionListener, dialogKinds: readonly string[]): Pick<Options, 'canUseTool' | 'onElicitation' | 'onUserDialog' | 'supportedDialogKinds'> {
  const canUseTool: CanUseTool = async (tool, input, options): Promise<PermissionResult> => {
    const asked = tool === 'AskUserQuestion' ? AskUserQuestionInput.safeParse(input) : undefined;
    if (asked?.success === true) {
      const form = askUserQuestionForm(asked.data);
      const reply = await listener.question({ from: 'question', title: form.title, text: form.text, form: form.form }, options.signal);
      const answers = 'answer' in reply ? form.answer(reply.answer) : undefined;
      if (answers === undefined) { return { behavior: 'deny', message: 'declined' in reply ? `The person did not answer: ${reply.declined}` : 'The answer did not fit the question.' }; }
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    const suggestions = options.suggestions ?? [];
    const decision = await listener.permit({ tool, input: inputOf(input), reason: options.decisionReason, canAlways: suggestions.length > 0 }, options.signal);
    return decision.allow
      ? { behavior: 'allow', updatedInput: input, ...(decision.always ? { updatedPermissions: suggestions } : {}) }
      : { behavior: 'deny', message: decision.reason };
  };
  const onElicitation: OnElicitation = async (request, options) => {
    if (request.mode === 'url') {
      const text = `${request.message}\n\nOpen ${request.url ?? 'the link'} to continue, then approve.`;
      const reply = await listener.question({ from: 'elicitation', title: `${request.serverName} asks you to sign in`, text }, options.signal);
      return 'answer' in reply ? { action: 'accept' } : { action: 'decline' };
    }
    const form = elicitationForm(request.serverName, request.message, request.requestedSchema);
    const reply = await listener.question({ from: 'elicitation', title: form.title, text: form.text, form: form.form }, options.signal);
    const content = 'answer' in reply ? form.answer(reply.answer) : undefined;
    return content === undefined ? { action: 'decline' } : { action: 'accept', content };
  };
  const onUserDialog: OnUserDialog = async (request, options) => {
    if (!dialogKinds.includes(request.dialogKind)) { return { behavior: 'cancelled' }; }
    const reply = await listener.question({
      from: 'dialog', title: `Claude asks (${request.dialogKind})`, text: `\`\`\`json\n${JSON.stringify(request.payload, null, 2)}\n\`\`\``, form: wireType(g.any()),
    }, options.signal);
    return 'answer' in reply ? { behavior: 'completed', result: reply.answer } : { behavior: 'cancelled' };
  };
  return { canUseTool, onElicitation, ...(dialogKinds.length === 0 ? {} : { onUserDialog, supportedDialogKinds: [...dialogKinds] }) };
}

/** A stored session as the driver gives it; one with a malformed id is skipped. */
function storedOf(info: SDKSessionInfo): StoredSession[] {
  const id = ClaudeSessionId.safeParse(info.sessionId);
  if (!id.success) { return []; }
  return [{ session: id.data, folder: info.cwd, title: info.customTitle ?? info.summary, updatedAt: info.lastModified, branch: info.gitBranch }];
}

/** Where a file of a skill, command or agent is, project first, then the person's own. */
function found(folder: string, ...parts: string[]): { scope: 'project' | 'user'; path: string } | undefined {
  const project = join(folder, '.claude', ...parts);
  if (existsSync(project)) { return { scope: 'project', path: project }; }
  const user = join(homedir(), '.claude', ...parts);
  return existsSync(user) ? { scope: 'user', path: user } : undefined;
}

/** A Markdown file's body, without its YAML header. */
export function bodyOf(text: string): string {
  const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return (header === null ? text : text.slice(header[0].length)).trim();
}

/** An MCP server Claude has configured, as an `mcp` instance's config; `undefined` for one only Claude can reach. */
export function mcpConfigOf(status: McpServerStatus): McpServerConfig | undefined {
  const config = status.config;
  if (config === undefined) { return undefined; }
  if (config.type === undefined || config.type === 'stdio') {
    return McpServerConfig.parse({ label: status.name, transport: { type: 'stdio', command: config.command, args: config.args ?? [], ...(config.env === undefined ? {} : { env: config.env }) } });
  }
  if (config.type === 'http' || config.type === 'sse') {
    const headers = config.headers ?? {};
    const names = Object.keys(headers);
    return McpServerConfig.parse({
      label: status.name, transport: { type: config.type, url: config.url },
      auth: names.length === 0 ? { kind: 'none' } : { kind: 'headers', per: 'shared', names, values: headers },
    });
  }
  return undefined;
}

/** Claude's scope words, as an importable MCP server's. */
function mcpScope(scope: string | undefined): 'user' | 'project' | 'local' | 'plugin' {
  return scope === 'user' || scope === 'project' || scope === 'local' ? scope : 'plugin';
}

/** Claude Code through the Agent SDK. */
export class AgentSdkDriver implements ClaudeDriver {
  readonly #options: AgentSdkOptions;

  constructor(options: AgentSdkOptions) {
    this.#options = options;
  }

  #base(folder: string): Options {
    return {
      cwd: folder,
      // the SDK gives Claude Code all of process.env unless told: a session's Bash would see every key the harness holds
      env: { ...this.#options.env },
      settingSources: ['user', 'project', 'local'],
      ...(this.#options.executable === undefined ? {} : { pathToClaudeCodeExecutable: this.#options.executable }),
    };
  }

  open(open: DriverOpen, listener: SessionListener): LiveSession {
    const input = new InputQueue();
    const live: Query = query({
      prompt: input,
      options: {
        ...this.#base(open.folder),
        ...(open.resume ? { resume: open.session } : { sessionId: open.session }),
        permissionMode: open.permissionMode,
        ...(open.model === undefined ? {} : { model: open.model }),
        ...(open.agent === undefined ? {} : { agent: open.agent }),
        ...(open.hubMcp === undefined ? {} : { mcpServers: { harness: { type: 'http', url: open.hubMcp.url, headers: { Authorization: `Bearer ${open.hubMcp.secret}` } } } }),
        ...callbacks(listener, this.#options.dialogKinds),
      },
    });
    void (async () => {
      try {
        for await (const message of live) {
          for (const event of eventsOf(message)) { listener.event(event); }
        }
        listener.event({ type: 'ended' });
      } catch (error) {
        listener.event({ type: 'ended', problem: error instanceof Error ? error.message : String(error) });
      }
    })();
    return {
      send: (text) => { input.push(text); },
      interrupt: async () => { await live.interrupt(); },
      setMode: (mode) => live.setPermissionMode(mode),
      close: () => { input.end(); live.close(); },
    };
  }

  async sessions(request: { readonly folder?: string | undefined; readonly offset: number; readonly limit: number }): Promise<DriverPage<StoredSession>> {
    const infos = await listSessions({ ...(request.folder === undefined ? {} : { dir: request.folder }), offset: request.offset, limit: request.limit + 1 });
    return { items: infos.slice(0, request.limit).flatMap(storedOf), more: infos.length > request.limit };
  }

  async session(session: ClaudeSessionId): Promise<StoredSession | undefined> {
    const info = await getSessionInfo(session);
    return info === undefined ? undefined : storedOf(info)[0];
  }

  async transcript(request: TranscriptRequest): Promise<TranscriptSlice> {
    const dir = request.folder === undefined ? {} : { dir: request.folder };
    const read = (options: { dir?: string; offset?: number; limit?: number }): Promise<SessionMessage[]> => (
      request.agent === undefined ? getSessionMessages(request.session, options) : getSubagentMessages(request.session, request.agent, options)
    );
    const itemsOfAll = (messages: readonly SessionMessage[]): ClaudeTranscriptItem[] => messages.flatMap((message) => itemsOf(message, this.#options.textMax));
    if (!request.fromEnd) {
      const messages = await read({ ...dir, offset: request.offset, limit: request.limit + 1 });
      const page = messages.slice(0, request.limit);
      return { items: itemsOfAll(page), offset: request.offset, end: request.offset + page.length, more: messages.length > request.limit };
    }
    // the SDK has no count and pages only from the start (it parses the whole file for any page): read it all, then slice
    const messages = await read(dir);
    const { start, end } = sliceOf(messages.length, request);
    return { items: itemsOfAll(messages.slice(start, end)), offset: start, end, more: end < messages.length };
  }

  async importables(folder: string): Promise<FoundImportable[]> {
    // a session that is never sent a message: it starts, says what it sees, and is closed without a model call
    const input = new InputQueue();
    const probe = query({ prompt: input, options: { ...this.#base(folder), persistSession: false } });
    try {
      const [agents, commands, servers] = await Promise.all([probe.supportedAgents(), probe.supportedCommands(), probe.mcpServerStatus()]);
      const scoped = (name: string, ...parts: string[]) => (name.includes(':') ? { scope: 'plugin' as const } : found(folder, ...parts));
      return [
        ...agents.flatMap((agent): FoundImportable[] => {
          const where = scoped(agent.name, 'agents', `${agent.name}.md`);
          return where === undefined ? [] : [{ kind: 'agent', name: agent.name, description: agent.description, scope: where.scope, ...(where.scope === 'project' ? { folder } : {}) }];
        }),
        ...commands.filter((command) => command.builtin !== true).flatMap((command): FoundImportable[] => {
          const where = scoped(command.name, 'skills', command.name, 'SKILL.md') ?? found(folder, 'commands', `${command.name}.md`);
          return where === undefined ? [] : [{ kind: 'skill', name: command.name, description: command.description, scope: where.scope, ...(where.scope === 'project' ? { folder } : {}) }];
        }),
        ...servers.flatMap((status): FoundImportable[] => {
          const server = mcpConfigOf(status);
          const scope = mcpScope(status.scope);
          return server === undefined ? [] : [{ kind: 'mcp-server', name: status.name, description: status.serverInfo === undefined ? status.name : `${status.serverInfo.name} ${status.serverInfo.version}`, scope, server, ...(scope === 'project' || scope === 'local' ? { folder } : {}) }];
        }),
      ];
    } finally {
      input.end();
      probe.close();
    }
  }

  async skillText(name: string, folder: string): Promise<string | undefined> {
    const where = found(folder, 'skills', name, 'SKILL.md') ?? found(folder, 'commands', `${name}.md`);
    return where === undefined ? undefined : bodyOf(await readFile(where.path, 'utf8'));
  }
}
