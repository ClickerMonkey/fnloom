/**
 * Putting the services together. The base services (settings, log, clock, bus, store) and the api module's are made
 * by boot; every other module comes from its `ModuleFactory`. Modules are built on first use, so a factory that reads
 * another module gets it built first, and two modules that need each other while being built fail with a clear
 * error instead of seeing a half-made service.
 */
import type { Presigner, FileStore } from '@ayepi/files';
import type { Logger } from '@ayepi/log';
import { ACCESS_TOKEN, AdminAuthenticator } from '../api/auth.ts';
import { BusEventRelay } from '../api/events.ts';
import { FileContentStore } from '../api/files.ts';
import { ScryptHasher } from '../api/hash.ts';
import { WebPushService, type PushSender } from '../api/push.ts';
import { AesSecretVault, SecretBox } from '../api/secrets.ts';
import type { EventBus } from '../bus.ts';
import type { HubStore } from '../store/index.ts';
import type { HubSettings } from './env.ts';
import { HUB_INFO } from './info.ts';
import type { HubKeys } from './keys.ts';
import type { HubModules, HubServices, ModuleBuild, ModuleContext, ModuleFactory, ModuleKey } from './index.ts';

/** The services every module gets as they are. */
export interface BaseServices {
  readonly settings: HubSettings;
  readonly log: Logger;
  readonly clock: () => number;
  readonly bus: EventBus;
  readonly store: HubStore;
}

/** What the api module's services are made from. */
export interface ApiParts {
  readonly keys: HubKeys;
  /** Where content bytes live. */
  readonly files: FileStore;
  /** Presigns URLs for the files mounted on the web API's server. */
  readonly presign: Presigner;
  readonly pushSender: PushSender;
}

/** The api module's services, with the concrete classes boot also drives (making the admin, sweeping uploads). */
export type ApiServices = HubServices['api'] & { readonly auth: AdminAuthenticator; readonly content: FileContentStore };

/** Make the api module's services. */
export function apiServices(base: BaseServices, parts: ApiParts): ApiServices {
  const { settings, store, clock, log, bus } = base;
  return {
    auth: new AdminAuthenticator({
      store, clock, hub: HUB_INFO, secret: parts.keys.jwtSecret, hasher: new ScryptHasher(settings.authEnv.HARNESS_PASSWORD_COST),
      accessTtl: settings.authEnv.HARNESS_ACCESS_TTL, refreshTtl: settings.authEnv.HARNESS_REFRESH_TTL,
    }),
    content: new FileContentStore({
      files: parts.files, presign: parts.presign, maxUpload: settings.httpEnv.HARNESS_MAX_UPLOAD, presignTtl: settings.httpEnv.HARNESS_PRESIGN_TTL, clock,
    }),
    push: new WebPushService({
      store, sender: parts.pushSender, publicKey: parts.keys.vapid.publicKey,
      onError: (error, subscription) => { log.warn('push.failed', { push: subscription.id, user: subscription.user }, error); },
    }),
    relay: new BusEventRelay(bus),
    secrets: new AesSecretVault({ store, box: new SecretBox(parts.keys.secretKey), clock }),
  };
}

export { ACCESS_TOKEN };

/** Every service, with the modules built on first use; `builds` builds any not used yet and returns them all. */
export interface Assembly {
  readonly hub: HubServices;
  readonly builds: () => ReadonlyArray<ModuleBuild<unknown>>;
}

/** The modules in the order `builds` builds them (an order only; each still builds what it reads first). */
const MODULE_ORDER = ['catalog', 'link', 'index', 'execution', 'chat'] as const satisfies readonly ModuleKey[];

/** Put the hub's services together. */
export function assemble(base: BaseServices, api: HubServices['api'], modules: HubModules, extras: Omit<ModuleContext, 'hub'>): Assembly {
  const building: ModuleKey[] = [];
  const once = <K extends ModuleKey>(key: K, factory: ModuleFactory<K>): (() => ModuleBuild<HubServices[K]>) => {
    let made: ModuleBuild<HubServices[K]> | undefined;
    return () => {
      if (made !== undefined) { return made; }
      if (building.includes(key)) {
        throw new Error(`hub modules need each other while being built: ${[...building, key].join(' -> ')}; read other modules inside methods, not in factories`);
      }
      building.push(key);
      try {
        const result = factory(context);
        made = result;
        return result;
      } finally {
        building.pop();
      }
    };
  };
  const built = {
    catalog: once('catalog', modules.catalog),
    link: once('link', modules.link),
    execution: once('execution', modules.execution),
    chat: once('chat', modules.chat),
    index: once('index', modules.index),
  } as const satisfies { readonly [K in ModuleKey]: () => ModuleBuild<HubServices[K]> };
  const hub: HubServices = {
    ...base,
    api,
    get catalog() { return built.catalog().services; },
    get link() { return built.link().services; },
    get execution() { return built.execution().services; },
    get chat() { return built.chat().services; },
    get index() { return built.index().services; },
  };
  const context: ModuleContext = { ...extras, hub };
  return { hub, builds: () => MODULE_ORDER.map((key) => built[key]()) };
}
