/**
 * The mock hub's chat: a few sessions with history across days, and a scripted agent. Sending a message streams an
 * answer token by token while a run reads a file (queued, running with progress, done, with its cost); a message
 * that asks to write something waits for approval first. `!` invocations run, undo reports, the tree, LLM calls,
 * mentions and their hover cards, limits and capabilities all answer from the same in-memory state, and every change
 * goes out on the session's channel as the real hub sends it. It is a stand-in for building the UI, not a hub.
 */
import {
  Approval, ChatCapabilities, ChatMessage, LlmInteraction, ResolvedLimits, Run, RunId, Session, mintId, type ActorId, type ApprovalId, type Json, type MessagePart, type OutgoingPart,
  type QualifiedName, type RunUpdate, type SessionEvent, type SessionId, type SessionSummary, type TreeNode, type TurnId,
} from '@harness/core';
import { summaryOf as summary } from '../src/chat/state/sessions.ts';

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

interface Script {
  readonly fn: QualifiedName;
  readonly args: Json;
  readonly approval: boolean;
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
    return ChatCapabilities.parse({
      voiceInput: false, voiceOutput: false, uploads: true,
      mentions: [{ provider: 'fs/files', title: 'Files' }],
      commands: [
        { name: 'tree', context: 'fs/tree', args: [{ name: 'root', hint: 'The folder to start from', required: false }], description: 'Show the project’s file tree' },
        { name: 'docs', context: 'fs/docs', args: [], description: 'Add the design docs to this chat' },
      ],
      invocations: [
        { fn: 'fs/read_file', description: 'Read a file', args: { name: 'obj', props: { path: { type: { name: 'text', options: { minLength: 1 } }, docs: 'Relative to the project root.' } } } },
        {
          fn: 'fs/edit', description: 'Replace text in a file',
          args: { name: 'obj', props: { path: { type: { name: 'text', options: { minLength: 1 } } }, find: { type: { name: 'text' } }, replace: { type: { name: 'text' } }, all: { type: { name: 'optional', generic: { T: { name: 'bool' } } } } } },
        },
      ],
      clients: [],
      systems: [{ name: 'fs', status: 'connected', enabled: true }, { name: 'embedder', status: 'connected', enabled: true }, { name: 'notes', status: 'disconnected', enabled: true }],
      models: [{ id: 'meta-llama/llama-3.3-8b-instruct:free', name: 'Llama 3.3 8B (free)' }],
    });
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
    const made = Session.parse({
      id: mintId('session'), title: title ?? 'New chat', owner: this.#owner(), agent: 'hub/chat',
      participants: [{ actor: this.#owner(), role: 'owner', notify: 'all', joinedAt: now }, { actor: AGENT, role: 'agent', notify: 'none', joinedAt: now }],
      systems: 'all', tools: [], context: [], status: 'idle', transcript: [], createdAt: now, updatedAt: now, archived: false,
    });
    this.sessions.set(made.id, made);
    this.messages.set(made.id, []);
    return made;
  }

  update(id: SessionId, change: Partial<Pick<Session, 'title' | 'archived' | 'systems'>> & { notify?: Session['participants'][number]['notify'] }): Session {
    const current = this.session(id);
    const { notify, ...rest } = change;
    const next: Session = {
      ...current, ...rest, updatedAt: this.#now(),
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
    return ResolvedLimits.parse({
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
    const write = /write|save|change/i.test(text);
    setTimeout(() => { this.#answer(id, turn, { fn: write ? 'fs/write_file' : 'fs/read_file', args: { path: write ? 'notes/summary.md' : 'docs/harness.md' }, approval: write }); }, 250);
    return { turn, message };
  }

  invoke(id: SessionId, fn: QualifiedName, args: Json): { turn: TurnId; run: RunId } {
    const turn = mintId('turn');
    const run = this.#run(id, turn, fn, args, this.#owner());
    this.#add(id, { turn, author: this.#owner(), role: 'user', status: 'done', parts: [{ type: 'invocation', run: run.id, fn }], runs: [run.id] });
    this.#progress(id, run.id, () => undefined);
    return { turn, run: run.id };
  }

  approve(id: ApprovalId, approve: boolean): Approval {
    const waiting = this.approvals.get(id);
    if (waiting === undefined) { throw new Error(`no approval ${id}`); }
    const decided = Approval.parse({ ...waiting.approval, status: approve ? 'approved' : 'denied', decisions: [{ by: this.#owner(), approve, remember: 'once', at: this.#now() }] });
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

  #answer(id: SessionId, turn: TurnId, script: Script): void {
    const agentRun = mintId('run');
    this.#setStatus(id, 'running');
    const run = this.#run(id, turn, script.fn, script.args, AGENT, agentRun, script.approval ? 'awaiting-approval' : 'queued');
    const call = this.#call(id, turn, agentRun);
    const answer = this.#add(id, { turn, author: AGENT, role: 'assistant', status: 'streaming', parts: [{ type: 'text', text: '' }], runs: [run.id] });
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
    if (script.approval) {
      const approval = Approval.parse({ id: mintId('approval'), run: run.id, fn: run.fn, approver: { by: 'turn-user' }, status: 'pending', decisions: [], createdAt: this.#now() });
      this.approvals.set(approval.id, { approval, resume: () => { this.#progress(id, run.id, stream); } });
      this.#emit(id, { type: 'approval', approval });
      return;
    }
    this.#progress(id, run.id, stream);
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
        : update.type === 'cost' ? { ...current, cost: update.cost, totalCost: update.total } : { ...current, allowed: update.operations };
    this.runs.set(run, next);
    this.#emit(id, { type: 'run', run, fn: current.fn, update });
  }

  #setStatus(id: SessionId, status: Session['status']): void {
    const current = this.session(id);
    const next = { ...current, status, updatedAt: this.#now() };
    this.sessions.set(id, next);
    this.#emit(id, { type: 'session', session: summary(next) });
  }

  #run(session: SessionId, turn: TurnId, fn: QualifiedName, args: Json, caller: string, parent?: RunId, status: Run['status'] = 'queued'): Run {
    const id = mintId('run');
    const run = Run.parse({
      id, fn, fnVersion: '1', kind: 'native', system: fn.split('/')[0], root: parent ?? id, ...(parent === undefined ? {} : { parent }), turn, session, key: id,
      actor: this.#owner(), caller, args, status, allowed: { cancel: true, pause: false, background: true }, cost: 0, totalCost: 0, priority: 'interactive',
      background: false, attempt: 1, errors: [], stateChanges: [], createdAt: this.#now(),
    });
    this.runs.set(id, run);
    this.#emit(session, { type: 'run', run: id, fn, update: { type: 'status', status } });
    return run;
  }

  #call(session: SessionId, turn: TurnId, run: RunId): LlmInteraction {
    const call = LlmInteraction.parse({
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

  #add(id: SessionId, fields: Pick<ChatMessage, 'turn' | 'author' | 'role' | 'status' | 'parts'> & Partial<Pick<ChatMessage, 'runs' | 'replyTo' | 'createdAt'>>): ChatMessage {
    const message = ChatMessage.parse({ id: mintId('message'), session: id, runs: [], replyAll: false, answerers: [], createdAt: this.#now(), ...fields });
    this.messages.set(id, [...(this.messages.get(id) ?? []), message]);
    this.#emit(id, { type: 'message', message });
    return message;
  }

  #patchMessage(id: SessionId, message: ChatMessage['id'], change: (m: ChatMessage) => ChatMessage): void {
    this.messages.set(id, (this.messages.get(id) ?? []).map((m) => (m.id === message ? change(m) : m)));
  }

  #seed(): void {
    const now = this.#now();
    const router = this.create('Refactor the router');
    const notes = this.create('Meeting notes, Thursday');
    const budget = this.create('Why did the build get slower?');
    this.sessions.set(router.id, { ...router, id: router.id, updatedAt: now - 120_000 });
    this.sessions.set(notes.id, { ...notes, updatedAt: now - DAY - 3_600_000 });
    this.sessions.set(budget.id, { ...budget, updatedAt: now - 3 * DAY });
    const turn = mintId('turn');
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
      turn, author: AGENT, role: 'assistant', status: 'done', createdAt: now - DAY - 80_000, runs: [read.id, edit.id],
      parts: [{ type: 'text', text: 'Done. All three chat routes now carry `meta.group = \'chat\'`, and the shell keys the page by group:\n\n```ts\n<component :is="Component" :key="shown.meta.group ?? shown.path" />\n```\n\n| Route | Group |\n|---|---|\n| `/chat` | chat |\n| `/chat/:session` | chat |\n| `/chat/:session/turn/:turn/tree` | chat |' }],
    });
    this.#add(router.id, { turn: mintId('turn'), author: 'act_hub', role: 'note', status: 'done', createdAt: now - 3_600_000, parts: [{ type: 'text', text: 'notes went offline. Its fns are unavailable until it reconnects.' }] });
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

