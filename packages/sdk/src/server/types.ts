/**
 * `ctx.types`: named types any system declared, loaded from the hub with every named type they reference
 * (dependencies first), so a system can parse and check values of types it doesn't declare itself.
 */
import type { QualifiedName, RunId, TypeDefinitions } from '@harness/core';
import type { Types } from '../ctx.ts';
import type { HubAccess } from './link.ts';

/** `Types` over the link: as `run`'s person when given (the hub answers only the types they may see), else as the system. */
export class HubTypes implements Types {
  readonly #hub: HubAccess;
  readonly #signal: AbortSignal | undefined;
  readonly #run: RunId | undefined;

  constructor(hub: HubAccess, signal?: AbortSignal, run?: RunId) {
    this.#hub = hub;
    this.#signal = signal;
    this.#run = run;
  }

  async definitions(names: readonly QualifiedName[]): Promise<TypeDefinitions> {
    if (names.length === 0) { return { types: [], missing: [] }; }
    const hub = await this.#hub.ready(this.#signal);
    return hub.call('types', { names: [...names], ...(this.#run === undefined ? {} : { run: this.#run }) }, this.#signal === undefined ? {} : { signal: this.#signal });
  }
}
