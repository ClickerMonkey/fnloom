/**
 * Fleet routing: which instance of a system runs a call. A system with one connected instance (or none) needs no
 * choice. With several, the pick is, in order: an explicit `on`; the instance serving a resource URI found in the
 * args (`file://laptop/…`); the session's pinned instance (`/on laptop`); the system's default instance when it is
 * connected. With none connected, the call goes to the system's default instance (`InstanceKeeper.defaultOf`). Otherwise the call is refused as invalid input naming the choices, which an agent retries with `on`.
 */
import {
  MAIN_INSTANCE, ResourceUri, SystemName, splitName, type InstanceName, type InstanceRef, type InvalidInput, type Json, type QualifiedName, type SessionId,
} from '@harness/core';
import type { HubStore } from '../store/index.ts';
import type { InstancePin, InstanceRouter, LinkService, ResourceRouter } from './index.ts';
import type { InstanceKeeper } from './status.ts';

/** The most strings of a call's args looked at for resource URIs. */
const MAX_URIS = 64;

/** Every string in a JSON value that is a resource URI, depth first, up to `limit`. */
export function urisIn(value: Json, limit = MAX_URIS): ResourceUri[] {
  const out: ResourceUri[] = [];
  const walk = (node: Json): void => {
    if (out.length >= limit) { return; }
    if (typeof node === 'string') {
      const uri = ResourceUri.safeParse(node);
      if (uri.success) { out.push(uri.data); }
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node !== null && typeof node === 'object') { Object.values(node).forEach(walk); }
  };
  walk(value);
  return out;
}

/** The instance a URI's authority names (`file://laptop/x` → `laptop`), when it is one of `choices`. */
export function authorityInstance(uri: string, choices: readonly InstanceName[]): InstanceName | undefined {
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(uri)?.[1]?.toLowerCase();
  return host === undefined || host === '' ? undefined : choices.find((choice) => choice === host);
}

/** The refusal for a fleet call that names no instance. */
export function ambiguous(system: SystemName, choices: readonly InstanceName[], asked?: InstanceName): InvalidInput {
  const say = choices.map((c) => `on=${c}`).join(' or ');
  const message = asked === undefined ? `${system} has several machines: say ${say}` : `${system} has no connected instance ${asked}: say ${say}`;
  return { source: 'validation', problems: [{ path: 'on', message }] };
}

/** Routes calls across a fleet's connected instances. */
export class FleetRouter implements InstanceRouter {
  readonly #links: LinkService;
  readonly #resources: Pick<ResourceRouter, 'route'>;
  readonly #store: HubStore;
  readonly #instances: Pick<InstanceKeeper, 'defaultOf'>;
  /** Each session's pinned instance per system. */
  readonly #pins = new Map<SessionId, Map<SystemName, InstanceName>>();

  constructor(options: { links: LinkService; resources: Pick<ResourceRouter, 'route'>; store: HubStore; instances: Pick<InstanceKeeper, 'defaultOf'> }) {
    this.#links = options.links;
    this.#resources = options.resources;
    this.#store = options.store;
    this.#instances = options.instances;
  }

  connected(system: SystemName): readonly InstanceName[] {
    return this.#links.connections(system).map((c) => c.instance);
  }

  pin(session: SessionId, pin: InstancePin): void {
    const pins = this.#pins.get(session) ?? new Map<SystemName, InstanceName>();
    if (pin.instance === undefined) { pins.delete(pin.system); } else { pins.set(pin.system, pin.instance); }
    if (pins.size === 0) { this.#pins.delete(session); } else { this.#pins.set(session, pins); }
  }

  async route(input: { fn: QualifiedName; args: Json; on?: InstanceName | undefined; session?: SessionId | undefined }): Promise<{ instance: InstanceRef } | { invalid: InvalidInput }> {
    const system = SystemName.parse(splitName(input.fn).system);
    const choices = this.connected(system);
    const pick = (instance: InstanceName) => ({ instance: { system, instance } });
    if (input.on !== undefined) { return choices.includes(input.on) || choices.length === 0 ? pick(input.on) : { invalid: ambiguous(system, choices, input.on) }; }
    const only = choices.length === 1 ? choices[0] : undefined;
    if (only !== undefined) { return pick(only); }
    // none connected: the call waits for the instance calls go to when nothing picks one
    if (choices.length === 0) { return pick(await this.#instances.defaultOf(system) ?? MAIN_INSTANCE); }
    const record = await this.#store.table('systems').get(system);
    const fromUri = this.#fromUris(system, input.args, choices);
    if (fromUri !== undefined) { return pick(fromUri); }
    const pinned = input.session === undefined ? undefined : this.#pins.get(input.session)?.get(system);
    if (pinned !== undefined && choices.includes(pinned)) { return pick(pinned); }
    if (record?.defaultInstance !== undefined && choices.includes(record.defaultInstance)) { return pick(record.defaultInstance); }
    return { invalid: ambiguous(system, choices) };
  }

  /** The one instance the resource URIs in the args belong to (by the root serving them, else their authority). */
  #fromUris(system: SystemName, args: Json, choices: readonly InstanceName[]): InstanceName | undefined {
    const found = new Set<InstanceName>();
    for (const uri of urisIn(args)) {
      const route = this.#resources.route(uri);
      const instance = route?.system === system ? route.instance : authorityInstance(uri, choices);
      if (instance !== undefined && choices.includes(instance)) { found.add(instance); }
    }
    return found.size === 1 ? [...found][0] : undefined;
  }
}
