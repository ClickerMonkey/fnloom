/**
 * `@harness/sdk/client`: the chat's runtime for system renderers. The chat (the web app) gives it a `ClientBridge` to
 * the hub, made of its own ayepi callers and state; the runtime does the rest:
 *
 * - **Loading.** `load(url)` imports a system's built client module from the hub. Bundles keep `vue` and
 *   `@harness/sdk` external (see `buildClient`): `shareModules({ vue, sdk })` hands them the chat's own copies, so
 *   renderers share the chat's Vue.
 * - **Lookup.** Renderers by fn (falling back to the fn's kind), attachment, input type, mention provider and resource
 *   format. Resource viewers are shared by format across systems.
 * - **Views.** `fnView`, `attachmentView`, `inputView` and `mentionView` build a renderer's props from the wire
 *   (JSON) form the chat holds, decoded with the contract's own gin types, so a renderer gets exactly the values its
 *   typed view promises (a timestamp as a `Date`). A custom input's edits are encoded back the same way. A value that
 *   doesn't fit its type gets no view, so the chat draws its default instead.
 * - **Talking back.** `systemClient(name)` is what renderers get as `system`: `online`, live, `send.<action>(input)`,
 *   whose input and result are checked with the contract's gin types, and `run.<fn>(args)`, which starts a run of one
 *   of the system's fns in the session, its args checked the same way. `submit(run, value)` sends a form the same way.
 *   Each send is a `Delivery` whose `status` is reactive.
 *
 * This module is browser code: it imports Vue and the SDK's contract builders, nothing from Node.
 */
import { ObjType } from '@aeye/gin';
import { DeliveryStatus, QualifiedName, qualify, type DeliveryId, type Json, type ResultTable, type RunId, type VisualFit } from '@harness/core';
import { reactive, type Component } from 'vue';
import type { AnyViews, ClientModule, Delivery, InputMount, Mount, ResourceViewerEntry, ResourceViewerMode, SystemClient, VisualOption, WireViews } from './client.ts';
import { encodeValue, parseValue, type GinType } from './gin.ts';
import type { ContractShape } from './system.ts';

export type { VisualOption } from './client.ts';

/** How the runtime reaches the hub. The chat implements it with its callers and live state. */
export interface ClientBridge {
  /** Whether a system is connected now. Read inside reactive getters, so it should read reactive state. */
  online(system: string): boolean;
  /** Store an action with the hub; resolves with its delivery id. */
  act(input: { system: string; action: string; input: Json; run?: RunId }): Promise<DeliveryId>;
  /** Start a run of a fn in the session, as `!fn` does; resolves with the run's id. */
  invoke(input: { fn: QualifiedName; args: Json }): Promise<RunId>;
  /** Store a form submission for a waiting run; resolves with its delivery id. */
  submit(input: { run: RunId; value: Json }): Promise<DeliveryId>;
  /** Follow a delivery: `status` on every change; resolves with its result once done, rejects when it fails or expires. */
  follow(delivery: DeliveryId, status: (status: DeliveryStatus) => void): Promise<Json>;
}

/** The global the chat's shared modules live under, so separately built bundles find them. */
export const SHARED_MODULES = Symbol.for('harness.shared');

/** The modules a system bundle imports from the chat instead of bundling its own copies. */
export interface SharedModules {
  readonly vue: object;
  readonly sdk: object;
}

/** Give system bundles the chat's Vue and SDK. Call once, before the first `load`. */
export function shareModules(modules: SharedModules): void {
  Reflect.set(globalThis, SHARED_MODULES, { vue: modules.vue, '@harness/sdk': modules.sdk });
}

/** Whether a value is a client module (what `client()` returns). */
export function isClientModule(value: unknown): value is ClientModule {
  return typeof value === 'object' && value !== null && 'system' in value && typeof value.system === 'string'
    && 'renderers' in value && typeof value.renderers === 'object' && value.renderers !== null
    && 'contract' in value && typeof value.contract === 'object' && value.contract !== null;
}

/** Any renderer, as the chat mounts it. Its props were checked against the contract when the system was built. */
export type AnyRenderer = Component;

/** A system's viewer for one resource format, as the chat offers it beside (or instead of) its own. */
export interface SystemResourceViewer {
  readonly component: AnyRenderer;
  /** The system whose viewer it is; its client is the viewer's `system`. */
  readonly system: string;
  readonly mode: ResourceViewerMode;
  /** The mode's name in the viewer's switch. */
  readonly label: string;
}

/** Whether a resource viewer registration came with its mode (`{ component, mode }`) rather than as a bare component. */
function isViewerEntry(value: AnyRenderer | ResourceViewerEntry<AnyRenderer>): value is ResourceViewerEntry<AnyRenderer> {
  return typeof value === 'object' && 'component' in value && 'mode' in value;
}

/** The renderer sections looked up by qualified name. */
type Section = 'fns' | 'kinds' | 'attachments' | 'inputs' | 'mentions';

/** A registered module with its contract types erased: renderers by section and local name, and its actions. */
interface Registered {
  readonly renderers: { readonly [S in Section]: Readonly<Record<string, AnyRenderer | undefined>> };
  readonly actions: ContractShape['actions'];
  readonly fns: ContractShape['fns'];
  /** Each fn's declared form type, by local name; undefined for a fn without one. */
  readonly forms: Readonly<Record<string, GinType | undefined>>;
  /** Each attachment's data type, by local name. */
  readonly attachments: Readonly<Record<string, GinType | undefined>>;
  /** Each named type's shape, by local name. */
  readonly types: Readonly<Record<string, GinType | undefined>>;
  /** Each mention provider's target type, by local name. */
  readonly mentions: Readonly<Record<string, GinType | undefined>>;
  /** Its own config component, when the contract names one. */
  readonly config: RegisteredConfig | undefined;
}

/** A system's config component with its contract types erased. */
interface RegisteredConfig {
  readonly component: AnyRenderer;
  readonly mode: ConfigMount['mode'];
  readonly type: GinType;
}

/** What the config page hands the runtime: the stored config and its own save path, in JSON. */
export interface ConfigWire {
  readonly config: Json | undefined;
  /** The hub's check of a candidate config; the problems, empty when it fits. */
  validate(value: Json): Promise<string[]>;
  /** The edited config, for the page to save. */
  change(value: Json): void;
}

/** A system's config component as a config page mounts it, and whether it replaces the gin form or sits beside it. */
export interface ConfigMount extends Mount<'config'> {
  readonly mode: 'replace' | 'beside';
}

/** Each entry's gin type, picked out of a contract section. */
function typesOf<D>(section: Readonly<Record<string, D>>, pick: (def: D) => GinType): Record<string, GinType> {
  return Object.fromEntries(Object.entries(section).map(([name, def]) => [name, pick(def)]));
}

/** A system's name and an entry's local name, from `system/local`. */
function split(name: QualifiedName): { readonly system: string; readonly local: string } {
  const at = name.indexOf('/');
  return { system: name.slice(0, at), local: name.slice(at + 1) };
}

/**
 * A fn's session state fields decoded with its state type. The chat holds only the fields that are set, so an object
 * state is decoded field by field; anything else is decoded whole.
 */
function decodeState(type: GinType | undefined, state: Readonly<Record<string, Json>>): Record<string, unknown> {
  if (type === undefined) { return {}; }
  if (!(type instanceof ObjType)) {
    const whole = parseValue(type, state);
    return typeof whole === 'object' && whole !== null ? { ...whole } : {};
  }
  const fields: Readonly<Record<string, { readonly type: GinType } | undefined>> = type.fields;
  return Object.fromEntries(Object.entries(state).flatMap(([key, value]) => {
    const field = fields[key];
    return field === undefined ? [] : [[key, parseValue(field.type, value)]];
  }));
}

/** Erase a module's contract types. Every typed renderer is a Vue component, which is all the chat needs to mount it. */
function erase<C extends ContractShape>(module: ClientModule<C>): Registered {
  const r = module.renderers;
  return {
    renderers: { fns: r.fns ?? {}, kinds: r.kinds ?? {}, attachments: r.attachments ?? {}, inputs: r.inputs ?? {}, mentions: r.mentions ?? {} },
    config: configOf(module),
    actions: module.contract.defs.actions,
    fns: module.contract.defs.fns,
    forms: Object.fromEntries(Object.entries(module.contract.defs.fns).map(([name, def]) => [name, def.form])),
    attachments: typesOf(module.contract.defs.attachments, (def) => def.data),
    types: typesOf(module.contract.defs.types, (def) => def.shape),
    mentions: typesOf(module.contract.defs.mentions, (def) => def.target),
  };
}

/** A module's config component, its mode and the config type, when the contract names one. */
function configOf<C extends ContractShape>(module: ClientModule<C>): RegisteredConfig | undefined {
  const decl = module.contract.configComponent;
  const component = decl === undefined ? undefined : module.renderers.configs?.[decl.component];
  return decl === undefined || component === undefined ? undefined : { component, mode: decl.mode, type: module.contract.defs.config };
}

/** A visual that fits some data, as a registry's result view lists it: who adds it, its name, its fit, and how to mount it. */

/** One loaded visual, with its contract types erased. */
interface LoadedVisual {
  readonly system: string;
  readonly name: string;
  readonly label: string;
  readonly icon: string | undefined;
  match(table: ResultTable): VisualFit;
  readonly component: Component;
}

/** The chat's registry of system renderers. */
export class ClientRuntime {
  readonly #visuals = new Map<QualifiedName, readonly LoadedVisual[]>();
  readonly #bridge: ClientBridge;
  readonly #modules = new Map<string, Registered>();
  readonly #viewers = new Map<string, readonly SystemResourceViewer[]>();
  readonly #clients = new Map<string, SystemClient<ContractShape>>();

  constructor(bridge: ClientBridge) {
    this.#bridge = bridge;
  }

  /** Register a system's module. A newer one for the same system replaces it. */
  register<C extends ContractShape>(module: ClientModule<C>): void {
    this.#modules.set(module.system, erase(module));
    for (const key of this.#clients.keys()) { if (key === module.system || key.startsWith(`${module.system} `)) { this.#clients.delete(key); } }
    for (const [format, list] of this.#viewers) { this.#viewers.set(format, list.filter((viewer) => viewer.system !== module.system)); }
    for (const [registry, list] of this.#visuals) { this.#visuals.set(registry, list.filter((visual) => visual.system !== module.system)); }
    for (const [registry, entries] of Object.entries(module.renderers.visuals ?? {})) {
      const key = QualifiedName.parse(registry);
      const added = Object.entries(entries).map(([name, entry]): LoadedVisual => {
        // client() checked that every visual is in the contract's contributes
        const declared = module.contract.contributes.find((c) => c.registry === key && c.name === name);
        return { system: module.system, name, label: declared?.label ?? name, icon: declared?.icon, match: (table) => entry.match(table), component: entry.component };
      });
      this.#visuals.set(key, [...(this.#visuals.get(key) ?? []), ...added]);
    }
    const viewers: Readonly<Record<string, AnyRenderer | ResourceViewerEntry<AnyRenderer>>> = module.renderers.resources ?? {};
    for (const [format, registered] of Object.entries(viewers)) {
      const viewer: SystemResourceViewer = isViewerEntry(registered)
        ? { component: registered.component, system: module.system, mode: registered.mode, label: registered.label ?? module.system }
        : { component: registered, system: module.system, mode: 'replace', label: module.system };
      this.#viewers.set(format, [...(this.#viewers.get(format) ?? []), viewer]);
    }
  }

  /** Import a system's built module from its URL and register it. */
  async load(url: string): Promise<ClientModule> {
    const loaded: unknown = await import(/* @vite-ignore */ url);
    const module = typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : undefined;
    if (!isClientModule(module)) { throw new Error(`${url} is not a system client module (its default export should be client(contract, renderers)).`); }
    this.register(module);
    return module;
  }

  /**
   * The visuals of a registry that fit a result, best fit first (the table, scoring lowest, comes last). A visual
   * whose match throws is left out, so one broken contribution can't take the result view down.
   */
  visuals(registry: QualifiedName, table: ResultTable): VisualOption[] {
    const fitting: VisualOption[] = [];
    for (const visual of this.#visuals.get(registry) ?? []) {
      let fit: VisualFit;
      try {
        fit = visual.match(table);
      } catch (error) {
        console.warn('client.visual.match-failed', { registry, system: visual.system, name: visual.name, error });
        continue;
      }
      if (fit.fits) {
        fitting.push({
          system: visual.system, name: visual.name, label: visual.label, ...(visual.icon === undefined ? {} : { icon: visual.icon }), fit, component: visual.component,
          props: { table, system: this.systemClient(visual.system) },
        });
      }
    }
    return fitting.sort((a, b) => b.fit.score - a.fit.score);
  }

  /** The systems with a registered module. */
  systems(): string[] {
    return [...this.#modules.keys()];
  }

  /** The renderer for runs of a fn, or of its kind when the fn has none. */
  fnRenderer(fn: QualifiedName, kind?: QualifiedName): AnyRenderer | undefined {
    const own = this.#lookup(fn, 'fns');
    return own ?? (kind === undefined ? undefined : this.#lookup(kind, 'kinds'));
  }

  attachmentRenderer(attachment: QualifiedName): AnyRenderer | undefined {
    return this.#lookup(attachment, 'attachments');
  }

  /** A custom input for a named type (`fs/Entry`). */
  inputRenderer(type: QualifiedName): AnyRenderer | undefined {
    return this.#lookup(type, 'inputs');
  }

  /** A custom hover card for a mention provider. */
  mentionRenderer(provider: QualifiedName): AnyRenderer | undefined {
    return this.#lookup(provider, 'mentions');
  }

  /**
   * Every system viewer for a resource format, in the order their systems loaded: the `replace` ones draw instead of
   * the hub's preview (the first wins), the `tab` ones are modes beside it.
   */
  resourceViewers(format: string): readonly SystemResourceViewer[] {
    return this.#viewers.get(format) ?? [];
  }

  /** The viewer that replaces the hub's preview for a resource format, if a system registered one. */
  resourceViewer(format: string): AnyRenderer | undefined {
    return this.#replacing(format)?.component;
  }

  /** The system whose viewer replaces the hub's preview for a resource format; its client is the viewer's `system`. */
  viewerSystem(format: string): string | undefined {
    return this.#replacing(format)?.system;
  }

  #replacing(format: string): SystemResourceViewer | undefined {
    return this.resourceViewers(format).find((viewer) => viewer.mode === 'replace');
  }

  /**
   * What a system's renderers get as `system`. A fn renderer passes its `run`, so its actions are sent from that run
   * (an action's state, such as the shell's working folder, is the run's session state).
   */
  systemClient(system: string, run?: RunId): SystemClient<ContractShape> {
    const key = run === undefined ? system : `${system} ${run}`;
    const known = this.#clients.get(key);
    if (known !== undefined) { return known; }
    const module = this.#modules.get(system);
    const bridge = this.#bridge;
    const from = run === undefined ? {} : { run };
    const send = Object.fromEntries(Object.entries(module?.actions ?? {}).map(([action, def]) => [
      action,
      (input: unknown) => this.#deliver((json) => parseValue(def.returns, json), () => bridge.act({ system, action, input: encodeValue(def.input, input), ...from })),
    ]));
    const runs = Object.fromEntries(Object.entries(module?.fns ?? {}).map(([fn, def]) => [
      fn,
      (args: unknown) => Promise.resolve().then(() => bridge.invoke({ fn: qualify(system, fn), args: encodeValue(def.args, args) })),
    ]));
    const client: SystemClient<ContractShape> = { get online() { return bridge.online(system); }, send, run: runs };
    this.#clients.set(key, client);
    return client;
  }

  /** Submit a run's form: the value is checked with the fn's form type. */
  submit<T>(run: RunId, form: GinType<T>, value: T): Delivery<void> {
    const encoded = encodeValue(form, value);
    return this.#deliver(() => undefined, () => this.#bridge.submit({ run, value: encoded }));
  }

  /**
   * What a fn's renderer gets as `submit`: sends its form to the run, checked with the fn's declared form type.
   * Undefined when the fn declares no form, or its system's module isn't loaded.
   */
  formSubmit(fn: QualifiedName, run: RunId): ((value: unknown) => Delivery<void>) | undefined {
    const { system, local } = split(fn);
    const form = this.#modules.get(system)?.forms[local];
    return form === undefined ? undefined : (value) => this.submit(run, form, value);
  }

  /**
   * A fn renderer and its props. The fn's own renderer gets the run decoded with the fn's gin types; a kind's renderer
   * (drawing fns it doesn't know) gets the JSON as it is, as its `FnView<UntypedFn>` says, and its own system's
   * client. Undefined when no renderer is loaded, or the run's values don't fit the fn's types.
   */
  fnView(wire: WireViews['fn']): Mount<'fn'> | undefined {
    const { fn, kind, args, result, state, ...rest } = wire;
    const own = this.#lookup(fn, 'fns');
    const base = { ...rest, submit: this.formSubmit(fn, wire.run) };
    if (own !== undefined) {
      const { system, local } = split(fn);
      const def = this.#modules.get(system)?.fns[local];
      if (def === undefined) { return undefined; }
      const decoded = this.#decode(fn, () => ({
        args: parseValue(def.args, args), state: decodeState(def.state, state), ...(result === undefined ? {} : { result: parseValue(def.returns, result) }),
      }));
      return decoded === undefined ? undefined : { component: own, props: { ...base, ...decoded, system: this.systemClient(system, wire.run) } };
    }
    const byKind = kind === undefined ? undefined : this.#lookup(kind, 'kinds');
    if (kind === undefined || byKind === undefined) { return undefined; }
    const props: AnyViews['fn'] = { ...base, args, state, ...(result === undefined ? {} : { result }), system: this.systemClient(split(kind).system, wire.run) };
    return { component: byKind, props };
  }

  /** An attachment's renderer, with its data decoded with the attachment's gin type. */
  attachmentView(wire: WireViews['attachment']): Mount<'attachment'> | undefined {
    const component = this.#lookup(wire.attachment, 'attachments');
    const { system, local } = split(wire.attachment);
    const type = this.#modules.get(system)?.attachments[local];
    if (component === undefined || type === undefined) { return undefined; }
    const data = this.#decode(wire.attachment, () => parseValue(type, wire.data));
    return data === undefined ? undefined : { component, props: { data, title: wire.title, system: this.systemClient(system) } };
  }

  /** A mention provider's hover card, with its target decoded with the provider's gin type. */
  mentionView(wire: WireViews['mention']): Mount<'mention'> | undefined {
    const component = this.#lookup(wire.provider, 'mentions');
    const { system, local } = split(wire.provider);
    const type = this.#modules.get(system)?.mentions[local];
    if (component === undefined || type === undefined) { return undefined; }
    const target = this.#decode(wire.provider, () => parseValue(type, wire.target));
    return target === undefined ? undefined : { component, props: { label: wire.label, target, hover: wire.hover, system: this.systemClient(system) } };
  }

  /**
   * A named type's custom input (`fs/Entry`): its component and system, and how values cross between the form's
   * JSON and what the input edits, both checked with the type's gin shape.
   */
  inputView(name: QualifiedName): InputMount | undefined {
    const component = this.#lookup(name, 'inputs');
    const { system, local } = split(name);
    const type = this.#modules.get(system)?.types[local];
    if (component === undefined || type === undefined) { return undefined; }
    return {
      component,
      props: { system: this.systemClient(system) },
      decode: (value) => (value === undefined ? undefined : this.#decode(name, () => parseValue(type, value))),
      encode: (value) => (value === undefined ? undefined : this.#decode(name, () => encodeValue(type, value))),
    };
  }

  /**
   * A system's own config component (`system({ configComponent })`), with props whose values cross between the page's
   * JSON and the component's typed config through the config's gin type. Undefined when the system has none.
   */
  configView(system: string, wire: ConfigWire): ConfigMount | undefined {
    const config = this.#modules.get(system)?.config;
    if (config === undefined) { return undefined; }
    const name = qualify(system, 'config');
    const type = config.type;
    return {
      component: config.component,
      mode: config.mode,
      props: {
        config: wire.config === undefined ? undefined : this.#decode(name, () => parseValue(type, wire.config)),
        type,
        validate: (value) => Promise.resolve().then(() => wire.validate(encodeValue(type, value))),
        change: (value) => wire.change(encodeValue(type, value)),
        system: this.systemClient(system),
      },
    };
  }

  /** Run a decode, or undefined (logged) when the value doesn't fit its type. */
  #decode<T>(name: QualifiedName, decode: () => T): T | undefined {
    try {
      return decode();
    } catch (error) {
      console.warn('client.view.unfit', { name, error });
      return undefined;
    }
  }

  #lookup(name: QualifiedName, section: Section): AnyRenderer | undefined {
    const { system, local } = split(name);
    return this.#modules.get(system)?.renderers[section][local];
  }

  /** Send, then follow the delivery to its result. `id` and `status` read reactive state, so renderers update. */
  #deliver<R>(decode: (json: Json) => R, send: () => Promise<DeliveryId>): Delivery<R> {
    const bridge = this.#bridge;
    const live = reactive<{ id: DeliveryId | undefined; status: DeliveryStatus }>({ id: undefined, status: DeliveryStatus.enum.queued });
    const result = send().then(async (id) => {
      live.id = id;
      return decode(await bridge.follow(id, (status) => { live.status = status; }));
    });
    result.catch(() => undefined);
    return { get id() { return live.id; }, get status() { return live.status; }, result };
  }
}
