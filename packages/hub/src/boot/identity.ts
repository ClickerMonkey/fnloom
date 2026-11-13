/**
 * The hub's display name (build 8, `core/identity.ts`): the admin's setting (the hub option `hub.name`), else the env
 * setting `HARNESS_NAME`, else "Harness". Read from the store on every ask (no process copy, so a second hub process
 * or a direct write is seen at once); a change is published so every open tab shows the new name, and the hub's own
 * actor is renamed with it.
 */
import { HUB_NAME_OPTION, hubNameOf, type ActorId, type HubDisplayName, type HubIdentity, type SystemName } from '@harness/core';
import type { EventBus } from '../bus.ts';
import type { HubStore } from '../store/index.ts';
import { firstRow } from '../store/rows.ts';

/** The identity as the store and env give it: the stored setting, else `envName`, else the default. */
export async function readHubIdentity(store: HubStore, envName: string | undefined, version: string): Promise<HubIdentity> {
  const row = await store.table('hubOptions').get(HUB_NAME_OPTION);
  const setting = row?.key === HUB_NAME_OPTION ? row.value : undefined;
  return { ...hubNameOf(setting, envName), version };
}

/** Reads and sets the hub's display name. */
export interface HubIdentityService {
  /** The name in use, where it came from, and the hub's version. */
  identity(): Promise<HubIdentity>;
  /** Set the admin's name, or clear it (`null`) to go back to the env's or the default; publishes the change. */
  setName(name: HubDisplayName | null, by: ActorId): Promise<HubIdentity>;
}

/** What the identity service is made from. */
export interface HubIdentityOptions {
  readonly store: HubStore;
  readonly bus: EventBus;
  readonly clock: () => number;
  /** `HARNESS_NAME`, when set. */
  readonly envName: string | undefined;
  readonly version: string;
  /** The hub's own system name, whose actor carries the display name. */
  readonly hub: SystemName;
}

/** The identity kept as a hub option in the store. */
export class StoreHubIdentity implements HubIdentityService {
  readonly #o: HubIdentityOptions;

  constructor(options: HubIdentityOptions) {
    this.#o = options;
  }

  async identity(store: HubStore = this.#o.store): Promise<HubIdentity> {
    return readHubIdentity(store, this.#o.envName, this.#o.version);
  }

  async setName(name: HubDisplayName | null, by: ActorId): Promise<HubIdentity> {
    const identity = await this.#o.store.tx(async (store) => {
      if (name === null) {
        await store.table('hubOptions').remove(HUB_NAME_OPTION);
      } else {
        await store.table('hubOptions').put({ key: HUB_NAME_OPTION, value: name, setBy: by, updatedAt: this.#o.clock() });
      }
      const next = await this.identity(store);
      const actor = await firstRow(store.table('actors'), { where: { kind: 'system' } }, (a) => a.kind === 'system' && a.system === this.#o.hub);
      if (actor !== undefined && actor.name !== next.name) { await store.table('actors').update(actor.id, { name: next.name }); }
      return next;
    });
    this.#o.bus.publish('identity', { identity });
    return identity;
  }
}
