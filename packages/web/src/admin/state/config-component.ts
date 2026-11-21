/**
 * A system's own config component (build 7, `Manifest.configComponent`): a Vue component its client build exports by
 * name, drawn on the review, system and pairing pages instead of or beside the gin form. Each build is imported once
 * (by its URL, which carries its hash), after the chat's Vue and SDK are shared with it; its default export (the
 * system's renderers) is registered too, so the component's `client` can send the system's actions.
 *
 * The component gets `ConfigViewProps` and emits `change` with a new value; the page saves it, and the hub still
 * checks it against the config type.
 *
 * A build runs as the admin looking at it, so one is imported only once an admin approved it (`SystemReview.clientApproved`:
 * the system went live, or the change to its build was approved); until then the page says so, and the hub would not
 * serve it anyway.
 */
import type { ClientAssets, ConfigComponentDecl, GinTypeDef, Json, SystemName, SystemReview } from '@harness/core';
import type { ContractShape, SystemClient } from '@harness/sdk';
import { isClientModule, type ClientRuntime } from '@harness/sdk/client';
import { markRaw, type Component } from 'vue';
import { clientFileUrl } from '../logic/review.ts';

/** What a system's config component is given. */
export interface ConfigViewProps {
  /** The config as saved now; undefined before one is set. */
  readonly config: Json | undefined;
  /** The config's gin type. */
  readonly type: GinTypeDef;
  /** The problems gin finds with a value (none when it fits); the hub checks again when it is saved. */
  readonly validate: (value: Json) => readonly string[];
  /** The system's client, for live checks such as trying a connection. */
  readonly client: SystemClient<ContractShape>;
}

/** Where a system's config component is: its client build, the export the contract names, and whether it may load. */
export interface ConfigComponentRef {
  readonly system: SystemName;
  readonly client: Pick<ClientAssets, 'hash' | 'entry'>;
  readonly decl: ConfigComponentDecl;
  /** Whether an admin approved this build; an unapproved one is never imported. */
  readonly approved: boolean;
}

/** What a page shows in place of a config component whose build isn't approved yet. */
export const UNAPPROVED_CONFIG = 'Its settings page loads once you approve it.';

/** What loading needs: importing a build, sharing the app's modules first, and the runtime its renderers join. */
export interface ConfigComponentDeps {
  readonly import: (url: string) => Promise<unknown>;
  readonly share: () => Promise<void>;
  readonly runtime: Pick<ClientRuntime, 'register' | 'systemClient'>;
}

/** Whether a value can be drawn as a Vue component: a component's options object or a function. */
function isComponent(value: unknown): value is Component {
  return typeof value === 'function' || (typeof value === 'object' && value !== null);
}

/** Systems' config components, each build imported once. */
export class ConfigComponents {
  readonly #deps: ConfigComponentDeps;
  readonly #builds = new Map<string, Promise<Readonly<Record<string, unknown>>>>();
  #shared: Promise<void> | undefined;

  constructor(deps: ConfigComponentDeps) {
    this.#deps = deps;
    // passed to components as a prop: never wrapped in a reactive proxy, which can't reach its private fields
    markRaw(this);
  }

  /** The component a contract names, or a readable error when its build doesn't export it. */
  async load(ref: ConfigComponentRef): Promise<Component> {
    if (!ref.approved) { throw new Error(UNAPPROVED_CONFIG); }
    const exports = await this.#build(clientFileUrl(ref.system, ref.client));
    const component = exports[ref.decl.component];
    if (!isComponent(component)) { throw new Error(`${ref.system}'s client build has no config component named ${ref.decl.component}.`); }
    return component;
  }

  /** What a system's component calls back into the system with. */
  client(system: SystemName): SystemClient<ContractShape> {
    return this.#deps.runtime.systemClient(system);
  }

  #build(url: string): Promise<Readonly<Record<string, unknown>>> {
    const known = this.#builds.get(url);
    if (known !== undefined) { return known; }
    const loading = this.#import(url);
    this.#builds.set(url, loading);
    loading.catch(() => { this.#builds.delete(url); });
    return loading;
  }

  async #import(url: string): Promise<Readonly<Record<string, unknown>>> {
    this.#shared ??= this.#deps.share();
    await this.#shared;
    const loaded = await this.#deps.import(url);
    if (typeof loaded !== 'object' || loaded === null) { throw new Error(`${url} is not a module.`); }
    const exports: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(loaded));
    const main = exports['default'];
    if (isClientModule(main)) { this.#deps.runtime.register(main); }
    return exports;
  }
}

/** The app's loader, one per set of stores (made the first time a page asks). */
const LOADERS = new WeakMap<object, ConfigComponents>();

/** The config components loader of the app whose chat renderers `chat` holds. */
export function configComponentsOf(chat: { readonly renderers: { readonly runtime: ClientRuntime } }): ConfigComponents {
  const known = LOADERS.get(chat);
  if (known !== undefined) { return known; }
  const made = new ConfigComponents({
    import: async (url) => { const loaded: unknown = await import(/* @vite-ignore */ url); return loaded; },
    share: async () => { (await import('../../chat/shared.ts')).shareChatModules(); },
    runtime: chat.renderers.runtime,
  });
  LOADERS.set(chat, made);
  return made;
}

/** Where a reviewed contract's own config component is, when it names one and ships a client build. */
export function configTarget(review: Pick<SystemReview, 'manifest' | 'clientApproved'>): ConfigComponentRef | undefined {
  const { name, client, configComponent } = review.manifest;
  return client === undefined || configComponent === undefined ? undefined : { system: name, client, decl: configComponent, approved: review.clientApproved === true };
}
