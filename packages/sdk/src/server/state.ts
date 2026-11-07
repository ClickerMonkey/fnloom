/**
 * `ctx.state`: a system's session scratch pad, through the hub. The hub reads and writes only the fields the fn or
 * action declared; values are checked against the declared field types both ways. `update` reads, changes and writes
 * against the version it read, and tries again when another write got in first.
 */
import type { JsonObject, StateOwner } from '@harness/core';
import type { SessionState } from '../ctx.ts';
import type { GinType } from '../gin.ts';
import type { HubAccess } from './link.ts';
import { decodeOrThrow, encodeOrThrow } from './wire.ts';

/** Too many other writes got in between a read and its write. */
export class StateConflict extends Error {
  override readonly name = 'StateConflict';
}

/** A declared state type is an object type; the runtime reads it field by field, as a record of its fields. */
export function stateRecordType(type: GinType<object> | undefined): GinType<Record<string, unknown>> | undefined {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- an object type's values are records of its fields
  return type as GinType<Record<string, unknown>> | undefined;
}

/** Session state over the link, for one run or action, typed by its declared fields. */
export class LinkState<S extends object> implements SessionState<S> {
  readonly #hub: HubAccess;
  readonly #owner: StateOwner;
  readonly #fields: Readonly<Record<string, GinType>>;
  readonly #retries: number;
  readonly #signal: AbortSignal | undefined;

  /** `type` is the declared state type (an object type); without one the fn sees no fields. */
  constructor(hub: HubAccess, owner: StateOwner, type: GinType<S> | undefined, options: { retries: number; signal?: AbortSignal }) {
    this.#hub = hub;
    this.#owner = owner;
    this.#fields = fieldsOf(type);
    this.#retries = options.retries;
    this.#signal = options.signal;
  }

  async get(): Promise<Readonly<Partial<S>>> {
    return (await this.#read()).values;
  }

  async set(patch: Partial<S>): Promise<void> {
    await this.#write(this.#encode(patch), [], undefined);
  }

  async update(change: (current: Readonly<Partial<S>>) => Partial<S>): Promise<void> {
    for (let attempt = 0; attempt < this.#retries; attempt += 1) {
      const { values, version } = await this.#read();
      if (await this.#write(this.#encode(change(values)), [], version)) { return; }
    }
    throw new StateConflict(`Session state kept changing; gave up after ${this.#retries} tries.`);
  }

  async clear(...fields: Array<keyof S & string>): Promise<void> {
    for (const field of fields) { this.#field(field); }
    await this.#write({}, fields, undefined);
  }

  async #read(): Promise<{ values: Partial<S>; version: number }> {
    const hub = await this.#hub.ready(this.#signal);
    const reply = await hub.call('stateGet', { owner: this.#owner }, this.#options());
    const values: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(reply.values)) {
      const type = this.#fields[field];
      if (type !== undefined) { values[field] = decodeOrThrow(type, value, `State field ${field}`); }
    }
    return { values: partialOf<S>(values), version: reply.version };
  }

  /** Write; false when refused because another write came in after `version`. */
  async #write(patch: JsonObject, clear: string[], version: number | undefined): Promise<boolean> {
    const hub = await this.#hub.ready(this.#signal);
    const reply = await hub.call('stateSet', { owner: this.#owner, patch, clear, ...(version === undefined ? {} : { version }) }, this.#options());
    return !('conflict' in reply);
  }

  #encode(patch: Partial<S>): JsonObject {
    const out: JsonObject = {};
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) { continue; }
      out[field] = encodeOrThrow(this.#field(field), value, `State field ${field}`);
    }
    return out;
  }

  #field(field: string): GinType {
    const type = this.#fields[field];
    if (type === undefined) { throw new Error(`State field ${field} is not declared.`); }
    return type;
  }

  #options(): { signal: AbortSignal } | {} {
    return this.#signal === undefined ? {} : { signal: this.#signal };
  }
}

/** The declared fields of a state type: its object fields, by name. */
function fieldsOf(type: GinType | undefined): Record<string, GinType> {
  if (type === undefined) { return {}; }
  return Object.fromEntries(Object.entries(type.props()).map(([name, prop]) => [name, prop.type]));
}

/**
 * Values read from the hub, each checked against its declared field type above, as the declared partial shape. The
 * check is per field, which TypeScript can't follow through `Object.entries`.
 */
function partialOf<S extends object>(values: Record<string, unknown>): Partial<S> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every key was checked against S's field type
  return values as Partial<S>;
}
