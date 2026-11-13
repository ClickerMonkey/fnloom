/** Kinds describe their fns on their own system: the hub asks it over the link (`check`). */
import { splitName, SystemName, type InstanceName, type Json, type KindDescription, type QualifiedName } from '@harness/core';
import type { KindDescriber } from '../catalog/index.ts';
import type { LinkService } from './index.ts';

/** Thrown when the system a kind belongs to isn't connected, so nothing can describe its fns now. */
export class KindUnreachable extends Error {
  override readonly name = 'KindUnreachable';
}

/**
 * Asks the connected system that defines a kind to check and describe a payload: the fn's own instance when it belongs
 * to one (a database's saved query is described where its tables are), else the system's default connection.
 */
export class LinkKindDescriber implements KindDescriber {
  readonly #links: LinkService;

  constructor(links: LinkService) {
    this.#links = links;
  }

  async describe(kind: QualifiedName, payload: Json, instance?: InstanceName): Promise<{ problems: string[]; description?: KindDescription | undefined }> {
    const { system, local } = splitName(kind);
    const name = SystemName.parse(system);
    const connection = this.#links.connection(name, instance);
    if (connection === undefined) { throw new KindUnreachable(`${instance === undefined ? system : `${system} ${instance}`} is not connected, so ${kind} can't describe a payload`); }
    return connection.peer.call('check', { kind: local, payload });
  }
}

/** Describes one of the hub's own kinds in the hub's process (the hub has no link to itself). */
export type HubKindDescribe = (payload: Json) => Promise<{ problems: string[]; description?: KindDescription | undefined }>;

/** The hub's own kinds (`hub/widget`) described in process; every other kind by its system over the link. */
export class RoutedKindDescriber implements KindDescriber {
  readonly #hub: ReadonlyMap<string, HubKindDescribe>;
  readonly #others: KindDescriber;

  constructor(hub: ReadonlyMap<string, HubKindDescribe>, others: KindDescriber) {
    this.#hub = hub;
    this.#others = others;
  }

  describe(kind: QualifiedName, payload: Json, instance?: InstanceName): Promise<{ problems: string[]; description?: KindDescription | undefined }> {
    const local = this.#hub.get(kind);
    return local === undefined ? this.#others.describe(kind, payload, instance) : local(payload);
  }
}
