/**
 * The Claude fleet in the browser (build 9), as plain functions over the `claude` system's shapes (`@harness/core`
 * `claude.ts`): the URL of the fleet and of a session, the hub query of the person's `claude/Session` records, how a
 * status looks, the tasks as a tree (workflows and subagents with what they started), a transcript page as the rows
 * drawn (each tool use with its result), and the checked args of a new session.
 */
import {
  CLAUDE_SESSION_TYPE, CLAUDE_SYSTEM, ClaudePermissionMode, ClaudeSession, ClaudeSessionStatus, ClaudeStart, InstanceName, qualify, type ClaudeTask, type ClaudeTranscriptItem,
  type DataRecord, type Filter, type Json, type QualifiedName, type RecordId, type RecordQuery,
} from '@harness/core';
import { z } from 'zod';
import type { StatusLook } from '../../admin/logic/systems.ts';
import type { IconName, SelectOption } from '../../ui/index.ts';

/** The record type the fleet is listed from. */
export const SESSION_TYPE = CLAUDE_SESSION_TYPE;

/** The claude fns the pages run. */
export const CLAUDE_FNS = {
  start: qualify(CLAUDE_SYSTEM, 'start_session'),
  send: qualify(CLAUDE_SYSTEM, 'send'),
  control: qualify(CLAUDE_SYSTEM, 'control'),
  transcript: qualify(CLAUDE_SYSTEM, 'transcript'),
} as const satisfies Record<string, QualifiedName>;

/** How many sessions the fleet list reads at a time. */
export const FLEET_PAGE = 30;
/** How many transcript entries a page reads. */
export const TRANSCRIPT_PAGE = 50;

/** The fleet page's URL: words, machine, folder, status, and the new-session dialog open. */
export const FleetUrl = z.object({
  q: z.string(),
  machine: z.string(),
  folder: z.string(),
  status: ClaudeSessionStatus,
  new: z.literal('1'),
}).partial();
export type FleetUrl = z.infer<typeof FleetUrl>;

/** A session page's URL: a subagent's own transcript shown instead of the main one (its task id). */
export const SessionUrl = z.object({ task: z.string().min(1) }).partial();
export type SessionUrl = z.infer<typeof SessionUrl>;

/** One session in the fleet: its record id (for the hub) and its value. */
export interface FleetSession {
  readonly id: RecordId;
  readonly value: ClaudeSession;
}

/** The hub query of the fleet under the URL's filters: newest change first. */
export function fleetQuery(url: FleetUrl, cursor?: string): RecordQuery {
  const filters: Filter[] = [];
  if (url.machine !== undefined && url.machine !== '') { filters.push({ field: 'instance', op: 'is', value: url.machine }); }
  if (url.folder !== undefined && url.folder !== '') { filters.push({ field: 'folder', op: 'is', value: url.folder }); }
  if (url.status !== undefined) { filters.push({ field: 'status', op: 'is', value: url.status }); }
  const words = url.q?.trim() ?? '';
  return {
    type: SESSION_TYPE,
    query: { limit: FLEET_PAGE, sort: [{ field: 'updatedAt', dir: 'desc' }], ...(filters.length === 0 ? {} : { filters }), ...(cursor === undefined ? {} : { cursor }) },
    ...(words === '' ? {} : { search: words }),
  };
}

/** The hub query of one session's record, by its machine and Claude's session id. */
export function sessionQuery(instance: string, session: string): RecordQuery {
  return { type: SESSION_TYPE, query: { limit: 1, filters: [{ field: 'instance', op: 'is', value: instance }, { field: 'session', op: 'is', value: session }] } };
}

/** The sessions among some records (a record that isn't one is left out). */
export function sessionsOf(records: readonly DataRecord[]): FleetSession[] {
  return records.flatMap((record) => {
    const value = ClaudeSession.safeParse(record.value);
    return value.success ? [{ id: record.id, value: value.data }] : [];
  });
}

/** How each status looks. */
export const STATUS_LOOK = {
  starting: { tone: 'accent', word: 'Starting', live: true },
  working: { tone: 'accent', word: 'Working', live: true },
  waiting: { tone: 'warn', word: 'Waiting for you', live: false },
  idle: { tone: 'ok', word: 'Idle', live: false },
  closed: { tone: 'neutral', word: 'Closed', live: false },
  failed: { tone: 'danger', word: 'Failed', live: false },
} as const satisfies Record<ClaudeSessionStatus, StatusLook>;

/** How a session's status looks, saying how many things wait on the person when some do. */
export function statusLook(session: Pick<ClaudeSession, 'status' | 'waiting'>): StatusLook {
  const look = STATUS_LOOK[session.status];
  const count = session.waiting.length;
  return count === 0 ? look : { tone: 'warn', word: `${count} waiting for you`, live: false };
}

/** Whether a session is live in its machine's process (it can be interrupted or stopped). */
export function isLive(status: ClaudeSessionStatus): boolean {
  return status === 'starting' || status === 'working' || status === 'waiting' || status === 'idle';
}

/** Whether a session is in a turn (its transcript and record change on their own). */
export function isBusy(status: ClaudeSessionStatus): boolean {
  return status === 'starting' || status === 'working' || status === 'waiting';
}

/** The status filter's choices. */
export const STATUS_OPTIONS: readonly SelectOption<ClaudeSessionStatus | ''>[] = [
  { value: '', label: 'Status' },
  ...ClaudeSessionStatus.options.map((status) => ({ value: status, label: STATUS_LOOK[status].word })),
];

/** What each permission mode lets Claude do without asking, in a word or two. */
export const MODE_LABEL = {
  default: 'Ask first',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
  dontAsk: 'Don\'t ask',
  auto: 'Auto',
} as const satisfies Record<ClaudePermissionMode, string>;

/** The permission mode choices. */
export const MODE_OPTIONS: readonly SelectOption<ClaudePermissionMode>[] = ClaudePermissionMode.options.map((mode) => ({ value: mode, label: MODE_LABEL[mode] }));

/** The last part of a folder's path, for tight places. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  return parts.at(-1) ?? path;
}

/** The distinct values some sessions have for a field, sorted, with the one picked kept even when none has it. */
export function choicesOf(sessions: readonly FleetSession[], field: 'instance' | 'folder', picked: string): string[] {
  const all = new Set(sessions.map((session) => session.value[field]));
  if (picked !== '') { all.add(picked); }
  return [...all].sort((a, b) => a.localeCompare(b));
}

// ─── tasks ────────────────────────────────────────────────────────────────────

/** A task with the tasks it started. */
export interface TaskNode {
  readonly task: ClaudeTask;
  readonly children: readonly TaskNode[];
}

/** The icon of each kind of task. */
export const TASK_ICON = { agent: 'sparkles', shell: 'code', workflow: 'tree', monitor: 'eye', other: 'dot' } as const satisfies Record<ClaudeTask['kind'], IconName>;

/** How each task status looks. */
export const TASK_LOOK = {
  running: { tone: 'accent', word: 'Running', live: true },
  done: { tone: 'ok', word: 'Done', live: false },
  failed: { tone: 'danger', word: 'Failed', live: false },
  stopped: { tone: 'neutral', word: 'Stopped', live: false },
} as const satisfies Record<ClaudeTask['status'], StatusLook>;

/**
 * The tasks as a tree: each under the task that started it (a task whose parent isn't known stands at the top),
 * running ones first, then the newest.
 */
export function taskTree(tasks: readonly ClaudeTask[]): TaskNode[] {
  const known = new Set(tasks.map((task) => task.id));
  const order = (a: ClaudeTask, b: ClaudeTask): number => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt;
  const under = (parent: string | undefined, seen: ReadonlySet<string>): TaskNode[] => tasks
    .filter((task) => (parent === undefined ? task.parent === undefined || !known.has(task.parent) : task.parent === parent) && !seen.has(task.id))
    .sort(order)
    .map((task) => ({ task, children: under(task.id, new Set([...seen, task.id])) }));
  return under(undefined, new Set());
}

/** A line about some tasks: how many run, else how many there were. */
export function tasksLine(tasks: readonly ClaudeTask[]): string {
  const running = tasks.filter((task) => task.status === 'running').length;
  if (running > 0) { return `${running} ${running === 1 ? 'task' : 'tasks'} running`; }
  return tasks.length === 0 ? '' : `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`;
}

// ─── the transcript ───────────────────────────────────────────────────────────

/** One row of a transcript as drawn: a message, Claude's thinking, a tool use with its result, or a note. */
export type TranscriptRow =
  | { readonly type: 'user' | 'assistant' | 'thinking' | 'system'; readonly key: string; readonly text: string }
  | { readonly type: 'tool'; readonly key: string; readonly tool: string; readonly summary: string; readonly input: Json; readonly result?: { readonly ok: boolean; readonly text: string } | undefined };

/** The fields of a tool's input that say what it does, in the order looked for. */
const SUMMARY_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'] as const;

/** What a tool use does, in one line: its command, file, pattern or description. */
export function toolSummary(input: Json): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) { return ''; }
  for (const field of SUMMARY_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim() !== '') { return value.trim().split('\n', 1)[0] ?? ''; }
  }
  return '';
}

/** A transcript's entries as rows: each tool result goes with its tool use (one left alone shows as a note). */
export function transcriptRows(items: readonly ClaudeTranscriptItem[]): TranscriptRow[] {
  const results = new Map<string, { ok: boolean; text: string }>();
  for (const item of items) { if (item.type === 'tool-result') { results.set(item.id, { ok: item.ok, text: item.text }); } }
  const used = new Set(items.flatMap((item) => (item.type === 'tool-use' ? [item.id] : [])));
  return items.flatMap((item): TranscriptRow[] => {
    switch (item.type) {
      case 'tool-use': return [{ type: 'tool', key: item.uuid, tool: item.tool, summary: toolSummary(item.input), input: item.input, result: results.get(item.id) }];
      case 'tool-result': return used.has(item.id) ? [] : [{ type: 'system', key: item.uuid, text: item.text }];
      case 'user':
      case 'assistant':
      case 'thinking':
      case 'system': return item.text.trim() === '' ? [] : [{ type: item.type, key: item.uuid, text: item.text }];
    }
  });
}

// ─── a new session ────────────────────────────────────────────────────────────

/** The new-session form as typed. */
export interface StartDraft {
  /** The machine (claude instance) it starts on; blank lets the hub pick. */
  readonly machine: string;
  readonly folder: string;
  readonly prompt: string;
  readonly title: string;
  readonly mode: ClaudePermissionMode | '';
}

/** An empty new-session form, on a machine and in a folder when they are given. */
export function startDraft(folder = '', machine = ''): StartDraft {
  return { machine, folder, prompt: '', title: '', mode: '' };
}

/** The args of `claude/start_session` from the form and the machine it runs on, or what is wrong with each field. */
export function startArgs(draft: StartDraft): { readonly ok: true; readonly args: ClaudeStart; readonly on?: InstanceName } | { readonly ok: false; readonly problems: Readonly<Record<string, string>> } {
  const checked = ClaudeStart.safeParse({
    folder: draft.folder.trim(), prompt: draft.prompt.trim(), wait: false,
    ...(draft.title.trim() === '' ? {} : { title: draft.title.trim() }), ...(draft.mode === '' ? {} : { permissionMode: draft.mode }),
  });
  const machine = InstanceName.safeParse(draft.machine);
  if (checked.success) { return { ok: true, args: checked.data, ...(machine.success ? { on: machine.data } : {}) }; }
  const problems: Record<string, string> = {};
  for (const issue of checked.error.issues) {
    const path = issue.path.join('.');
    problems[path] ??= path === 'folder' ? 'Pick the folder it works in.' : path === 'prompt' ? 'Say what Claude should do.' : issue.message;
  }
  return { ok: false, problems };
}
