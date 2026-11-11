/**
 * The system side of the link: every `systemLinkSpec` endpoint the hub calls, typed by the spec. Each handler checks
 * what it receives against the contract's gin types, runs the implementation with the context it is owed, and
 * encodes what it returns. Connection, handshake and lifecycle live in the host; this class only answers the hub.
 */
import { implement, reject, server, type Server } from '@ayepi/core';
import {
  EXPORT_NOT_READY, systemLinkSpec,
  type ActorId, type ConfigValue, type DeliveryId, type HookBlock, type Json, type KindDescription, type MentionHover,
  type MentionOption as WireMentionOption, type ResourceRead, type ResourceUri, type RunId, type RunInfo, type Section, type SessionId,
  type StopReason, type SystemEvent, type SystemLinkSpec, type TimeInfo, type UndoOutcome, type UserInfo, type ValidateAnswer, type ValidateRequest, type PreviewAnswer, type PreviewRequest,
} from '@harness/core';
import type { ActionCtx, AskerCtx, SystemCtx, UndoCtx } from '../ctx.ts';
import { hookBlock, type KindCheckCtx, type MentionCtx } from '../declare.ts';
import { g, wireType, type GinType } from '../gin.ts';
import type { ConfigOf, ContractShape } from '../system.ts';
import type { LocalContent } from './content.ts';
import { HubLlm } from './llm.ts';
import type { ScopedLog } from './log.ts';
import { ProviderServer } from './providers.ts';
import { HubResources } from './resources.ts';
import { HubTypes } from './types.ts';
import { runReporting, servicesFor, type RunEnvironment, type Track } from './run.ts';
import type { RunRegistry } from './runs.ts';
import { fleets, fnSearch, proposals } from './asks.ts';
import { LinkState, stateRecordType } from './state.ts';
import type { SystemTable } from './table.ts';
import { decode, decodeOrThrow, encodeOrThrow, messageOf, thrownError, withTimeout } from './wire.ts';

/** The system's config: every version the hub sent that is still kept, so a run keeps the value it started with. */
export class ConfigStore<Cfg> {
  readonly #type: GinType<Cfg>;
  readonly #keep: number;
  readonly #versions = new Map<number, { value: Cfg }>();
  #current: { version: number; value: Cfg } | undefined;

  constructor(type: GinType<Cfg>, keep: number) {
    this.#type = type;
    this.#keep = keep;
    // a contract whose config type accepts `{}` (one that declares no config) is usable before the hub sends any
    const empty = decode(type, {}, 'The config');
    if (empty.ok) { this.#set(0, empty.value); }
  }

  /** The current value, if a valid one is set. */
  get current(): { version: number; value: Cfg } | undefined { return this.#current; }

  /** The value of a version still kept. */
  at(version: number): { value: Cfg } | undefined {
    return this.#versions.get(version);
  }

  /** Take a value from the hub; returns the previous current one. Throws if it doesn't fit the config type. */
  apply(config: ConfigValue): { previous: { version: number; value: Cfg } | undefined } {
    const previous = this.#current;
    this.#set(config.version, decodeOrThrow(this.#type, config.value, 'The config'));
    return { previous };
  }

  /** A previous value the hub sent along, checked; `undefined` when it doesn't fit (the type changed). */
  check(value: Json): Cfg | undefined {
    const checked = decode(this.#type, value, 'The previous config');
    return checked.ok ? checked.value : undefined;
  }

  #set(version: number, value: Cfg): void {
    this.#versions.set(version, { value });
    this.#current = { version, value };
    for (const kept of this.#versions.keys()) {
      if (this.#versions.size <= this.#keep) { break; }
      if (kept !== version) { this.#versions.delete(kept); }
    }
  }
}

/** What the runtime asks of the host for the endpoints that change the process. */
export interface HostControls {
  /** The pairing was approved: say hello again. */
  paired(): void;
  restart(reason: string): void;
  stop(reason: StopReason, timeout: number): Promise<void>;
  /** The hub changed the config (it is already applied). */
  configured(previous: unknown): Promise<void>;
}

/** Everything the system side needs. */
export interface RuntimeParts<C extends ContractShape> {
  readonly table: SystemTable;
  readonly runs: RunRegistry;
  readonly env: RunEnvironment;
  readonly config: ConfigStore<ConfigOf<C>>;
  readonly content: LocalContent;
  readonly host: HostControls;
  /** Aborts when the system stops. */
  readonly signal: AbortSignal;
  /** Longest resource text sent inline. */
  readonly inlineText: number;
}

/** A `{{name}}` placeholder in static context content. */
const ARG_PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** The person a request is for, as the hub sends it. */
export interface AskerWire {
  session?: SessionId | undefined;
  actor: ActorId;
  user: UserInfo;
  time: TimeInfo;
}

/** Answers the hub's calls on the system link. */
export class SystemRuntime<C extends ContractShape> {
  readonly #parts: RuntimeParts<C>;
  readonly #log: ScopedLog;
  readonly #watches = new Map<string, () => void>();
  readonly #providers: ProviderServer;

  constructor(parts: RuntimeParts<C>) {
    this.#parts = parts;
    this.#log = parts.env.log;
    this.#providers = new ProviderServer({
      defs: parts.table.contract.defs.providers,
      impls: parts.table.impl.providers ?? {},
      ctx: () => this.systemCtx(),
      configVersion: () => parts.config.current?.version,
    });
  }

  /** The system's context for hooks, mentions, actions, context, events and lifecycle events. */
  systemCtx(signal: AbortSignal = this.#parts.signal): SystemCtx<ConfigOf<C>> {
    const env = this.#parts.env;
    const current = this.#parts.config.current;
    if (current === undefined) { throw reject(409, 'NEEDS_CONFIG', `${env.system} has no valid config yet.`); }
    return {
      ...env.place,
      system: env.system,
      config: current.value,
      llm: new HubLlm({ hub: env.hub, content: env.content }, signal),
      resources: new HubResources(env.hub, env.content, { signal }),
      types: new HubTypes(env.hub, signal),
      log: this.#log,
      signal,
      ...proposals({ system: env.system, hub: env.hub, signal }),
      ...fleets(env.hub, signal),
      ...fnSearch(env.hub, undefined, signal),
    };
  }

  /** The `systemLinkSpec` server the link serves back to the hub. */
  server(): Server<SystemLinkSpec> {
    const { table, runs, host } = this.#parts;
    const impl = table.impl;
    return server(systemLinkSpec, [implement(systemLinkSpec).handlers({
      paired: () => { host.paired(); },
      run: ({ data }) => runs.run(data),
      control: ({ data }) => runs.control(data.run, data.action),
      undo: ({ data }) => this.#undo(data),
      handler: ({ data }) => runs.answer(data.run, data.key, data.handler, data.args),
      child: ({ data }) => { runs.child(data.parent, data.key, data.run, data.update); },
      check: ({ data }) => this.#check(data.kind, data.payload),
      context: async ({ data, signal }) => ({ text: await this.contextText(data.name, data.args, data, signal) }),
      roots: () => this.#resources().roots(),
      list: ({ data }) => this.#resources().list(data.uri, data.cursor),
      stat: async ({ data }) => {
        const stat = await this.#resources().stat(data.uri);
        return stat === undefined ? {} : { stat };
      },
      read: async ({ data }) => this.#inline(await this.#resources().read(data.uri, data.want)),
      sections: ({ data, signal }) => this.#sections(data.sectioner, data.uri, signal),
      watch: ({ data }) => { this.#watch(data.uris, data.on); },
      content: ({ data }) => {
        const chunk = this.#parts.content.chunk(data.ref, data.offset, data.length);
        if (chunk === undefined) { throw reject(404, 'NOT_FOUND', `Content ${data.ref.hash} is not held here.`); }
        return { chunk };
      },
      embed: async ({ data }) => {
        const embed = impl.embedders?.[data.embedder];
        if (embed === undefined) { throw reject(404, 'NOT_FOUND', `No embedder ${data.embedder}.`); }
        return { vectors: await embed(data.texts) };
      },
      hook: async ({ data, signal }) => {
        const hook = impl.hooks?.[data.hook];
        if (hook === undefined) { throw reject(404, 'NOT_FOUND', `No hook ${data.hook}.`); }
        const blocks: HookBlock[] = (await hook(data.message, this.systemCtx(signal))).map(hookBlock);
        return blocks;
      },
      mentions: async ({ data, signal }) => {
        const { provider, def } = this.#mention(data.provider);
        const options = await provider.search(data.query, this.#mentionCtx(data, signal));
        return options.map((option): WireMentionOption => ({
          label: option.label,
          ...(option.hint === undefined ? {} : { hint: option.hint }),
          ...(option.icon === undefined ? {} : { icon: option.icon }),
          target: encodeOrThrow(def.target, option.target, `A ${data.provider} mention target`),
        }));
      },
      mentionHover: async ({ data, signal }) => {
        const { provider, def } = this.#mention(data.provider);
        const hover = await provider.hover(decodeOrThrow(def.target, data.target, 'The mention target'), this.#mentionCtx(data, signal));
        if (hover === undefined) { return {}; }
        const { value, ...rest } = hover;
        const wire: MentionHover = { ...rest, ...(value === undefined || def.of === undefined ? {} : { value: encodeOrThrow(def.of, value, `The ${def.of.name} value`) }) };
        return { hover: wire };
      },
      mentionText: async ({ data, signal }) => {
        const { provider, def } = this.#mention(data.provider);
        return { text: await provider.llm(decodeOrThrow(def.target, data.target, 'The mention target'), this.#mentionCtx(data, signal)) };
      },
      event: ({ data }) => this.#event(data),
      action: ({ data, signal }) => this.#action(data, signal),
      form: ({ data }) => { runs.form(data.run, data.value); },
      restart: ({ data }) => { host.restart(data.reason); },
      stop: ({ data }) => host.stop(data.reason, data.timeout),
      configure: async ({ data }) => {
        const { previous } = this.#parts.config.apply(data);
        const before = data.previous === undefined ? previous?.value : this.#parts.config.check(data.previous) ?? previous?.value;
        await host.configured(before);
      },
      export: ({ data }) => this.#export(data.timeout),
      validate: ({ data, signal }) => this.#validate(data, signal),
      preview: ({ data, signal }) => this.#preview(data, signal),
      // Build 6 stub (hub lane): answer from the kind's cost hook once the SDK has one; no estimate means "use history".
      estimate: () => ({}),
      providerChat: ({ data, signal }) => this.#providers.chat(data, signal),
      providerEmbed: ({ data, signal }) => this.#providers.embed(data, signal),
      connectStart: ({ data, signal }) => this.#connect().start(data, this.systemCtx(signal)),
      connectFinish: ({ data, signal }) => this.#connect().finish(data, this.systemCtx(signal)),
      disconnect: ({ data, signal }) => this.#connect().disconnect(data, this.systemCtx(signal)),
    })]);
  }

  /** Stop every resource watch. */
  unwatchAll(): void {
    for (const stop of this.#watches.values()) { stop(); }
    this.#watches.clear();
  }

  /** Send to the hub without waiting; failures are logged. */
  #background(log: ScopedLog): Track {
    const hub = this.#parts.env.hub;
    const signal = this.#parts.signal;
    return (send) => { hub.ready(signal).then(send).catch((error: unknown) => { log.warn('report.failed', { error: messageOf(error) }); }); };
  }

  // ─── Endpoints ──────────────────────────────────────────────────────────────

  /**
   * Get ready for the hub to copy the data folder: `lifecycle.exporting` within the timeout, then where the folder is.
   * A failure or a timeout refuses the export (`EXPORT_NOT_READY`), since a copy made meanwhile might not be whole.
   */
  async #export(timeout: number): Promise<{ data: string }> {
    const env = this.#parts.env;
    const lifecycle = this.#parts.table.impl.lifecycle;
    if (lifecycle?.exporting !== undefined) {
      let finished: boolean;
      try {
        finished = await withTimeout(lifecycle.exporting({ ...this.systemCtx(), timeout }), timeout);
      } catch (error) {
        env.log.error('system.exporting-failed', {}, error);
        throw reject(500, EXPORT_NOT_READY, `${env.system} could not get its data ready: ${messageOf(error)}`);
      }
      if (!finished) {
        env.log.warn('system.exporting-slow', { timeout });
        throw reject(500, EXPORT_NOT_READY, `${env.system} did not get its data ready within ${timeout} ms.`);
      }
    }
    return { data: env.place.dataDir };
  }

  async #undo(data: { run: RunInfo; fn: string; kind: string; fnPayload?: Json | undefined; payload: Json }): Promise<UndoOutcome> {
    const { table, env } = this.#parts;
    const ctx = this.#undoCtx(data.run);
    try {
      const target = table.target(data.fn, data.kind);
      if (typeof target === 'string') { return { status: 'failed', error: thrownError(new Error(target)) }; }
      switch (target.kind) {
        case 'native':
        case 'method': {
          const type = target.def.undo;
          if (target.impl.undo === undefined || type === undefined) { return { status: 'gone' }; }
          return await target.impl.undo(decodeOrThrow(type, data.payload, 'The undo payload'), ctx);
        }
        case 'kind': {
          if (target.impl.undo === undefined) { return { status: 'gone' }; }
          return await target.impl.undo(decodeOrThrow(target.def.payload, data.fnPayload, 'The fn payload'), data.payload, ctx);
        }
      }
    } catch (error) {
      env.log.warn('undo.failed', { fn: data.fn, error: messageOf(error) });
      return { status: 'failed', error: thrownError(error) };
    }
  }

  /**
   * What a run waiting for approval would do: the fn's (or its kind's) `preview`. A fn with no preview to give
   * refuses, since the hub only asks for fns that declared one.
   */
  async #preview(data: PreviewRequest, signal: AbortSignal): Promise<PreviewAnswer> {
    const target = this.#parts.table.target(data.fn, data.kind ?? 'native');
    if (typeof target === 'string') { throw reject(404, 'NOT_FOUND', target); }
    const ctx = { ...this.systemCtx(signal), run: data.run, user: data.user };
    switch (target.kind) {
      case 'native': {
        if (target.impl.preview === undefined) { return { refused: `${data.fn} has no preview.` }; }
        return await target.impl.preview(decodeOrThrow(target.def.args, data.args, 'The args'), ctx);
      }
      case 'kind': {
        if (target.impl.preview === undefined) { return { refused: `Fns of kind ${target.kindName} have no preview.` }; }
        return await target.impl.preview(decodeOrThrow(target.def.payload, data.payload, 'The payload'), data.args, ctx);
      }
      case 'method':
        return { refused: `Method ${data.fn} has no preview.` };
    }
  }

  /**
   * Run a fn's validation hook: its args (and for output, its result) checked against its types, its declared session
   * state as it is now, and the system context with the run. A fn without the hook asked for passes.
   */
  async #validate(data: ValidateRequest, signal: AbortSignal): Promise<ValidateAnswer> {
    const { table, env } = this.#parts;
    // a contract fn of any kind (an agent's answer is checked here too); a method or a native fn through its target
    const declared = table.fnDef(data.fn);
    const target = declared !== undefined && declared.kind !== 'native' ? { kind: 'declared' as const, def: declared } : table.target(data.fn, 'native');
    if (typeof target === 'string') { throw reject(404, 'NOT_FOUND', target); }
    if (target.kind === 'kind') { return { ok: true }; }
    const { def } = target;
    const hooks = def.validate;
    if (hooks === undefined) { return { ok: true }; }
    const argsType = target.kind === 'method' ? target.argsType : def.args;
    const args = decodeOrThrow(argsType, data.args, 'The args');
    const stateType = stateRecordType(def.state);
    const state = stateType === undefined ? {} : await new LinkState(env.hub, { run: data.run.id }, stateType, { retries: env.stateRetries, signal }).get();
    const ctx = { ...this.systemCtx(signal), run: data.run, attempt: data.phase === 'output' ? data.attempt : 1 };
    if (data.phase === 'input') { return await hooks.input?.(ctx, args, state) ?? { ok: true }; }
    const result = decodeOrThrow(def.returns, data.result, 'The result');
    return await hooks.output?.(ctx, args, result, state) ?? { ok: true };
  }

  #undoCtx(run: RunInfo): UndoCtx {
    const env = this.#parts.env;
    const signal = this.#parts.signal;
    const log = env.log.with({ run: run.id, fn: run.fn, undo: true });
    const services = servicesFor(env, run.id, signal, log, this.#background(log));
    return { ...services, config: this.#parts.config.current?.value, run, signal };
  }

  async #check(kind: string, payload: Json): Promise<{ problems: string[]; description?: KindDescription }> {
    const def = this.#parts.table.contract.defs.kinds[kind];
    const impl = this.#parts.table.impl.kinds?.[kind];
    if (def === undefined || impl === undefined) { throw reject(404, 'NOT_FOUND', `No kind ${kind}.`); }
    const checked = decode(def.payload, payload, 'The payload');
    if (!checked.ok) { return { problems: [checked.error.message] }; }
    const ctx = this.#kindCheckCtx();
    const problems = await impl.check(checked.value, ctx);
    return problems.length > 0 ? { problems } : { problems, description: await impl.describe(checked.value, ctx) };
  }

  /** What a kind can look up while checking: named types known in this process, and this system's own fns. */
  #kindCheckCtx(): KindCheckCtx {
    const table = this.#parts.table;
    return {
      type: (name) => {
        const type = g.lookup(name);
        return Promise.resolve(type === undefined ? undefined : wireType(type));
      },
      fn: (name) => {
        const system = `${table.contract.name}/`;
        const def = name.startsWith(system) ? table.fnDef(name.slice(system.length)) : undefined;
        return Promise.resolve(def === undefined ? undefined : { args: wireType(def.args), returns: wireType(def.returns), description: def.description });
      },
    };
  }

  /**
   * A context's text for these args, for whoever is asking (the hub, or an MCP client getting a prompt). A command's
   * required args must be there. Static content has each declared arg's `{{name}}` filled in; dynamic content comes
   * from the implementation, which gets the args.
   */
  async contextText(name: string, args: Readonly<Record<string, string>>, asker: AskerWire, signal: AbortSignal): Promise<string> {
    const def = this.#parts.table.contract.defs.context[name];
    if (def === undefined) { throw reject(404, 'NOT_FOUND', `No context ${name}.`); }
    const declared = def.command?.args ?? {};
    for (const [arg, spec] of Object.entries(declared)) {
      if (spec.required && args[arg] === undefined) { throw reject(400, 'MISSING_ARG', `/${def.command?.name ?? name} needs ${arg}: ${spec.hint}`); }
    }
    if (def.content !== undefined) {
      return def.content.replace(ARG_PLACEHOLDER, (whole, arg: string) => (Object.hasOwn(declared, arg) ? args[arg] ?? '' : whole));
    }
    const impl = this.#parts.table.impl.context?.[name];
    if (impl === undefined) { throw reject(404, 'NOT_FOUND', `Context ${name} is not implemented.`); }
    const ctx = { ...this.systemCtx(signal), user: asker.user, time: asker.time, ...(asker.session === undefined ? {} : { session: asker.session }) };
    return impl({ ...args }, ctx);
  }

  #connect(): NonNullable<SystemTable['impl']['connect']> {
    const connect = this.#parts.table.impl.connect;
    if (connect === undefined) { throw reject(404, 'NOT_FOUND', `${this.#parts.env.system} is not a per-person system.`); }
    return connect;
  }

  #resources(): NonNullable<SystemTable['impl']['resources']> {
    const resources = this.#parts.table.impl.resources;
    if (resources === undefined) { throw reject(404, 'NOT_FOUND', `${this.#parts.env.system} serves no resources.`); }
    return resources;
  }

  /** Long text goes by ref, held here for the hub to fetch, so the frame stays small. */
  #inline(read: ResourceRead): ResourceRead {
    const text = read.text;
    if (text === undefined || !('inline' in text)) { return read; }
    const bytes = new TextEncoder().encode(text.inline);
    if (bytes.length <= this.#parts.inlineText) { return read; }
    return { ...read, text: { ref: this.#parts.content.put(bytes, 'text/plain; charset=utf-8') } };
  }

  async #sections(sectioner: string, uri: ResourceUri, signal: AbortSignal): Promise<Section[]> {
    const cut = this.#parts.table.impl.sectioners?.[sectioner];
    if (cut === undefined) { throw reject(404, 'NOT_FOUND', `No sectioner ${sectioner}.`); }
    const env = this.#parts.env;
    const resources = new HubResources(env.hub, env.content, { signal });
    const stat = await resources.stat(uri);
    if (stat === undefined) { throw reject(404, 'NOT_FOUND', `No resource ${uri}.`); }
    return cut(await resources.text(uri), stat);
  }

  #watch(uris: ResourceUri[], on: boolean): void {
    const key = JSON.stringify([...uris].sort());
    this.#watches.get(key)?.();
    this.#watches.delete(key);
    if (!on) { return; }
    const provider = this.#resources();
    if (provider.watch === undefined) { return; }
    const env = this.#parts.env;
    const stop = provider.watch(uris, (changes) => {
      const hub = env.hub.now();
      if (hub === undefined) {
        env.log.warn('resources.change-dropped', { count: changes.length });
        return;
      }
      hub.call('resourcesChanged', { changes }).catch((error: unknown) => { env.log.warn('resources.report-failed', { error: messageOf(error) }); });
    });
    this.#watches.set(key, stop);
  }

  #mention(name: string) {
    const def = this.#parts.table.contract.defs.mentions[name];
    const provider = this.#parts.table.impl.mentions?.[name];
    if (def === undefined || provider === undefined) { throw reject(404, 'NOT_FOUND', `No mention provider ${name}.`); }
    return { def, provider };
  }

  #mentionCtx(asker: AskerWire & { session: SessionId }, signal: AbortSignal): MentionCtx {
    const ask: AskerCtx = { session: asker.session, user: asker.user, time: asker.time };
    return { ...this.systemCtx(signal), ...ask };
  }

  async #event(event: SystemEvent): Promise<void> {
    const events = this.#parts.table.impl.events;
    if (events === undefined) { return; }
    const ctx = this.systemCtx();
    switch (event.type) {
      case 'message': return events.message?.(event, ctx);
      case 'run': return events.run?.(event, ctx);
      case 'resources': return events.resources?.(event, ctx);
      case 'system': return events.system?.(event, ctx);
      case 'fns': return events.fns?.(event, ctx);
    }
  }

  async #action(
    data: AskerWire & { session: SessionId; delivery: DeliveryId; action: string; input: Json; run?: RunId | undefined },
    signal: AbortSignal,
  ): Promise<{ result: Json }> {
    const def = this.#parts.table.contract.defs.actions[data.action];
    const impl = this.#parts.table.impl.actions?.[data.action];
    if (def === undefined || impl === undefined) { throw reject(404, 'NOT_FOUND', `No action ${data.action}.`); }
    const env = this.#parts.env;
    const log = env.log.with({ action: data.action, delivery: data.delivery });
    const ctx: ActionCtx<Record<string, unknown>> = {
      ...this.systemCtx(signal),
      log,
      session: data.session,
      user: data.user,
      time: data.time,
      files: env.files({ content: env.content, signal }),
      fetch: env.fetch,
      ...(data.run === undefined ? withoutRun : runReporting(env, data.run, signal, this.#background(log))),
      delivery: data.delivery,
      run: data.run,
      actor: data.actor,
      state: new LinkState<Record<string, unknown>>(env.hub, { delivery: data.delivery }, stateRecordType(def.state), { retries: env.stateRetries, signal }),
    };
    const result = await impl(decodeOrThrow(def.input, data.input, 'The action input'), ctx);
    return { result: encodeOrThrow(def.returns, result, 'The action result') };
  }
}

/** What an action sent from outside a run's renderer gets for the run-only services. */
const withoutRun: Pick<ActionCtx<object>, 'attach' | 'link' | 'setting'> = {
  attach: () => { throw new Error('attach needs a run; this action was not sent from a run\'s renderer.'); },
  link: () => { throw new Error('link needs a run; this action was not sent from a run\'s renderer.'); },
  setting: () => Promise.reject(new Error('Reading a setting needs a run; this action was not sent from a run\'s renderer.')),
};
