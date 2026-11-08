/**
 * A test rig for the execution module: the whole module built over in-memory fakes of the other modules (store, bus,
 * catalog, link with a real in-process peer, chat turns and presence), a scripted aeye provider behind the real hub
 * AI (so the hooks reserve, settle and record for real), and helpers to declare fns and start turns. Tests only.
 */
import type { Chunk, Request, Response } from '@aeye/core';
import { getResponseFromChunks } from '@aeye/core';
import type { ModelInfo, Provider } from '@aeye/ai';
import { implement, peers as linkPeers, server, spec, client, type ClientWs, type WsConn } from '@ayepi/core';
import { memoryStore as rateMemory } from '@ayepi/rate';
import { memoryBackend } from '@ayepi/work';
import { fnDecl, type AnyFnDef } from '@harness/sdk';
import {
  ActorId, MAIN_INSTANCE, MessageId, SystemName, mintId, noFnStats, systemLinkSpec,
  type ApprovalId, type RunId, type Approver, type ChatMessage, type ConfigValue, type FnRecord, type GinTypeDef, type HubLinkSpec, type Json, type MessagePart,
  type OutcomeWire, type ProviderKind, type QualifiedName, type ResolvedLimits, type RunRequest, type Session, type SessionId, type Turn,
  type TurnId, type TurnStatus, type UndoOutcome, type UserInfo, type RunControlAction, type SuggestionRecord,
} from '@harness/core';
import { z } from 'zod';
import { RecordingBus, testStore, memoryLog, settle } from '../testing.ts';
import type { Catalog, FnSignature } from '../catalog/index.ts';
import type { SystemConnection } from '../link/index.ts';
import { StoreModelCallLog } from '../metrics/calls.ts';
import { StoreFnMetrics } from '../metrics/fn-metrics.ts';
import { createContextor } from '../contextor/create.ts';
import type { Search } from '../index/index.ts';
import { contextorEnv } from '../contextor/env.ts';
import { createExecution, type ExecutionModule, type LlmSource } from './create.ts';
import { executionEnv } from './env.ts';
import type { ExecutionDeps, ExecutionSettings } from './ports.ts';

export { settle };

/** The admin the rig's turns are for. */
export const ALICE = ActorId.parse('act_alice');
/** The rig's chat agent actor. */
export const AGENT = ActorId.parse('act_agent');

/** The person every rig turn is for. */
export const ALICE_INFO: UserInfo = { id: ALICE, name: 'Alice', email: 'alice@example.com', role: 'admin', groups: [], timeZone: 'America/New_York', locale: 'en-US' };

/** Settings for tests: short timeouts, small limits. */
export function testSettings(
  overrides: Partial<ExecutionSettings['queue']> = {}, execution: Partial<ExecutionSettings['execution']> = {}, model = 'test-model', transcribe = '',
): ExecutionSettings {
  return {
    queue: {
      HARNESS_LLM_CONCURRENCY: 2, HARNESS_RUN_CONCURRENCY: 4, HARNESS_TOOL_TIMEOUT: 60_000, HARNESS_ACTIVE_WINDOW: 120_000,
      HARNESS_DEFAULT_PRIORITY: 'interactive', HARNESS_TURN_COST: 1, HARNESS_TURN_TIME: 600_000, HARNESS_BUDGET_MARGIN: 1.25, ...overrides,
    },
    model: { HARNESS_DEFAULT_MODEL: model, HARNESS_TRANSCRIBE_MODEL: transcribe },
    execution: { ...executionEnv.parse(), HARNESS_RUN_RETRY_BASE: 10, HARNESS_QUEUE_POLL: 5, ...execution },
  };
}

/** The configurable provider kind the scripted provider stands in for, so its models show on the admin pages. */
export const SCRIPTED_AS = 'openrouter' satisfies ProviderKind;

/** A model the scripted provider serves: $1 per million input tokens, $2 per million output. */
export const TEST_MODEL: ModelInfo = {
  id: 'test-model', provider: SCRIPTED_AS, name: 'Test model', tier: 'flagship', contextWindow: 100_000, maxOutputTokens: 4_000,
  capabilities: new Set(['chat', 'streaming', 'tools', 'json', 'structured']), pricing: { text: { input: 1, output: 2 } },
};

/**
 * One scripted reply: chunks to stream, or an error to throw before the first one, or a function that makes either
 * when the request arrives (to change the world between building a request and the model's answer, or to hold the
 * answer back until a test lets it go).
 */
export type ScriptedReply = Chunk[] | Error | (() => Chunk[] | Error | Promise<Chunk[] | Error>);

/** A reply that says some text. */
export function says(text: string, cost = 0.001): Chunk[] {
  const half = Math.ceil(text.length / 2);
  return [{ content: text.slice(0, half) }, { content: text.slice(half) }, { finishReason: 'stop', usage: { text: { input: 10, output: 5 }, cost } }];
}

/** A reply that calls tools: `[name, args]` pairs (tool names as the model sees them, `fs__read`). */
export function calls(tools: ReadonlyArray<readonly [string, Json]>, cost = 0.002): Chunk[] {
  const chunks: Chunk[] = [];
  tools.forEach(([name, args], i) => {
    const id = `call_${i + 1}`;
    chunks.push({ toolCallNamed: { id, name, arguments: '' } }, { toolCall: { id, name, arguments: JSON.stringify(args) } });
  });
  chunks.push({ finishReason: 'tool_calls', usage: { text: { input: 20, output: 10 }, cost } });
  return chunks;
}

/** An aeye provider that streams scripted replies, in order, and keeps every request it was sent. */
export class ScriptedProvider implements Provider<Record<string, never>> {
  readonly name = 'scripted';
  readonly config: Record<string, never> = {};
  readonly requests: Request[] = [];
  readonly replies: ScriptedReply[] = [];

  /** Queue replies. */
  script(...replies: ScriptedReply[]): this {
    this.replies.push(...replies);
    return this;
  }

  checkHealth(): Promise<boolean> {
    return Promise.resolve(true);
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([TEST_MODEL]);
  }

  createStreamer() {
    return (request: Request, _ctx: unknown, _metadata?: unknown, signal?: AbortSignal): AsyncGenerator<Chunk, Response> => this.#stream(request, signal);
  }

  async *#stream(request: Request, signal: AbortSignal | undefined): AsyncGenerator<Chunk, Response> {
    this.requests.push(request);
    const next = this.replies.shift();
    if (next === undefined) throw new Error('the scripted provider has no reply left');
    const reply = typeof next === 'function' ? await next() : next;
    if (reply instanceof Error) throw reply;
    for (const chunk of reply) {
      await Promise.resolve();
      if (signal?.aborted === true) break;
      yield chunk;
    }
    return getResponseFromChunks(reply, TEST_MODEL);
  }
}

/** A catalog over fns declared in the test, with signatures straight from their gin types. */
export class TestCatalog implements Catalog {
  readonly records = new Map<QualifiedName, FnRecord>();
  readonly signatures = new Map<QualifiedName, FnSignature>();
  readonly contexts = new Map<QualifiedName, string>();

  /** Declare a fn of a system. */
  add(system: string, name: string, def: AnyFnDef, extra: Partial<Pick<FnRecord, 'available' | 'paused' | 'disabled'>> = {}): FnRecord {
    const qualified: QualifiedName = `${system}/${name}`;
    const record: FnRecord = {
      name: qualified, system: SystemName.parse(system), decl: fnDecl(name, def), version: 'v1', origin: 'contract', available: true, paused: false, disabled: false,
      stats: noFnStats(), updatedAt: 0, ...extra,
    };
    this.records.set(qualified, record);
    const argsSchema = def.args.toValueSchema();
    this.signatures.set(qualified, {
      fn: qualified, args: def.args, returns: def.returns, argsSchema, returnsSchema: def.returns.toValueSchema(),
      argsJsonSchema: z.record(z.string(), z.unknown()).parse(z.toJSONSchema(argsSchema, { unrepresentable: 'any' })),
    });
    return record;
  }

  /** Change a declared fn. */
  set(name: QualifiedName, patch: Partial<FnRecord>): void {
    const record = this.records.get(name);
    if (record !== undefined) this.records.set(name, { ...record, ...patch });
  }

  fn(name: QualifiedName): Promise<FnRecord | undefined> {
    return Promise.resolve(this.records.get(name));
  }

  fns(filter: { system?: SystemName; names?: readonly QualifiedName[]; available?: boolean }): Promise<FnRecord[]> {
    return Promise.resolve([...this.records.values()].filter((r) =>
      (filter.system === undefined || r.system === filter.system)
      && (filter.names === undefined || filter.names.includes(r.name))
      && (filter.available !== true || r.available === true)));
  }

  signature(fn: QualifiedName): Promise<FnSignature> {
    const signature = this.signatures.get(fn);
    return signature === undefined ? Promise.reject(new Error(`no fn ${fn}`)) : Promise.resolve(signature);
  }

  context(name: QualifiedName): ReturnType<Catalog['context']> {
    const content = this.contexts.get(name);
    if (content === undefined) return Promise.resolve(undefined);
    const { system, local } = { system: name.slice(0, name.indexOf('/')), local: name.slice(name.indexOf('/') + 1) };
    return Promise.resolve({
      name, system: SystemName.parse(system), stale: false, updatedAt: 0, mentions: { context: [], fns: [] },
      decl: { name: local, description: local, content, imports: [], fns: [], suggestFns: [], suggest: 'both', visible: 'both', alwaysFor: [], tags: [] },
    });
  }

  check(_system: SystemName, _type: GinTypeDef, value: unknown): Promise<string[]> {
    return Promise.resolve(value === undefined ? ['missing'] : []);
  }

  availability(name: QualifiedName): ReturnType<Catalog['availability']> {
    return Promise.resolve(this.records.get(name)?.available ?? { unavailable: 'system-removed', detail: 'unknown' });
  }

  importManifest(): never { throw new Error('not in execution tests'); }
  importPatch(): never { throw new Error('not in execution tests'); }
  refreshAvailability(): never { throw new Error('not in execution tests'); }
  /** No kind records here: runs of kind fns are worded by their fn's status templates or the defaults. */
  kind(): ReturnType<Catalog['kind']> { return Promise.resolve(undefined); }
  /** No named types here: test fns use plain gin types. */
  type(): ReturnType<Catalog['type']> { return Promise.resolve(undefined); }
  typeClosure(names: readonly QualifiedName[]): ReturnType<Catalog['typeClosure']> { return Promise.resolve({ order: [], missing: [...names] }); }
  declare(): never { throw new Error('not in execution tests'); }
  reimport(): never { throw new Error('not in execution tests'); }
  manifest(): never { throw new Error('not in execution tests'); }
  /** No manifest entries here (no context names an agent in `alwaysFor`). */
  entries(): Promise<never[]> { return Promise.resolve([]); }
}

/** What a fake system does with the hub's requests, set per test. */
export interface SystemBehaviour {
  run: (request: RunRequest, signal: AbortSignal) => Promise<OutcomeWire>;
  control: (input: { run: string; action: RunControlAction }) => { accepted: boolean; reason?: string };
  undo: (input: { fn: string; payload: Json }) => UndoOutcome;
  handler: (input: { handler: string; args: Json; key: string }) => { ok: true; value: Json } | { ok: false; error: { class: 'caller'; message: string } };
}

/** A system connected to the rig over an in-process socket, serving `systemLinkSpec` for real. */
export class TestSystem {
  readonly name: SystemName;
  readonly requests: RunRequest[] = [];
  readonly children: Array<{ parent: string; key: string; run: string; update?: unknown }> = [];
  readonly behaviour: SystemBehaviour = {
    run: (request) => Promise.resolve({ status: 'done', result: { echo: request.args } }),
    control: () => ({ accepted: true }),
    undo: () => ({ status: 'undone', summary: 'put back' }),
    handler: (input) => ({ ok: true, value: `${input.handler}:yes` }),
  };
  conn: WsConn | undefined;
  readonly #controller = new AbortController();

  constructor(name: string, hub: ReturnType<typeof linkServer>) {
    this.name = SystemName.parse(name);
    const notHere = (): never => { throw new Error('not served in execution tests'); };
    const local = server(systemLinkSpec, [implement(systemLinkSpec).handlers({
      run: ({ data, signal }) => { this.requests.push(data); return this.behaviour.run(data, signal); },
      control: ({ data }) => this.behaviour.control(data),
      undo: ({ data }) => this.behaviour.undo(data),
      handler: ({ data }) => this.behaviour.handler(data),
      child: ({ data }) => { this.children.push(data); },
      paired: notHere, check: notHere, context: notHere, roots: notHere, list: notHere, stat: notHere, read: notHere, sections: notHere, watch: notHere,
      content: notHere, embed: notHere, hook: notHere, mentions: notHere, mentionHover: notHere, mentionText: notHere, event: notHere, action: notHere,
      form: notHere, restart: notHere, stop: notHere, configure: notHere, export: notHere,
    })]);
    let deliver: (frame: string) => void = () => undefined;
    const states = new Set<(state: 'closed' | 'connecting' | 'open') => void>();
    const ws: ClientWs = {
      send: (frame) => { if (this.conn !== undefined) void hub.app.ws.message(this.conn, frame); },
      onMessage: (cb) => { deliver = cb; },
      onState: (cb) => { states.add(cb); return () => void states.delete(cb); },
    };
    client<HubLinkSpec>({ baseUrl: 'http://hub', manifest: spec({ endpoints: {} }), ws, serve: local, prefer: 'ws' });
    this.conn = hub.app.ws.open((frame) => { deliver(frame); }, new Request('http://hub/link'));
    for (const cb of states) cb('open');
  }

  /** The hub's view of this system's connection. */
  connection(hub: ReturnType<typeof linkServer>): SystemConnection {
    if (this.conn === undefined) throw new Error(`${this.name} is not connected`);
    return { system: this.name, instance: MAIN_INSTANCE, boot: 'test-1', connectedAt: 0, peer: hub.peers.of(this.conn), signal: this.#controller.signal };
  }
}

/** The hub side of the in-process link: a server with a peer registry, as boot makes it. */
export function linkServer() {
  const peers = linkPeers(systemLinkSpec);
  const app = server(spec({ endpoints: {} }), [], { peers });
  return { app, peers };
}

/** Everything the rig records from the chat side. */
export interface ChatRecord {
  readonly begun: ChatMessage[];
  readonly streamed: Array<{ message: MessageId; text?: string; reasoning?: string }>;
  readonly finished: Array<{ message: MessageId; parts: MessagePart[]; status: 'done' | 'failed' }>;
  readonly settled: Array<{ turn: TurnId; status: Exclude<TurnStatus, 'running' | 'paused' | 'undone'> }>;
  /** Runs recorded on assistant messages (`track`). */
  readonly tracked: Array<{ message: MessageId; runs: readonly RunId[] }>;
  readonly suggested: Array<{ message: MessageId; record: SuggestionRecord }>;
  /** Follow-up turns the agent loop asked for. */
  readonly followUps: Array<{ turn: TurnId; agent: ActorId }>;
}

/** Limits that let a turn spend up to $1 at interactive priority. */
export const OPEN_LIMITS: ResolvedLimits = { priority: 'interactive', priorityFrom: { default: 'hub' }, turn: { cost: 1, time: 600_000 }, budgets: [] };

/** Build the execution module over fakes. */
export async function executionRig(options: {
  settings?: ExecutionSettings; active?: boolean; llm?: LlmSource; search?: Pick<Search, 'search'>;
  /** How runs pick a fleet instance (default: the system's `main`, as with one connected instance). */
  instances?: ExecutionDeps['instances'];
} = {}) {
  const store = await testStore();
  const bus = new RecordingBus();
  const { log, records } = memoryLog();
  const time = { now: 1_000_000 };
  const clock = (): number => time.now;
  let counter = 0;
  const random = (): string => `${++counter}`;
  const catalog = new TestCatalog();
  const hub = linkServer();
  const systems = new Map<string, TestSystem>();
  const provider = new ScriptedProvider();
  const chat: ChatRecord = { begun: [], streamed: [], finished: [], settled: [], tracked: [], suggested: [], followUps: [] };
  const presence = { active: options.active ?? false };
  const configs = new Map<string, ConfigValue>();
  const approverSets = new Map<ApprovalId, ActorId[]>();
  const calls = new StoreModelCallLog({ store, clock, log, random });
  const metrics = new StoreFnMetrics({ store, bus, clock, log });
  // the real contextor over the rig's store and catalog, with an index that finds nothing
  const contextor = createContextor({
    store, catalog, search: options.search ?? { search: () => Promise.resolve([]) }, settings: contextorEnv.parse(), modelSettings: { HARNESS_DEFAULT_MODEL: 'test-model' },
    models: () => module.llm.models(), log, clock, probes: () => undefined,
  });

  const module: ExecutionModule = createExecution({
    settings: options.settings ?? testSettings(),
    log, clock, random, store, bus, catalog,
    link: { connection: (system) => { const found = systems.get(system); return found === undefined ? undefined : found.connection(hub); } },
    instances: options.instances ?? { route: ({ system }) => Promise.resolve({ instance: { system, instance: MAIN_INSTANCE } }) },
    config: { current: (system) => Promise.resolve(configs.get(system)) },
    roles: { resolve: () => Promise.resolve(undefined) },
    presence: { active: () => Promise.resolve(presence.active) },
    turns: {
      begin: async (input) => {
        const message: ChatMessage = {
          id: mintId('message', random), session: (await store.table('turns').get(input.turn))?.session ?? SESSION, turn: input.turn, author: input.author, role: 'assistant',
          parts: [], runs: [], status: 'streaming', replyAll: false, answerers: [], createdAt: clock(), ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        };
        chat.begun.push(message);
        return message;
      },
      stream: (message, delta) => { chat.streamed.push({ message, ...delta }); },
      finish: (message, parts, status) => {
        chat.finished.push({ message, parts, status });
        const begun = chat.begun.find((m) => m.id === message);
        if (begun === undefined) return Promise.reject(new Error(`no message ${message}`));
        return Promise.resolve({ ...begun, parts, status });
      },
      settle: (turn, status) => { chat.settled.push({ turn, status }); return Promise.resolve(); },
      track: (message, runs) => { chat.tracked.push({ message, runs }); return Promise.resolve(); },
      suggested: (message, record) => { chat.suggested.push({ message, record }); return Promise.resolve(); },
      followUp: (input) => { chat.followUps.push(input); return Promise.resolve(undefined); },
    },
    enrich: { render: (message) => message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') },
    approvers: { approvers: (approver: Approver, turnUser: ActorId) => Promise.resolve(approver.by === 'turn-user' ? [turnUser] : approver.by === 'actor' ? [approver.actor] : []) },
    ports: { work: memoryBackend(), rate: rateMemory() },
    calls, metrics, planner: contextor.planner,
    llm: options.llm ?? { providers: { [SCRIPTED_AS]: provider }, models: [TEST_MODEL] },
  });

  /** Connect a fake system. */
  const connect = (name: string): TestSystem => {
    const system = new TestSystem(name, hub);
    systems.set(name, system);
    return system;
  };

  /** A session with Alice and the agent, whose transcript the agent continues. */
  const session = async (patch: Partial<Session> = {}): Promise<Session> => store.table('sessions').insert({
    id: SESSION, title: 'Test', owner: ALICE, agent: 'tools/helper', participants: [], systems: 'all', tools: [], context: [], status: 'idle', transcript: [],
    createdAt: 0, updatedAt: 0, archived: false, ...patch,
  });

  /** A turn for Alice, optionally in a session with a user message. */
  const turn = async (input: { session?: SessionId; text?: string; limits?: ResolvedLimits } = {}): Promise<Turn> => {
    const id = mintId('turn', random);
    const message = input.text === undefined || input.session === undefined ? undefined : MessageId.parse(`msg_user_${id}`);
    if (message !== undefined && input.session !== undefined) {
      await store.table('messages').insert({
        id: message, session: input.session, turn: id, author: ALICE, role: 'user', parts: [{ type: 'text', text: input.text ?? '' }], runs: [], status: 'done',
        replyAll: false, answerers: [AGENT], createdAt: clock(),
      });
    }
    return store.table('turns').insert({
      id, actor: ALICE, user: ALICE_INFO, time: { now: clock(), timeZone: ALICE_INFO.timeZone, local: '' }, status: 'running', limits: input.limits ?? OPEN_LIMITS,
      cost: 0, errors: 'feed-back', createdAt: clock(), ...(input.session === undefined ? {} : { session: input.session }), ...(message === undefined ? {} : { message }),
    });
  };

  return { module, store, bus, log, records, time, catalog, provider, chat, presence, configs, approverSets, connect, session, turn, hub, calls, metrics };
}

export type ExecutionRig = Awaited<ReturnType<typeof executionRig>>;

/** The rig's one session id. */
export const SESSION = mintId('session', () => 'test');

/** Wait until a condition holds (polling the event loop), or fail after a while. */
export async function until(condition: () => boolean | Promise<boolean>, what = 'the condition', timeout = 3_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await settle(5);
  }
}

