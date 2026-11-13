/**
 * The mock hub's chat: a few sessions with history across days, and a scripted agent. Sending a message streams an
 * answer token by token while a run reads a file (queued, running with progress, done, with its cost); a message
 * that asks to write something waits for approval first. `!` invocations run, undo reports, the tree, LLM calls,
 * mentions and their hover cards, limits and capabilities all answer from the same in-memory state, and every change
 * goes out on the session's channel as the real hub sends it. A message that says "bad args" first makes a run whose
 * input is refused (retried, as an agent's mistake is), and every LLM call carries what the contextor chose for it
 * (the session's chat mode and contextor, set in its settings). It is a stand-in for building the UI, not a hub.
 */
import { fixture } from './fixture.ts';
import { LATEST_ORDERS, ORDERS_BY_CITY, WAITING_WRITE, WRITE_PREVIEW } from './mockBuild5.ts';
import { PROPOSED_CHANGE, RESCAN_PREVIEW } from './mockDatabase.ts';
import { existsSync } from 'node:fs';
import { FS_CLIENT, INSTALL_PREVIEW, INSTALL_RESULT, MOCK_CLIENTS } from './mockBuild6.ts';
import {
  splitName, Approval, ChatCapabilities, ChatMessage, LlmInteraction, ModelCallId, ResolvedLimits, Run, RunId, Session, mintId, type ActorId, type ApprovalId, Json, type MessagePart, type OutgoingPart,
  QualifiedName, type RunUpdate, type SessionEvent, type SessionId, type SessionSummary, type TreeNode, type TurnId,
} from '@harness/core';
import type { z } from 'zod';
import { summaryOf as summary } from '../src/chat/state/sessions.ts';
import { selectionReport } from '../src/chat/test/fakes.ts';
import { NOTE_TYPE, NOTES_WIDGET, SAMPLE_PAGED_WIDGET, SAMPLE_TABLE, SAMPLE_WIDGET } from '../src/data/test/samples.ts';
import { BASH_CHANGES, FLAGGED_COMMAND, FLAGGED_PREVIEW } from './mockBuild8.ts';

/** Send one event on a session's channel. */
export type EmitSession = (session: SessionId, event: SessionEvent) => void;

const AGENT = 'act_agent';
const DAY = 86_400_000;

const REPLY = [
  'I read **docs/harness.md**. In short:\n\n',
  '- The **hub** owns every LLM call and keeps the record of runs, turns and costs.\n',
  '- **Systems** connect over a WebSocket and add fns, types and resources.\n',
  '- The chat shows each run live, with its status, progress and cost.\n\n',
  'Here is how a system declares a fn:\n\n```ts\nexport const read = fn({\n  description: \'Read a file\',\n  args: g.obj({ path: g.text() }),\n  returns: g.text(),\n});\n```\n\n',
  'Want me to open the fs system next?',
];

/** One fn call of a mock agent turn: a write waits for approval. */
interface ScriptCall {
  readonly fn: QualifiedName;
  readonly args: Json;
  readonly approval: boolean;
}

/** A mock agent turn: its calls one after another, then its answer streams. */
interface Script {
  readonly calls: readonly [ScriptCall, ...ScriptCall[]];
}

/** What the mock agent does for a message: asked for fs/bash, two reads then the shell (approved first); else one read or write. */
function scriptFor(text: string): Script {
  if (text.toLowerCase().includes('fs/bash')) {
    return {
      calls: [
        { fn: 'fs/read_file', args: { path: 'package.json' }, approval: false },
        { fn: 'fs/read_file', args: { path: 'tsconfig.json' }, approval: false },
        { fn: 'fs/bash', args: { command: 'echo approved-once' }, approval: true },
      ],
    };
  }
  const write = /write|save|change/i.test(text);
  return { calls: [{ fn: write ? 'fs/write_file' : 'fs/read_file', args: { path: write ? 'notes/summary.md' : 'docs/harness.md' }, approval: write }] };
}

/** The mock chat's state and its handlers' logic. */
export class MockChat {
  readonly #owner: () => ActorId;
  #emit: EmitSession = () => undefined;
  readonly sessions = new Map<SessionId, Session>();
  readonly messages = new Map<SessionId, ChatMessage[]>();
  readonly runs = new Map<RunId, Run>();
  readonly calls = new Map<string, LlmInteraction>();
  readonly approvals = new Map<ApprovalId, { approval: Approval; resume: () => void }>();
  readonly #now: () => number;

  constructor(owner: () => ActorId, now: () => number = Date.now) {
    this.#owner = owner;
    this.#now = now;
    this.#seed();
  }

  /** Where events go, once the server exists. */
  attach(emit: EmitSession): void {
    this.#emit = emit;
  }

  capabilities(): ChatCapabilities {
    // `satisfies` the schema's input, so a field the schema gains breaks this at compile time, not at the first call
    const capabilities = {
      voiceInput: false, voiceOutput: false, uploads: true, display: {},
      mentions: [{ provider: 'fs/files', title: 'Files', of: 'fs/Entry' }],
      methods: [{ type: 'fs/Entry', method: 'reveal', fn: 'fs/Entry.reveal', description: 'Show it in the file manager', args: { name: 'obj', props: { self: { type: { name: 'fs/Entry' } } } } }],
      commands: [
        { name: 'tree', context: 'fs/tree', args: [{ name: 'root', hint: 'The folder to start from', required: false }], description: 'Show the project’s file tree' },
        { name: 'docs', context: 'fs/docs', args: [], description: 'Add the design docs to this chat' },
      ],
      agents: [{ fn: 'hub/chat', description: 'The chat agent.' }, { fn: 'fs/explore', description: 'Explores the project and answers questions about it.' }],
      invocations: [
        { fn: 'fs/read_file', description: 'Read a file', args: { name: 'obj', props: { path: { type: { name: 'text', options: { minLength: 1 } }, docs: 'Relative to the project root.' } } } },
        {
          fn: 'fs/edit', description: 'Replace text in a file',
          args: { name: 'obj', props: { path: { type: { name: 'text', options: { minLength: 1 } } }, find: { type: { name: 'text' } }, replace: { type: { name: 'text' } }, all: { type: { name: 'optional', generic: { T: { name: 'bool' } } } } } },
        },
      ],
      // fs's client build draws the install card, when it has been built
      clients: existsSync(FS_CLIENT) ? [{ system: 'fs', url: `/api${MOCK_CLIENTS}fs/index.js`, hash: 'mock-fs' }] : [],
      systems: [{ name: 'fs', status: 'connected', enabled: true }, { name: 'embedder', status: 'connected', enabled: true }, { name: 'notes', status: 'disconnected', enabled: true }],
      models: [{ id: 'meta-llama/llama-3.3-8b-instruct:free', provider: 'openrouter', name: 'Llama 3.3 8B (free)', contextWindow: 131_072, pricing: { input: 0, output: 0 }, capabilities: ['chat', 'tools'] }],
    } satisfies z.input<typeof ChatCapabilities>;
    return ChatCapabilities.parse(capabilities);
  }

  list(search: string | undefined, archived: boolean): SessionSummary[] {
    const q = search?.toLowerCase() ?? '';
    return [...this.sessions.values()].filter((s) => s.archived === archived && (q === '' || s.title.toLowerCase().includes(q))).sort((a, b) => b.updatedAt - a.updatedAt).map(summary);
  }

  session(id: SessionId): Session {
    const found = this.sessions.get(id);
    if (found === undefined) { throw new Error(`no session ${id}`); }
    return found;
  }

  create(title?: string): Session {
    const now = this.#now();
    const made = fixture(Session, {
      id: mintId('session'), title: title ?? 'New chat', owner: this.#owner(), agent: 'hub/chat',
      participants: [{ actor: this.#owner(), role: 'owner', notify: 'all', joinedAt: now }, { actor: AGENT, role: 'agent', notify: 'none', joinedAt: now }],
      systems: 'all', tools: [], context: [], status: 'idle', transcript: [], createdAt: now, updatedAt: now, archived: false,
    });
    this.sessions.set(made.id, made);
    this.messages.set(made.id, []);
    return made;
  }

  update(id: SessionId, change: Partial<Pick<Session, 'title' | 'archived' | 'systems'>> & {
    notify?: Session['participants'][number]['notify'];
    /** The chat mode, contextor and fn mode here; `null` goes back to the agent's. */
    mode?: Session['mode'] | null;
    contextor?: Session['contextor'] | null;
    fnMode?: Session['fnMode'] | null;
  }): Session {
    const current = this.session(id);
    const { notify, mode, contextor, fnMode, ...rest } = change;
    const { mode: _mode, contextor: _contextor, fnMode: _fnMode, ...kept } = current;
    const nextMode = mode === undefined ? current.mode : mode ?? undefined;
    const nextContextor = contextor === undefined ? current.contextor : contextor ?? undefined;
    const nextFnMode = fnMode === undefined ? current.fnMode : fnMode ?? undefined;
    const next: Session = {
      ...kept, ...rest, updatedAt: this.#now(),
      ...(nextMode === undefined ? {} : { mode: nextMode }), ...(nextContextor === undefined ? {} : { contextor: nextContextor }),
      ...(nextFnMode === undefined ? {} : { fnMode: nextFnMode }),
      participants: notify === undefined ? current.participants : current.participants.map((p) => (p.actor === this.#owner() ? { ...p, notify } : p)),
    };
    this.sessions.set(id, next);
    this.#emit(id, { type: 'session', session: summary(next) });
    return next;
  }

  /** Messages newest first, paged backwards by index. */
  page(id: SessionId, cursor: string | undefined, limit: number): { items: ChatMessage[]; cursor?: string } {
    const all = [...(this.messages.get(id) ?? [])].reverse();
    const start = cursor === undefined ? 0 : Number(cursor);
    const end = start + limit;
    return { items: all.slice(start, end), ...(end < all.length ? { cursor: String(end) } : {}) };
  }

  limits(session: SessionId): ResolvedLimits {
    return fixture(ResolvedLimits, {
      priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 0.5, time: 600_000 }, limitedBy: 'bgt_session',
      budgets: [{ rule: 'bgt_session', scope: { scope: 'session', session }, remaining: 1.2 }, { rule: 'bgt_hub', scope: { scope: 'hub' }, remaining: 48 }],
    });
  }

  send(id: SessionId, parts: readonly OutgoingPart[], replyTo: ChatMessage['replyTo']): { turn: TurnId; message: ChatMessage } {
    const turn = mintId('turn');
    const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
    const message = this.#add(id, {
      turn, author: this.#owner(), role: 'user', status: 'done',
      parts: [...parts.map((p): MessagePart => (p.type === 'mention' ? { ...p, text: `the file ${p.label}` } : p)), ...extras()],
      ...(replyTo === undefined ? {} : { replyTo }),
    });
    const retried = /bad args/i.test(text);
    setTimeout(() => { this.#answer(id, turn, scriptFor(text), retried); }, 250);
    return { turn, message };
  }

  invoke(id: SessionId, fn: QualifiedName, args: Json): { turn: TurnId; run: RunId } {
    const turn = mintId('turn');
    const run = this.#run(id, turn, fn, args, this.#owner());
    this.#add(id, { turn, author: this.#owner(), role: 'user', status: 'done', parts: [{ type: 'invocation', run: run.id, fn }], runs: [run.id] });
    this.#progress(id, run.id, () => undefined);
    return { turn, run: run.id };
  }

  /** What waits on the person in a session: its runs' pending approvals (the mock asks no handler questions). */
  waiting(session: SessionId): { approvals: Approval[]; handlers: [] } {
    return { approvals: [...this.approvals.values()].map((w) => w.approval).filter((a) => this.runs.get(a.run)?.session === session), handlers: [] };
  }

  /** The pending approvals of some runs, with their previews (the inbox's cards). */
  approvalsOf(runs: readonly RunId[]): Approval[] {
    const wanted = new Set<string>(runs);
    return [...this.approvals.values()].map((w) => w.approval).filter((a) => wanted.has(a.run));
  }

  approve(id: ApprovalId, approve: boolean): Approval {
    const waiting = this.approvals.get(id);
    if (waiting === undefined) { throw new Error(`no approval ${id}`); }
    const decided = fixture(Approval, { ...waiting.approval, status: approve ? 'approved' : 'denied', decisions: [{ by: this.#owner(), approve, remember: 'once', at: this.#now() }] });
    this.approvals.delete(id);
    const session = this.runs.get(decided.run)?.session;
    if (session !== undefined) { this.#emit(session, { type: 'approval', approval: decided }); }
    if (approve) { waiting.resume(); } else if (session !== undefined) { this.#settle(session, decided.run, 'cancelled'); }
    return decided;
  }

  undo(turn: TurnId): { turn: TurnId; undone: { run: RunId; fn: QualifiedName; summary: string }[]; failed: []; notUndoable: [] } {
    const undone = [...this.runs.values()].filter((r) => r.turn === turn && r.status === 'done');
    for (const run of undone) { this.runs.set(run.id, { ...run, status: 'undone' }); }
    const session = undone[0]?.session ?? [...this.messages.entries()].find(([, ms]) => ms.some((m) => m.turn === turn))?.[0];
    if (session !== undefined) {
      for (const run of undone) { this.#emit(session, { type: 'run', run: run.id, fn: run.fn, update: { type: 'status', status: 'undone' } }); }
      this.#add(session, { turn, author: 'act_hub', role: 'note', status: 'done', parts: [{ type: 'text', text: undone.length === 0 ? 'Undid this turn. Nothing needed putting back.' : `Undid this turn: ${undone.map((r) => r.fn).join(', ')}.` }] });
    }
    return { turn, undone: undone.map((r) => ({ run: r.id, fn: r.fn, summary: `Put back ${String(Reflect.get(Object(r.args), 'path') ?? '')}` })), failed: [], notUndoable: [] };
  }

  run(id: RunId): Run {
    const found = this.runs.get(id);
    if (found === undefined) { throw new Error(`no run ${id}`); }
    return found;
  }

  tree(turn: TurnId): TreeNode {
    const runs = [...this.runs.values()].filter((r) => r.turn === turn);
    const calls = [...this.calls.values()].filter((c) => c.turn === turn).map((c) => ({ id: c.id, model: c.model, cost: c.cost, status: c.status }));
    const root = runs[0];
    const node = (r: Run): TreeNode => ({ run: { id: r.id, fn: r.fn, status: r.status, cost: r.cost, totalCost: r.totalCost, ...(r.startedAt === undefined ? {} : { startedAt: r.startedAt }), ...(r.endedAt === undefined ? {} : { endedAt: r.endedAt }) }, llmCalls: [], children: [] });
    const agent: TreeNode = {
      run: { id: root?.parent ?? RunId.parse('run_agent'), fn: 'hub/chat', status: runs.every((r) => r.status === 'done') ? 'done' : 'running', cost: 0.003, totalCost: 0.003 + runs.reduce((n, r) => n + r.totalCost, 0) },
      llmCalls: calls, children: runs.map(node),
    };
    return agent;
  }

  llmCall(id: string): LlmInteraction {
    const found = this.calls.get(id);
    if (found === undefined) { throw new Error(`no LLM call ${id}`); }
    return found;
  }

  /** Mentions of files. */
  mentions(query: string): { label: string; hint: string; icon: string; target: Json }[] {
    const files = ['docs/harness.md', 'docs/architecture.md', 'packages/web/src/main.ts', 'packages/hub/src/main.ts', 'README.md'];
    return files.filter((f) => f.toLowerCase().includes(query.toLowerCase())).map((f) => ({ label: f.split('/').at(-1) ?? f, hint: f, icon: 'file', target: { path: f } }));
  }

  hover(target: Json): { hover: { title: string; subtitle: string; fields: { label: string; value: string }[]; body: string; open: { resource: `${string}://${string}` } } } {
    const path = typeof target === 'object' && target !== null && !Array.isArray(target) && typeof target['path'] === 'string' ? target['path'] : 'file';
    return { hover: { title: path.split('/').at(-1) ?? path, subtitle: path, fields: [{ label: 'Size', value: '12.4 KB' }, { label: 'Changed', value: 'Today' }], body: '# Harness\nA web-based agent harness.', open: { resource: `file:///${path}` } } };
  }

  #answer(id: SessionId, turn: TurnId, script: Script, retried = false): void {
    const agentRun = mintId('run');
    this.#setStatus(id, 'running');
    // the model's first call had the wrong args: refused before the fn ran, and fed back, so it tries again
    const [first] = script.calls;
    const refused = retried ? [this.#refused(id, turn, first.fn, agentRun)] : [];
    const run = this.#run(id, turn, first.fn, first.args, AGENT, agentRun, first.approval ? 'awaiting-approval' : 'queued');
    const call = this.#call(id, turn, agentRun);
    const answer = this.#add(id, { turn, author: AGENT, role: 'assistant', status: 'streaming', parts: [{ type: 'text', text: '' }], runs: [...refused.map((r) => r.id), run.id] });
    const stream = (): void => {
      let at = 0;
      const timer = setInterval(() => {
        const piece = REPLY[at++];
        if (piece === undefined) {
          clearInterval(timer);
          this.#finish(id, answer.id, call);
          return;
        }
        this.#emit(id, { type: 'token', message: answer.id, text: piece });
        this.#patchMessage(id, answer.id, (m) => {
          const last = m.parts.at(-1);
          return { ...m, parts: last?.type === 'text' ? [...m.parts.slice(0, -1), { type: 'text', text: last.text + piece }] : [...m.parts, { type: 'text', text: piece }] };
        });
      }, 180);
    };
    // each call runs once the one before it is done; a call that needs approval waits for it, then runs
    const perform = (current: Run, step: ScriptCall, index: number): void => {
      const then = (): void => {
        const following = script.calls[index + 1];
        if (following === undefined) { stream(); return; }
        const next = this.#run(id, turn, following.fn, following.args, AGENT, agentRun, following.approval ? 'awaiting-approval' : 'queued');
        this.#patchMessage(id, answer.id, (m) => ({ ...m, runs: [...m.runs, next.id] }));
        const shown = this.messages.get(id)?.find((m) => m.id === answer.id);
        if (shown !== undefined) { this.#emit(id, { type: 'message', message: shown }); }
        perform(next, following, index + 1);
      };
      if (step.approval) {
        const approval = fixture(Approval, { id: mintId('approval'), run: current.id, fn: current.fn, approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: this.#now() });
        this.approvals.set(approval.id, { approval, resume: () => { this.#progress(id, current.id, then); } });
        this.#emit(id, { type: 'approval', approval });
        return;
      }
      this.#progress(id, current.id, then);
    };
    perform(run, first, 0);
  }

  #progress(id: SessionId, run: RunId, then: () => void): void {
    this.#update(id, run, { type: 'status', status: 'running' });
    let fraction = 0;
    const timer = setInterval(() => {
      fraction = Math.min(1, fraction + 0.25);
      this.#update(id, run, { type: 'progress', progress: { fraction, message: fraction < 1 ? 'Reading…' : 'Read 12.4 KB' } });
      if (fraction >= 1) {
        clearInterval(timer);
        this.#update(id, run, { type: 'cost', cost: 0.0004, total: 0.0004 });
        this.#settle(id, run, 'done');
        then();
      }
    }, 250);
  }

  #settle(id: SessionId, run: RunId, status: 'done' | 'cancelled'): void {
    const current = this.runs.get(run);
    if (current !== undefined) {
      this.runs.set(run, { ...current, status, endedAt: this.#now(), ...(status === 'done' ? { outcome: { status: 'done', result: '# Harness\n\nA web-based agent harness…' } } : {}) });
    }
    this.#update(id, run, { type: 'status', status });
  }

  #finish(id: SessionId, message: ChatMessage['id'], call: LlmInteraction): void {
    this.#patchMessage(id, message, (m) => ({ ...m, status: 'done' }));
    const done = this.messages.get(id)?.find((m) => m.id === message);
    if (done !== undefined) { this.#emit(id, { type: 'message', message: done }); }
    this.calls.set(call.id, { ...call, status: 'done', endedAt: this.#now(), response: { content: REPLY.join(''), finishReason: 'stop' }, usage: { input: 2_140, output: 312 }, cost: 0.0031 });
    this.#setStatus(id, 'idle');
    this.#emit(id, { type: 'controls', controls: { pause: false, cancel: false, uncancellable: [], undoLastTurn: true } });
  }

  #update(id: SessionId, run: RunId, update: RunUpdate): void {
    const current = this.runs.get(run);
    if (current === undefined) { return; }
    const next: Run = update.type === 'status'
      ? { ...current, status: update.status, ...(update.status === 'running' && current.startedAt === undefined ? { startedAt: this.#now() } : {}) }
      : update.type === 'progress' ? { ...current, progress: update.progress }
        : update.type === 'cost' ? { ...current, cost: update.cost, totalCost: update.total }
          : update.type === 'background' ? { ...current, background: true } : { ...current, allowed: update.operations };
    this.runs.set(run, next);
    this.#emit(id, { type: 'run', run, fn: current.fn, update });
  }

  #setStatus(id: SessionId, status: Session['status']): void {
    const current = this.session(id);
    const next = { ...current, status, updatedAt: this.#now() };
    this.sessions.set(id, next);
    this.#emit(id, { type: 'session', session: summary(next) });
  }

  /** A run whose input the hub refused (the model wrote `file` where the fn takes `path`): settled at once, retried by the agent. */
  #refused(session: SessionId, turn: TurnId, fn: QualifiedName, parent: RunId): Run {
    const run = this.#run(session, turn, fn, { file: 'docs/harness.md' }, AGENT, parent);
    const settled: Run = {
      ...run, status: 'invalid-input', startedAt: this.#now(), endedAt: this.#now(),
      outcome: { status: 'invalid-input', invalid: { source: 'schema', problems: [{ path: 'path', message: 'Required' }, { path: 'file', message: 'Not a field of fs/read_file' }] } },
    };
    this.runs.set(run.id, settled);
    this.#emit(session, { type: 'run', run: run.id, fn, update: { type: 'status', status: 'invalid-input' } });
    return settled;
  }

  #run(session: SessionId, turn: TurnId, fn: QualifiedName, args: Json, caller: string, parent?: RunId, status: Run['status'] = 'queued'): Run {
    const id = mintId('run');
    const run = fixture(Run, {
      id, fn, fnVersion: '1', kind: 'native', system: splitName(fn).system, root: parent ?? id, ...(parent === undefined ? {} : { parent }), turn, session, key: id,
      actor: this.#owner(), caller, args, status, allowed: { cancel: true, pause: false, background: true }, cost: 0, totalCost: 0, priority: 'interactive',
      background: false, attempt: 1, errors: [], stateChanges: [], createdAt: this.#now(),
    });
    this.runs.set(id, run);
    this.#emit(session, { type: 'run', run: id, fn, update: { type: 'status', status } });
    return run;
  }

  #call(session: SessionId, turn: TurnId, run: RunId): LlmInteraction {
    const chosen = this.sessions.get(session);
    const call = fixture(LlmInteraction, {
      // what the contextor chose for this prompt, in the session's own mode and contextor
      selection: selectionReport({ mode: chosen?.mode?.type ?? 'tools', contextor: chosen?.contextor?.type ?? 'graph' }),
      id: mintId('llmInteraction'), turn, run, session, iteration: 0, provider: 'openrouter', model: 'meta-llama/llama-3.3-8b-instruct:free',
      request: {
        messages: [
          { role: 'system', content: 'You are the chat agent of harness. Use the fns you are given; ask before changing files.' },
          { role: 'user', content: 'Read the docs and sum them up.\n<local-time>2026-11-07T09:30:00-05:00</local-time>\n<suggested-fns>fs/read_file, fs/tree</suggested-fns>' },
        ],
        tools: [{ name: 'fs_read_file', description: 'Read a file', parameters: { type: 'object' } }, { name: 'fs_tree', description: 'List files', parameters: { type: 'object' } }],
      },
      cost: 0, status: 'streaming', priority: 'interactive', queuedAt: this.#now(), startedAt: this.#now() + 80, firstTokenAt: this.#now() + 420,
    });
    this.calls.set(call.id, call);
    return call;
  }

  #add(id: SessionId, fields: Pick<ChatMessage, 'turn' | 'author' | 'role' | 'status' | 'parts'> & Partial<Pick<ChatMessage, 'runs' | 'replyTo' | 'createdAt' | 'cacheMiss'>>): ChatMessage {
    const message = fixture(ChatMessage, { id: mintId('message'), session: id, runs: [], replyAll: false, answerers: [], createdAt: this.#now(), ...fields });
    this.messages.set(id, [...(this.messages.get(id) ?? []), message]);
    this.#emit(id, { type: 'message', message });
    return message;
  }

  #patchMessage(id: SessionId, message: ChatMessage['id'], change: (m: ChatMessage) => ChatMessage): void {
    this.messages.set(id, (this.messages.get(id) ?? []).map((m) => (m.id === message ? change(m) : m)));
  }

  /** Build 5: query results as the database system attaches them, and a write waiting for approval with its preview. */
  #seedQueries(now: number): void {
    const shop = this.create('Orders this month');
    this.sessions.set(shop.id, { ...shop, updatedAt: now - 60_000 });
    const turn = mintId('turn');
    this.#add(shop.id, { turn, author: this.#owner(), role: 'user', status: 'done', createdAt: now - 300_000, parts: [{ type: 'text', text: 'Which cities ordered most this month, and what came in last?' }] });
    this.#add(shop.id, {
      turn, author: AGENT, role: 'assistant', status: 'done', createdAt: now - 290_000,
      parts: [
        { type: 'text', text: 'Oslo leads with 128 orders, then Lima and Rome. The latest orders are below; 312 in all.' },
        { type: 'attachment', attachment: 'database/result', title: 'Orders by city', data: Json.parse(ORDERS_BY_CITY) },
        { type: 'attachment', attachment: 'database/result', title: 'Latest orders', data: Json.parse(LATEST_ORDERS) },
      ],
    });
    const write = fixture(Run, {
      id: WAITING_WRITE, fn: 'database/shop.refund_orders', fnVersion: '1', kind: 'database/query', system: 'database', root: WAITING_WRITE, turn, session: shop.id, key: WAITING_WRITE,
      actor: this.#owner(), caller: AGENT, args: { ids: [1037, 1033] }, status: 'awaiting-approval', allowed: { cancel: true, pause: false, background: false }, cost: 0, totalCost: 0,
      priority: 'interactive', background: false, attempt: 1, errors: [], stateChanges: [], createdAt: now - 280_000,
    });
    this.runs.set(write.id, write);
    const approval = fixture(Approval, { id: 'apr_orders_write', run: write.id, fn: write.fn, approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: now - 280_000, preview: WRITE_PREVIEW });
    this.approvals.set(approval.id, { approval, resume: () => { this.#settle(shop.id, write.id, 'done'); } });
    // a rescan of the shop database found a change that breaks a saved query: proposed for an admin
    const rescan = fixture(Run, {
      ...write, id: PROPOSED_CHANGE, fn: 'database/apply_type_changes', kind: 'native', root: PROPOSED_CHANGE, key: PROPOSED_CHANGE, instance: 'shop', args: { scan: 'scan_7f1c' },
      createdAt: now - 3_600_000,
    });
    this.runs.set(rescan.id, rescan);
    const proposal = fixture(Approval, { id: 'apr_shop_rescan', run: rescan.id, fn: rescan.fn, approver: { by: 'hub' }, status: 'pending', decisions: [], createdAt: rescan.createdAt, preview: RESCAN_PREVIEW, proposed: true });
    this.approvals.set(proposal.id, { approval: proposal, resume: () => { this.#settle(shop.id, rescan.id, 'done'); } });
  }

  /**
   * Build 6: a system installed from the chat (the install card, done) and its update waiting for an admin (the
   * approval card with what the install binds).
   */
  #seedInstall(now: number): void {
    const chat = this.create('Install the dice system');
    this.sessions.set(chat.id, { ...chat, updatedAt: now - 2 * DAY });
    const first = mintId('turn');
    this.#add(chat.id, { turn: first, author: this.#owner(), role: 'user', status: 'done', createdAt: now - 600_000, parts: [{ type: 'text', text: 'Make a dice system and install it.' }] });
    const installed = this.#run(chat.id, first, 'fs/install_system', { path: 'systems/random' }, AGENT);
    this.runs.set(installed.id, { ...installed, status: 'done', startedAt: now - 590_000, endedAt: now - 560_000, outcome: { status: 'done', result: INSTALL_RESULT } });
    this.#add(chat.id, {
      turn: first, author: AGENT, role: 'assistant', status: 'done', createdAt: now - 550_000, runs: [installed.id],
      parts: [{ type: 'text', text: 'random 0.1.0 is installed and connected. Its fn `random/roll` rolls dice.' }],
    });
    const second = mintId('turn');
    this.#add(chat.id, { turn: second, author: this.#owner(), role: 'user', status: 'done', createdAt: now - 60_000, parts: [{ type: 'text', text: 'Add a coin flip and update it.' }] });
    const update = this.#run(chat.id, second, 'fs/install_system', { path: 'systems/random' }, AGENT, undefined, 'awaiting-approval');
    this.runs.set(update.id, { ...update, createdAt: now - 50_000 });
    const approval = fixture(Approval, { id: 'apr_random_update', run: update.id, fn: update.fn, approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: now - 50_000, preview: INSTALL_PREVIEW });
    this.approvals.set(approval.id, { approval, resume: () => { this.#settle(chat.id, update.id, 'done'); } });
    this.#add(chat.id, {
      turn: second, author: AGENT, role: 'assistant', status: 'done', createdAt: now - 45_000, runs: [update.id],
      parts: [{ type: 'text', text: 'I added `flip` and built it again. The update waits for your approval.' }],
    });
  }

  /** Build 8: a saved widget run in a chat (bar chart and table, row actions) and a plain result table that can be saved as one. */
  #seedWidgets(now: number): void {
    const chat = this.create('Notes widget');
    this.sessions.set(chat.id, { ...chat, updatedAt: now - 30_000 });
    const turn = mintId('turn');
    this.#add(chat.id, { turn, author: this.#owner(), role: 'user', status: 'done', createdAt: now - 200_000, parts: [{ type: 'text', text: 'Show my open notes, and the records table too.' }] });
    const widget = this.#run(chat.id, turn, NOTES_WIDGET, {}, AGENT);
    const table = this.#run(chat.id, turn, QualifiedName.parse('hub/records_table'), { type: NOTE_TYPE }, AGENT);
    this.runs.set(widget.id, { ...widget, status: 'done', startedAt: now - 190_000, endedAt: now - 189_000, outcome: { status: 'done', result: Json.parse(SAMPLE_WIDGET) } });
    this.runs.set(table.id, { ...table, status: 'done', startedAt: now - 188_000, endedAt: now - 187_500, outcome: { status: 'done', result: Json.parse(SAMPLE_TABLE) } });
    // the same widget with controls and paging: its second page, Status set to open
    const paged = this.#run(chat.id, turn, NOTES_WIDGET, { status: 'open', owner: 'Sam', offset: 3 }, AGENT);
    this.runs.set(paged.id, { ...paged, status: 'done', startedAt: now - 187_000, endedAt: now - 186_500, outcome: { status: 'done', result: Json.parse(SAMPLE_PAGED_WIDGET) } });
    this.#add(chat.id, {
      turn, author: AGENT, role: 'assistant', status: 'done', createdAt: now - 180_000, runs: [widget.id, table.id, paged.id],
      parts: [{ type: 'text', text: 'Here are your open notes as a widget, and the raw records below.' }],
    });
  }

  /**
   * Build 8: a `bash` run that changed files (the change tabs under its output, the files without a diff listed with
   * why), then a `bash` call that touches sensitive files waiting for approval with them listed.
   */
  #seedChanges(now: number): void {
    const chat = this.create('Tidy the routes');
    this.sessions.set(chat.id, { ...chat, updatedAt: now - 20_000 });
    const first = mintId('turn');
    this.#add(chat.id, { turn: first, author: this.#owner(), role: 'user', status: 'done', createdAt: now - 400_000, parts: [{ type: 'text', text: 'Run the route script and show me what it changed.' }] });
    const ran = this.#run(chat.id, first, QualifiedName.parse('fs/bash'), { command: 'npm run routes:tidy' }, AGENT);
    this.runs.set(ran.id, {
      ...ran, status: 'done', startedAt: now - 390_000, endedAt: now - 384_000,
      outcome: { status: 'done', result: Json.parse({ exitCode: 0, stdout: '> routes:tidy\nmoved docs/routes.md to docs/routing.md\nadded 1 route', stderr: '', changes: BASH_CHANGES }) },
    });
    this.#add(chat.id, { turn: first, author: AGENT, role: 'assistant', status: 'done', createdAt: now - 380_000, runs: [ran.id], parts: [{ type: 'text', text: 'Done. It changed five files; the diffs are under the command.' }] });
    const second = mintId('turn');
    this.#add(chat.id, { turn: second, author: this.#owner(), role: 'user', status: 'done', createdAt: now - 60_000, parts: [{ type: 'text', text: 'Set up the env file with my key.' }] });
    const asked = this.#run(chat.id, second, QualifiedName.parse('fs/bash'), { command: FLAGGED_COMMAND }, AGENT, undefined, 'awaiting-approval');
    this.runs.set(asked.id, { ...asked, createdAt: now - 50_000 });
    const approval = fixture(Approval, { id: 'apr_env_setup', run: asked.id, fn: asked.fn, approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: now - 50_000, preview: FLAGGED_PREVIEW });
    this.approvals.set(approval.id, { approval, resume: () => { this.#settle(chat.id, asked.id, 'done'); } });
    this.#add(chat.id, { turn: second, author: AGENT, role: 'assistant', status: 'done', createdAt: now - 45_000, runs: [asked.id], parts: [{ type: 'text', text: 'This touches your env file and a key, so it waits for you.' }] });
  }

  #seed(): void {
    const now = this.#now();
    const router = this.create('Refactor the router');
    const notes = this.create('Meeting notes, Thursday');
    const budget = this.create('Why did the build get slower?');
    this.sessions.set(router.id, { ...router, id: router.id, updatedAt: now - 120_000 });
    this.sessions.set(notes.id, { ...notes, updatedAt: now - DAY - 3_600_000 });
    this.sessions.set(budget.id, { ...budget, updatedAt: now - 3 * DAY });
    this.#seedQueries(now);
    this.#seedInstall(now);
    this.#seedWidgets(now);
    this.#seedChanges(now);
    const turn = mintId('turn');
    const refused = this.#refused(router.id, turn, 'fs/read_file', RunId.parse('run_agent'));
    this.runs.set(refused.id, { ...refused, startedAt: now - DAY - 62_000, endedAt: now - DAY - 62_000 });
    const read = this.#run(router.id, turn, 'fs/read_file', { path: 'packages/web/src/app/routes.ts' }, AGENT);
    const edit = this.#run(router.id, turn, 'fs/edit', { path: 'packages/web/src/app/routes.ts', find: 'props: true', replace: 'meta: { group: \'chat\' }' }, AGENT);
    for (const [run, ms] of [[read, 640], [edit, 1_820]] as const) {
      this.runs.set(run.id, { ...run, status: 'done', startedAt: now - DAY - 60_000, endedAt: now - DAY - 60_000 + ms, cost: 0.0004, totalCost: 0.0004, outcome: { status: 'done', result: 'ok' } });
    }
    this.#call(router.id, turn, read.id);
    this.#add(router.id, {
      turn, author: this.#owner(), role: 'user', status: 'done', createdAt: now - DAY - 90_000,
      parts: [
        { type: 'text', text: 'Can you make the chat routes share one page so switching sessions keeps it mounted? Look at ' },
        { type: 'mention', provider: 'fs/files', label: 'routes.ts', target: { path: 'packages/web/src/app/routes.ts' }, text: 'the file routes.ts' },
        ...extras(),
      ],
    });
    this.#add(router.id, {
      turn, author: AGENT, role: 'assistant', status: 'done', createdAt: now - DAY - 80_000, runs: [refused.id, read.id, edit.id],
      parts: [{ type: 'text', text: 'Done. All three chat routes now carry `meta.group = \'chat\'`, and the shell keys the page by group:\n\n```ts\n<component :is="Component" :key="shown.meta.group ?? shown.path" />\n```\n\n| Route | Group |\n|---|---|\n| `/chat` | chat |\n| `/chat/:session` | chat |\n| `/chat/:session/turn/:turn/tree` | chat |' },
        { type: 'attachment', attachment: 'fs/diff', title: 'Edited packages/web/src/app/routes.ts', data: { path: 'packages/web/src/app/routes.ts', before: 'props: true', after: "meta: { group: 'chat' }" } },
        { type: 'link', link: { resource: 'file:///repo/packages/web/src/app/routes.ts', title: 'routes.ts' } },
        { type: 'link', link: { url: 'https://router.vuejs.org/guide/essentials/passing-props', title: 'Passing props to route components' } },
      ],
    });
    this.#add(router.id, { turn: mintId('turn'), author: 'act_hub', role: 'note', status: 'done', createdAt: now - 3_600_000, parts: [{ type: 'text', text: 'notes went offline. Its fns are unavailable until it reconnects.' }] });
    // build 4: a form's answers (hidden unless in debug mode), then an answer whose call missed the prompt cache
    const later = mintId('turn');
    const form = RunId.parse('run_trip_form');
    this.#add(router.id, {
      turn: later, author: this.#owner(), role: 'user', status: 'done', createdAt: now - 1_900_000,
      parts: [{ type: 'input-answer', run: form, title: 'Route groups', value: { groups: ['chat'], keepMounted: true }, text: 'Groups: chat\nKeep mounted: yes' }],
    });
    this.#add(router.id, {
      turn: later, author: AGENT, role: 'assistant', status: 'done', createdAt: now - 1_800_000, cacheMiss: { call: ModelCallId.parse('mdl_cache_miss'), at: now - 1_800_000 },
      parts: [{ type: 'text', text: 'Thanks. I kept the chat routes in one group and left the page mounted between sessions.' }],
    });
    this.#add(notes.id, { turn: mintId('turn'), author: this.#owner(), role: 'user', status: 'done', createdAt: now - DAY - 3_600_000, parts: [{ type: 'text', text: 'Sum up Thursday’s meeting notes.' }] });
  }
}

/** What the hub adds to a message by itself: the local time and what the index suggested. */
function extras(): MessagePart[] {
  return [
    { type: 'extra', extra: 'local-time', blocks: [{ type: 'text', tag: 'local-time', text: '2026-11-07T09:30:00-05:00' }] },
    { type: 'extra', extra: 'suggested-context', blocks: [{ type: 'suggest-context', items: [{ context: 'fs/docs', why: 'The message asks about the design' }] }] },
    { type: 'extra', extra: 'suggested-fns', blocks: [{ type: 'suggest-fns', items: [{ fn: 'fs/read_file', why: 'Reads the file it mentions' }, { fn: 'fs/tree' }] }, { type: 'load', fns: ['fs/edit'] }] },
  ];
}

