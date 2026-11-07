/**
 * `ctx.types`: named types any system declared, loaded from the hub with every named type they reference
 * (dependencies first), so a system can parse and check values of types it doesn't declare itself.
 */
import type { QualifiedName, TypeRecord } from '@harness/core';
import type { Types } from '../ctx.ts';
import type { HubAccess } from './link.ts';

/** `Types` over the link. */
export class HubTypes implements Types {
  readonly #hub: HubAccess;
  readonly #signal: AbortSignal | undefined;

  constructor(hub: HubAccess, signal?: AbortSignal) {
    this.#hub = hub;
    this.#signal = signal;
  }

  async definitions(names: readonly QualifiedName[]): Promise<{ types: TypeRecord[]; missing: string[] }> {
    if (names.length === 0) { return { types: [], missing: [] }; }
    const hub = await this.#hub.ready(this.#signal);
    return hub.call('types', { names: [...names] }, this.#signal === undefined ? {} : { signal: this.#signal });
  }
}
