/**
 * `@harness/sdk/client`: the chat's runtime for system renderers. The chat (the web app) gives it a `ClientBridge` to
 * the hub, made of its own ayepi callers and state; the runtime does the rest:
 *
 * - **Loading.** `load(url)` imports a system's built client module from the hub. Bundles keep `vue` and
 *   `@harness/sdk` external (see `buildClient`): `shareModules({ vue, sdk })` hands them the chat's own copies, so
 *   renderers share the chat's Vue.
 * - **Lookup.** Renderers by fn (falling back to the fn's kind), attachment, input type, mention provider and resource
 *   format. Resource viewers are shared by format across systems.
 * - **Talking back.** `systemClient(name)` is what renderers get as `system`: `online`, live, and `send.<action>(input)`,
 *   whose input and result are checked with the contract's gin types. `submit(run, value)` sends a form the same way.
 *   Each send is a `Delivery` whose `status` is reactive.
 *
 * This module is browser code: it imports Vue and the SDK's contract builders, nothing from Node.
 */
import { DeliveryStatus, type DeliveryId, type Json, type QualifiedName, type RunId } from '@harness/core';
import { reactive, type Component } from 'vue';
import type { ClientModule, Delivery, SystemClient } from './client.ts';
import { encodeValue, parseValue, type GinType } from './gin.ts';
import type { ContractShape } from './system.ts';

/** How the runtime reaches the hub. The chat implements it with its callers and live state. */
export interface ClientBridge {
  /** Whether a system is connected now. Read inside reactive getters, so it should read reactive state. */
  online(system: string): boolean;
  /** Store an action with the hub; resolves with its delivery id. */
  act(input: { system: string; action: string; input: Json; run?: RunId }): Promise<DeliveryId>;
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

/** The renderer sections looked up by qualified name. */
type Section = 'fns' | 'kinds' | 'attachments' | 'inputs' | 'mentions';

/** A registered module with its contract types erased: renderers by section and local name, and its actions. */
interface Registered {
  readonly renderers: { readonly [S in Section]: Readonly<Record<string, AnyRenderer | undefined>> };
  readonly actions: ContractShape['actions'];
}

/** Erase a module's contract types. Every typed renderer is a Vue component, which is all the chat needs to mount it. */
function erase<C extends ContractShape>(module: ClientModule<C>): Registered {
  const r = module.renderers;
  return {
    renderers: { fns: r.fns ?? {}, kinds: r.kinds ?? {}, attachments: r.attachments ?? {}, inputs: r.inputs ?? {}, mentions: r.mentions ?? {} },
    actions: module.contract.defs.actions,
  };
}

/** The chat's registry of system renderers. */
export class ClientRuntime {
  readonly #bridge: ClientBridge;
  readonly #modules = new Map<string, Registered>();
  readonly #viewers = new Map<string, AnyRenderer>();
  readonly #clients = new Map<string, SystemClient<ContractShape>>();

  constructor(bridge: ClientBridge) {
    this.#bridge = bridge;
  }

  /** Register a system's module. A newer one for the same system replaces it. */
  register<C extends ContractShape>(module: ClientModule<C>): void {
    this.#modules.set(module.system, erase(module));
    this.#clients.delete(module.system);
    const viewers: Readonly<Record<string, AnyRenderer>> = module.renderers.resources ?? {};
    for (const [format, viewer] of Object.entries(viewers)) { this.#viewers.set(format, viewer); }
  }

  /** Import a system's built module from its URL and register it. */
  async load(url: string): Promise<ClientModule> {
    const loaded: unknown = await import(/* @vite-ignore */ url);
    const module = typeof loaded === 'object' && loaded !== null && 'default' in loaded ? loaded.default : undefined;
    if (!isClientModule(module)) { throw new Error(`${url} is not a system client module (its default export should be client(contract, renderers)).`); }
    this.register(module);
    return module;
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

  /** The viewer for a resource format, from whichever system registered one. */
  resourceViewer(format: string): AnyRenderer | undefined {
    return this.#viewers.get(format);
  }

  /** What a system's renderers get as `system`. */
  systemClient(system: string): SystemClient<ContractShape> {
    const known = this.#clients.get(system);
    if (known !== undefined) { return known; }
    const module = this.#modules.get(system);
    const bridge = this.#bridge;
    const send = Object.fromEntries(Object.entries(module?.actions ?? {}).map(([action, def]) => [
      action,
      (input: unknown) => this.#deliver((json) => parseValue(def.returns, json), () => bridge.act({ system, action, input: encodeValue(def.input, input) })),
    ]));
    const client: SystemClient<ContractShape> = { get online() { return bridge.online(system); }, send };
    this.#clients.set(system, client);
    return client;
  }

  /** Submit a run's form: the value is checked with the fn's form type. */
  submit<T>(run: RunId, form: GinType<T>, value: T): Delivery<void> {
    const encoded = encodeValue(form, value);
    return this.#deliver(() => undefined, () => this.#bridge.submit({ run, value: encoded }));
  }

  #lookup(name: QualifiedName, section: Section): AnyRenderer | undefined {
    const at = name.indexOf('/');
    return this.#modules.get(name.slice(0, at))?.renderers[section][name.slice(at + 1)];
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
