/**
 * What the model saw, read back from a repetition's hub database (`hub.sqlite`, table `llmInteractions`): every LLM
 * step of a case's sessions in order, as compact text for the diagnostician. Each step shows what was new to the
 * model since its previous step in the same thread (the chat agent across its turns, or one fn's inner agent): the
 * system prompt in full the first time and only what changed after (loaded context lands there), each tool's
 * description and schema the first time it is offered and the names added or removed after, the new user messages
 * with their added blocks, the tool results (clipped), and what the model answered (reasoning, text, tool calls).
 * Also the live inventory of that hub: its systems, kinds and fns, for the diagnostician's ground truth.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { fnOfStoredToolName } from '@harness/core';
import { z } from 'zod';
import { clip } from './transcript.ts';

/** How long each kind of text may be in a step (characters). */
export interface ViewLimits {
  readonly toolResult: number;
  readonly userMessage: number;
  readonly systemChange: number;
  readonly toolDefinition: number;
  readonly reasoning: number;
  readonly toolArgs: number;
}

/** The limits tried in order until the whole trace fits. */
export const LIMIT_STEPS: readonly ViewLimits[] = [
  { toolResult: 1_600, userMessage: 6_000, systemChange: 12_000, toolDefinition: 6_000, reasoning: 1_500, toolArgs: 2_000 },
  { toolResult: 700, userMessage: 3_000, systemChange: 6_000, toolDefinition: 3_000, reasoning: 800, toolArgs: 1_000 },
  { toolResult: 300, userMessage: 1_500, systemChange: 3_000, toolDefinition: 1_500, reasoning: 400, toolArgs: 500 },
];

const ToolCall = z.object({ id: z.string().optional(), name: z.string(), arguments: z.unknown().optional() }).loose();
const Message = z.object({ role: z.string(), content: z.unknown().optional(), toolCalls: z.array(ToolCall).optional(), toolCallId: z.string().optional() }).loose();
type Message = z.infer<typeof Message>;
const Tool = z.object({ name: z.string(), description: z.string().optional(), parameters: z.unknown().optional() }).loose();
type Tool = z.infer<typeof Tool>;
const Request = z.object({ messages: z.array(Message), tools: z.array(Tool).optional() }).loose();
type Request = z.infer<typeof Request>;
const Response = z.object({ content: z.unknown().optional(), reasoning: z.unknown().optional(), toolCalls: z.array(ToolCall).optional(), finishReason: z.string().optional() }).loose();
type Response = z.infer<typeof Response>;

const Row = z.object({
  id: z.string(), turn: z.string().nullable(), run: z.string().nullable(), session: z.string().nullable(), system: z.string().nullable(),
  iteration: z.number().nullable(), model: z.string().nullable(), request: z.string().nullable(), response: z.string().nullable(),
  status: z.string().nullable(), error: z.string().nullable(), cost: z.number().nullable(),
});

/** One LLM step as read from the database. */
export interface Step {
  readonly index: number;
  readonly id: string;
  readonly session: string;
  readonly turn: string;
  readonly run: string;
  /** The fn whose run made the call (`hub/chat` for the chat agent). */
  readonly fn: string;
  readonly iteration: number;
  readonly status: string;
  readonly error: string | null;
  readonly request: Request;
  readonly response: Response | null;
}

/** A case's model steps, read once; `render` turns them into text at a limit. */
export interface ModelView {
  readonly steps: readonly Step[];
  /** The tools the chat model was offered, by name (for checking `tool-description:<fn>` fixes). */
  readonly toolNames: ReadonlySet<string>;
  render(limits: ViewLimits): string;
}

/** Text of a message's content (a string, or parts). */
function textOf(content: unknown): string {
  if (content === undefined || content === null) { return ''; }
  if (typeof content === 'string') { return content; }
  if (Array.isArray(content)) {
    return content.map((part: unknown) => {
      if (typeof part === 'string') { return part; }
      const p = z.object({ type: z.string().optional(), text: z.string().optional() }).loose().safeParse(part);
      return p.success && p.data.text !== undefined ? p.data.text : `[${p.success ? (p.data.type ?? 'part') : 'part'}]`;
    }).join('\n');
  }
  return JSON.stringify(content);
}

/** Middle-cut a long text, keeping its start and end. */
function cut(text: string, max: number): string {
  if (text.length <= max) { return text; }
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters cut …]\n${text.slice(-tail)}`;
}

/**
 * The fn name as the hub writes it (`database/create_table`, `database/main.expenses`) from a tool name as the model
 * got it (`database__create_table`, `database__main__expenses`; an older record's `database__main--expenses` too), by
 * core's display reader; a name it can't read (a cut one, a static tool) as it is.
 */
export function fnName(tool: string): string {
  return fnOfStoredToolName(tool) ?? tool;
}

/** A tool's definition as the model got it, without the schema boilerplate. */
function toolDefinition(tool: Tool, max: number): string {
  const parameters = JSON.stringify(tool.parameters ?? {}, (key, value: unknown) => (key === '$schema' ? undefined : value));
  const shown = parameters.length <= max ? parameters : `${parameters.slice(0, max)}… [schema clipped: ${parameters.length} characters in all]`;
  return `<tool name="${tool.name}">\n${tool.description ?? '(no description)'}\nparameters: ${shown}\n</tool>`;
}

/** What changed between two texts: the part that differs, with a little of what surrounds it. */
function textChange(before: string, after: string, max: number): string {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) { start++; }
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) { end++; }
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  return [
    `(the first ${start} characters are unchanged${end > 0 ? `, and the last ${end}` : ''})`,
    removed === '' ? '' : `removed:\n${cut(removed, Math.floor(max / 3))}`,
    added === '' ? '' : `added:\n${cut(added, max)}`,
  ].filter((part) => part !== '').join('\n');
}

/** A tool call in one line. */
function callLine(call: z.infer<typeof ToolCall>, max: number): string {
  const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
  // the model fills every optional arg with null in strict mode; drop those so the call reads as meant
  let shown = args;
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      shown = JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== null)));
    }
  } catch { /* not JSON: as written */ }
  return `${call.name}(${clip(shown, max)})${call.id === undefined ? '' : ` [${call.id.slice(-8)}]`}`;
}

/** One message of the delta, as text. */
function messageText(message: Message, names: ReadonlyMap<string, string>, limits: ViewLimits): string {
  const text = textOf(message.content);
  switch (message.role) {
    case 'user': return `<user>\n${cut(text, limits.userMessage)}\n</user>`;
    case 'tool': {
      const id = message.toolCallId ?? '';
      return `<tool_result for="${names.get(id) ?? 'a call'}"${id === '' ? '' : ` call="${id.slice(-8)}"`}>\n${cut(text, limits.toolResult)}\n</tool_result>`;
    }
    case 'assistant': {
      const calls = (message.toolCalls ?? []).map((call) => callLine(call, limits.toolArgs));
      return `<assistant (earlier)>${text === '' ? '' : `\n${cut(text, limits.userMessage)}`}${calls.length === 0 ? '' : `\ncalls: ${calls.join('; ')}`}\n</assistant>`;
    }
    default: return `<${message.role}>\n${cut(text, limits.userMessage)}\n</${message.role}>`;
  }
}

/** The key two messages compare by. */
const key = (message: Message): string => JSON.stringify([message.role, textOf(message.content), message.toolCallId ?? '', (message.toolCalls ?? []).map((c) => c.id ?? c.name)]);

/** Render the steps. */
function render(steps: readonly Step[], limits: ViewLimits): string {
  /** The last step of each thread (a run; the chat agent's runs of one session count as one thread). */
  const last = new Map<string, Step>();
  /** Tool definitions already shown in each session, by name. */
  const shownTools = new Map<string, Map<string, string>>();
  const threadOf = (step: Step): string => (step.fn === 'hub/chat' || step.fn === 'hub/chat_small' ? `${step.session}:chat` : step.run);
  const out: string[] = [];
  for (const step of steps) {
    const thread = threadOf(step);
    const before = last.get(thread);
    const who = step.fn === 'hub/chat' || step.fn === 'hub/chat_small' ? 'the chat agent' : `the agent inside ${step.fn} (its own prompt, not the chat's)`;
    const lines: string[] = [`### Step ${step.index}: ${who}, session ${step.session.slice(-6)}, turn ${step.turn.slice(-6)}, iteration ${step.iteration}${step.status === 'done' ? '' : ` (status ${step.status}${step.error === null ? '' : `: ${clip(step.error, 300)}`})`}`];
    // the system prompt
    const system = step.request.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
    const systemBefore = before === undefined ? undefined : before.request.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
    if (systemBefore === undefined) { lines.push(`SYSTEM PROMPT (full):\n${system}`); }
    else if (system !== systemBefore) { lines.push(`SYSTEM PROMPT CHANGED since step ${before?.index ?? '?'}:\n${textChange(systemBefore, system, limits.systemChange)}`); }
    // the tools
    const tools = step.request.tools ?? [];
    const seen = shownTools.get(step.session) ?? new Map<string, string>();
    shownTools.set(step.session, seen);
    const names = tools.map((t) => t.name);
    const namesBefore = before?.request.tools?.map((t) => t.name);
    const fresh = tools.filter((t) => seen.get(t.name) !== JSON.stringify(t));
    if (namesBefore === undefined || names.join() !== namesBefore.join()) {
      const added = namesBefore === undefined ? [] : names.filter((n) => !namesBefore.includes(n));
      const removed = namesBefore === undefined ? [] : namesBefore.filter((n) => !names.includes(n));
      lines.push(`TOOLS OFFERED (${names.length}): ${names.join(', ') || 'none'}${added.length === 0 ? '' : `\n  added: ${added.join(', ')}`}${removed.length === 0 ? '' : `\n  removed: ${removed.join(', ')}`}`);
    } else {
      lines.push(`TOOLS: the same ${names.length} as step ${before?.index ?? '?'}`);
    }
    if (fresh.length > 0) {
      lines.push(`TOOL DEFINITIONS (first time offered in this session):\n${fresh.map((t) => toolDefinition(t, limits.toolDefinition)).join('\n')}`);
      for (const t of fresh) { seen.set(t.name, JSON.stringify(t)); }
    }
    // the messages new since the thread's last step
    const messages = step.request.messages.filter((m) => m.role !== 'system');
    const previous = before?.request.messages.filter((m) => m.role !== 'system') ?? [];
    let common = 0;
    for (let a = previous[common], b = messages[common]; a !== undefined && b !== undefined && key(a) === key(b); a = previous[common], b = messages[common]) { common++; }
    const callNames = new Map<string, string>();
    for (const m of step.request.messages) { for (const c of m.toolCalls ?? []) { if (c.id !== undefined) { callNames.set(c.id, c.name); } } }
    const answered = new Set((before?.response?.toolCalls ?? []).map((c) => c.id ?? ''));
    const delta = messages.slice(common).filter((m) => !(m.role === 'assistant' && (m.toolCalls ?? []).some((c) => answered.has(c.id ?? '')))
      && !(m.role === 'assistant' && before?.response !== null && before?.response !== undefined && (m.toolCalls ?? []).length === 0 && textOf(m.content) === textOf(before.response.content)));
    if (before !== undefined && common < previous.length) {
      lines.push(`NOTE: the conversation differs from step ${before.index} from message ${common + 1} on (rewritten or replaced history); shown from there.`);
    }
    lines.push(delta.length === 0 ? 'NEW MESSAGES: none' : `${before === undefined ? 'MESSAGES' : 'NEW MESSAGES'}:\n${delta.map((m) => messageText(m, callNames, limits)).join('\n')}`);
    // what it answered
    const r = step.response;
    if (r === null) { lines.push('MODEL ANSWERED: nothing recorded'); }
    else {
      const reasoning = textOf(r.reasoning);
      const content = textOf(r.content);
      lines.push([
        'MODEL ANSWERED:',
        reasoning === '' ? '' : `reasoning: ${cut(reasoning, limits.reasoning)}`,
        content === '' ? '' : `text: ${cut(content, limits.userMessage)}`,
        (r.toolCalls ?? []).length === 0 ? '' : `tool calls: ${(r.toolCalls ?? []).map((c) => callLine(c, limits.toolArgs)).join('; ')}`,
      ].filter((part) => part !== '').join('\n'));
    }
    out.push(lines.join('\n'));
    last.set(thread, step);
  }
  return out.join('\n\n');
}

/** Open a repetition's hub database to read. */
export function openHubDb(repFolder: string): BetterSqlite3.Database {
  const file = join(repFolder, 'hub.sqlite');
  if (!existsSync(file)) { throw new Error(`no hub database at ${file}`); }
  return new BetterSqlite3(file, { readonly: true, fileMustExist: true });
}

/** The model steps of some sessions, in order. */
export function modelView(db: BetterSqlite3.Database, sessions: readonly string[]): ModelView {
  if (sessions.length === 0) { return { steps: [], toolNames: new Set(), render: () => '(no sessions)' }; }
  const marks = sessions.map(() => '?').join(',');
  const rows = z.array(Row).parse(db.prepare(`select id, turn, run, session, system, iteration, model, request, response, status, error, cost from llmInteractions where session in (${marks}) order by coalesce(startedAt, queuedAt), iteration`).all(...sessions));
  const fns = new Map(z.array(z.object({ id: z.string(), fn: z.string().nullable() })).parse(db.prepare(`select id, fn from runs where session in (${marks})`).all(...sessions)).map((r) => [r.id, r.fn ?? '?']));
  const steps: Step[] = [];
  const toolNames = new Set<string>();
  for (const row of rows) {
    if (row.request === null) { continue; }
    const request = Request.safeParse(JSON.parse(row.request));
    if (!request.success) { continue; }
    const response = row.response === null ? null : Response.safeParse(JSON.parse(row.response));
    const fn = fns.get(row.run ?? '') ?? (row.system === null ? 'hub/chat' : `${row.system}/?`);
    if (fn === 'hub/chat' || fn === 'hub/chat_small') { for (const t of request.data.tools ?? []) { toolNames.add(fnName(t.name)); } }
    steps.push({
      index: steps.length + 1, id: row.id, session: row.session ?? '', turn: row.turn ?? '', run: row.run ?? '', fn,
      iteration: row.iteration ?? 0, status: row.status ?? '', error: row.error, request: request.data, response: response?.success === true ? response.data : null,
    });
  }
  return { steps, toolNames, render: (limits) => render(steps, limits) };
}

/** The hub's systems, kinds and fns as the diagnostician's ground truth: contract fns, plus the ones this person made. */
export function inventory(db: BetterSqlite3.Database, personEmail: string): string {
  const parse = (text: string | null): Record<string, unknown> => { try { return z.record(z.string(), z.unknown()).parse(JSON.parse(text ?? '{}')); } catch { return {}; } };
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const systems = z.array(z.object({ name: z.string(), description: z.string().nullable() })).parse(db.prepare('select name, description from systems order by name').all());
  const kinds = z.array(z.object({ name: z.string(), system: z.string().nullable(), decl: z.string().nullable() })).parse(db.prepare('select name, system, decl from kinds order by system, name').all());
  const fns = z.array(z.object({ name: z.string(), system: z.string().nullable(), decl: z.string().nullable(), origin: z.string().nullable(), addedBy: z.string().nullable() })).parse(db.prepare('select name, system, decl, origin, addedBy from fns order by system, name').all());
  const person = z.object({ id: z.string() }).optional().parse(db.prepare('select id from actors where email = ?').get(personEmail));
  const bySystem = new Map<string, string[]>();
  const made: string[] = [];
  for (const f of fns) {
    const decl = parse(f.decl);
    const line = `${f.name}${str(decl['kind']) === '' || decl['kind'] === 'native' ? '' : ` [kind ${str(decl['kind'])}]`}: ${clip(str(decl['description']), 170)}`;
    if (f.origin === 'contract' || f.origin === '"contract"') {
      bySystem.set(f.system ?? '?', [...(bySystem.get(f.system ?? '?') ?? []), line]);
    } else if (person !== undefined && f.addedBy === person.id) {
      made.push(line);
    }
  }
  return [
    `Systems on this hub (all were connected while the case ran; calendar, MCP and Claude were not):\n${systems.map((s) => `- ${s.name}: ${s.description ?? ''}`).join('\n')}`,
    `Fn kinds:\n${kinds.map((k) => { const d = parse(k.decl); return `- ${k.name}: ${str(d['description'])}${str(d['applicability']) === '' ? '' : ` For: ${str(d['applicability'])}`}`; }).join('\n')}`,
    `Built-in fns, by system (name [kind if not native]: description):\n${[...bySystem.entries()].map(([system, lines]) => `${system} (${lines.length}):\n${lines.map((l) => `  ${l}`).join('\n')}`).join('\n')}`,
    `Fns this case's person ended up with (authored during the case):\n${made.length === 0 ? '  none' : made.map((l) => `  ${l}`).join('\n')}`,
  ].join('\n\n');
}
