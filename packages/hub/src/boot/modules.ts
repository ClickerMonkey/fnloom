/**
 * The one place the hub's modules are chosen: how the store opens, and the factory that builds each module from
 * `ModuleContext`. A factory returns its services, the lifecycle hooks it needs (`work`: start and stop queues;
 * `links`; `installed`) and the ayepi plugins it serves on the system link. Factories read other modules lazily
 * (inside their methods), so the order modules are written here doesn't matter.
 *
 * A module whose lane hasn't published its factory yet is `notBuilt`: the hub refuses to start and says which.
 */
import { openSqliteStore } from '../store/sqlite.ts';
import type { HubModules, ModuleFactory, ModuleKey } from './index.ts';

/** A module that can't be built yet; starting the hub says so and who builds it. */
export function notBuilt<K extends ModuleKey>(module: K, lane: string): ModuleFactory<K> {
  return () => { throw new Error(`the ${module} module has no factory yet (the ${lane} lane builds it); wire it in packages/hub/src/boot/modules.ts`); };
}

/** The hub's modules. */
export const HUB_MODULES: HubModules = {
  store: openSqliteStore,
  catalog: notBuilt('catalog', 'link'),
  link: notBuilt('link', 'link'),
  execution: notBuilt('execution', 'execution'),
  chat: notBuilt('chat', 'chat'),
  index: notBuilt('index', 'data'),
};
