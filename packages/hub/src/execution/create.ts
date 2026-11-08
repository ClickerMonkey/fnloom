/**
 * Builds the execution module from the other modules' interfaces: the ledger and limits over the store, the
 * policies, the two queues, the run service with its three executors (systems, the hub's own fns, the agent loop),
 * the hub AI with its hooks, the gateway systems forward LLM calls through, the handler relay, and the link
 * endpoints it serves. `executionModule` is the same as a boot `ModuleFactory`.
 */
import type { ModelInfo, Providers } from '@aeye/ai';
import { plugin } from '@ayepi/plugin';
import { hubLinkSpec, type ActorId } from '@harness/core';
import { spec } from '@ayepi/core';
import type { HubServices, ModuleFactory } from '../boot/index.ts';
import { AeyeLlm, createHubAi, HubAiHooks, modelLimiter, SwitchingLlm } from './ai.ts';
import { HubAgentLoop, type AgentLoopDeps } from './agent.ts';
import { HubFns, SystemExecutor } from './executors.ts';
import { HubLlmGateway } from './gateway.ts';
import { HandlerRelay } from './handlers.ts';
import { registerRunFns } from './hub-fns.ts';
import { InteractionRecorder } from './interactions.ts';
import { HubLedger } from './ledger.ts';
import { HubLimitResolver } from './limits.ts';
import { ChildRelay, executionLinkHandlers, type ExecutionLinkEndpoints, type LinkHandler } from './link-handlers.ts';
import { ModelResolver } from './models.ts';
import { RunDeciders } from './deciders.ts';
import { HubPolicyEngine } from './policies.ts';
import { StoredProviders, type ProviderSource } from './providers.ts';
import type { ProviderService } from './index.ts';
import type { ExecutionDeps, LlmEngine } from './ports.ts';
import { ExecutionQueues, type QueuePorts } from './queues.ts';
import { HubRunService } from './runs.ts';
import { LedgerSpend } from './spend.ts';
import { messageOf } from './errors.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';

/**
 * How the module reaches models: the stored provider records (the hub), fixed providers for the hub AI (tests and
 * live checks), or (in tests) an engine built on the hooks.
 */
export type LlmSource =
  | { readonly stored: ProviderSource; readonly models?: ModelInfo[] }
  | { readonly providers: Providers; readonly models?: ModelInfo[] }
  | { readonly engine: (hooks: HubAiHooks) => LlmEngine };

/** The engine an `LlmSource` gives, and how its providers are reloaded. */
function engineOf(source: LlmSource, hooks: HubAiHooks, log: ExecutionInput['log']): { engine: LlmEngine; providers: ProviderService } {
  if ('engine' in source) return { engine: source.engine(hooks), providers: { reload: () => Promise.resolve() } };
  const models = source.models === undefined ? {} : { models: source.models };
  const engine = new SwitchingLlm((providers) => new AeyeLlm(createHubAi({ providers, hooks, log, ...models })), 'providers' in source ? source.providers : {});
  if (!('stored' in source)) return { engine, providers: { reload: () => Promise.resolve() } };
  return { engine, providers: { reload: async () => { engine.use(await source.stored.load()); } } };
}

/** What the module is built from. */
export interface ExecutionInput extends ExecutionDeps, Pick<AgentLoopDeps, 'enrich' | 'planner'> {
  /** The ayepi ports the queues and rate limits run on (the store's, in production). */
  readonly ports: QueuePorts;
  readonly llm: LlmSource;
}

/** The execution services every other module sees. */
type ExecutionServices = HubServices['execution'];

/** The execution module: its services, the extras other modules wire in, and its start and stop. */
export interface ExecutionModule extends ExecutionServices {
  readonly runs: HubRunService;
  readonly agents: HubAgentLoop;
  readonly handlers: HandlerRelay;
  /** The hub's own native fns: other modules register theirs here (`hub/search_fns`, …). */
  readonly hubFns: HubFns;
  /** The hub link endpoints execution serves, for the link server. */
  readonly linkHandlers: { [K in ExecutionLinkEndpoints]: LinkHandler<K> };
  /**
   * Start the queues, pick up agents that were waiting for tools and hub fn runs a stop cut short, relay child runs
   * to their callers, fold each settled run into its fn's metrics, post background tool runs' results to their
   * sessions as they finish, and send a system its unsettled runs again each time it is connected.
   */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Build the execution module. */
export function createExecution(input: ExecutionInput): ExecutionModule {
  const spend = new LedgerSpend(input.store);
  const ledger = new HubLedger(input, spend);
  const limits = new HubLimitResolver(input, spend);
  const policies = new HubPolicyEngine(input);
  const recorder = new InteractionRecorder(input);
  const queues: ExecutionQueues = new ExecutionQueues(input, input.ports, {
    run: (job, signal): Promise<void> => runs.execute(job, signal),
    llm: (job, signal): Promise<void> => agents.handle(job, signal),
  });
  const runs: HubRunService = new HubRunService({ ...input, policies, ledger, queues });
  policies.decideWith(new RunDeciders({ store: input.store, runs, ledger }));
  const hooks = new HubAiHooks({ ...input, ledger, recorder, costs: runs, calls: input.calls, modelLimit: modelLimiter(input.settings, input.ports.rate) });
  const { engine, providers } = engineOf(input.llm, hooks, input.log);
  const models = new ModelResolver(input);
  const agents: HubAgentLoop = new HubAgentLoop({ ...input, runs, queues, llm: engine, models });
  const hubFns = new HubFns();
  registerRunFns(hubFns, runs);
  runs.use('system', new SystemExecutor(input));
  runs.use('hub', hubFns);
  runs.use('agent', agents);
  const llm = new HubLlmGateway({ ...input, runs, queues, llm: engine, models });
  const handlers = new HandlerRelay({ ...input, runs });
  const relay = new ChildRelay(input);
  const stops: Array<() => void> = [];

  return {
    runs, agents, llm, limits, ledger, policies, handlers, hubFns, providers,
    linkHandlers: executionLinkHandlers({ ...input, runs, gateway: llm, handlers }),
    async start() {
      await providers.reload();
      queues.start();
      stops.push(runs.onSettled((run) => {
        void input.metrics.settled(run).catch((error: unknown) => { input.log.error('fn.metrics.failed', { run: run.id, fn: run.fn, error: messageOf(error) }); });
      }), runs.onSettled((run, settled) => {
        void agents.reportBack(run, settled).catch((error: unknown) => { input.log.error('agent.report-back-failed', { run: run.id, error: messageOf(error) }); });
      }));
      stops.push(relay.start(), input.bus.subscribe('system.status', ({ system, status }) => {
        if (status !== 'connected') return;
        void runs.resend(system).catch((error: unknown) => { input.log.error('run.resend-failed', { system, error: messageOf(error) }); });
      }));
      await agents.recover();
      await runs.resend(HUB_SYSTEM);
      await runs.watchDeadlines();
      input.log.info('execution.started', {});
    },
    async stop() {
      for (const stop of stops.splice(0)) stop();
      runs.drain();
      await queues.stop();
      input.log.info('execution.stopped', {});
    },
  };
}

/** The slice of the hub link execution serves: the same endpoint objects, so its types are the spec's. */
export const EXECUTION_LINK_SPEC = spec({
  endpoints: {
    call: hubLinkSpec.endpoints.call,
    handle: hubLinkSpec.endpoints.handle,
    control: hubLinkSpec.endpoints.control,
    progress: hubLinkSpec.endpoints.progress,
    allow: hubLinkSpec.endpoints.allow,
    undoWith: hubLinkSpec.endpoints.undoWith,
    llm: hubLinkSpec.endpoints.llm,
  },
});

/**
 * The hub's providers: its stored records, keys revealed from the api module's vault (reached lazily), seeded once
 * from the bootstrap OpenRouter key.
 */
function storedProviders(hub: HubServices, owner: ActorId): StoredProviders {
  const key = hub.settings.modelEnv.OPENROUTER_API_KEY;
  return new StoredProviders({
    store: hub.store, log: hub.log, clock: () => hub.clock(),
    secrets: { store: (input) => hub.api.secrets.store(input), reveal: (id) => hub.api.secrets.reveal(id) },
    seed: key === undefined ? undefined : { key, owner },
  });
}

/** The prompt planner the agent loop calls, as a delegate that looks the contextor module up on each call. */
export function contextorPorts(hub: Pick<HubServices, 'contextor'>): Pick<ExecutionInput, 'planner'> {
  return {
    planner: {
      plan: (input) => hub.contextor.planner.plan(input),
      interpret: (call, prompt) => hub.contextor.planner.interpret(call, prompt),
      exposed: (exposures, to) => hub.contextor.planner.exposed(exposures, to),
      settled: (input) => hub.contextor.planner.settled(input),
    },
  };
}

/** The chat services execution uses. */
export type ChatPorts = Pick<ExecutionInput, 'presence' | 'turns' | 'enrich' | 'approvers'>;

/**
 * The chat services execution uses, as delegates that look chat up on each call, so building execution never builds
 * chat (chat, in turn, uses execution).
 */
export function chatPorts(hub: Pick<HubServices, 'chat'>): ChatPorts {
  return {
    presence: { active: (session) => hub.chat.sessions.active(session) },
    turns: {
      begin: (input) => hub.chat.turns.begin(input),
      stream: (message, delta) => { hub.chat.turns.stream(message, delta); },
      finish: (message, parts, status) => hub.chat.turns.finish(message, parts, status),
      settle: (turn, status) => hub.chat.turns.settle(turn, status),
      track: (message, runs) => hub.chat.turns.track(message, runs),
      followUp: (input) => hub.chat.turns.followUp(input),
    },
    enrich: { render: (message) => hub.chat.enrich.render(message) },
    approvers: { approvers: (approver, turnUser) => hub.chat.approvers.approvers(approver, turnUser) },
  };
}

/** The metrics services execution feeds, as delegates that look the metrics module up on each call. */
export function metricsPorts(hub: Pick<HubServices, 'metrics'>): Pick<ExecutionInput, 'calls' | 'metrics'> {
  return {
    calls: { begin: (site, queuedAt) => hub.metrics.calls.begin(site, queuedAt), get: (id) => hub.metrics.calls.get(id), list: (query) => hub.metrics.calls.list(query) },
    metrics: { settled: (run) => hub.metrics.fns.settled(run) },
  };
}

/** The execution module as a boot module factory. Other modules are reached lazily (`chatPorts`). */
export function executionModule(options: {
  /** Where models come from; defaults to OpenRouter with the key in the model env slice. */
  readonly llm?: (hub: HubServices) => LlmSource;
  /** Implement the hub fns other modules provide, on the module's `HubFns` (called once it is built). */
  readonly hubFns?: (module: ExecutionModule, hub: HubServices) => void;
} = {}): ModuleFactory<'execution'> {
  return ({ hub, hubActor }) => {
    const settings = { queue: hub.settings.queueEnv, model: hub.settings.modelEnv, execution: hub.settings.executionEnv };
    const module = createExecution({
      settings,
      log: hub.log,
      clock: () => hub.clock(),
      store: hub.store,
      bus: hub.bus,
      catalog: hub.catalog,
      link: hub.link.connections,
      instances: hub.link.instances,
      config: hub.link.config,
      ...chatPorts(hub),
      ...contextorPorts(hub),
      ...metricsPorts(hub),
      ports: hub.store.ports,
      llm: options.llm?.(hub) ?? { stored: storedProviders(hub, hubActor) },
    });
    options.hubFns?.(module, hub);
    return {
      services: module,
      hooks: { work: { up: () => module.start(), pre: () => module.stop() } },
      linkPlugins: [plugin({ name: 'execution', spec: EXECUTION_LINK_SPEC }).handlers(() => module.linkHandlers)],
    };
  };
}
