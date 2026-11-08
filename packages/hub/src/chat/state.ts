/**
 * Session state: each system's scratch pad per session. A fn (or action) declares the fields it uses as an object
 * type; it reads and writes only those. Two declarations share a field only when both give it the same name and the
 * same type (the hash of the field's gin type, docs ignored, `optional` unwrapped since every field may be absent).
 *
 * Every write bumps the session's counter for that system, and each field remembers the counter value of its last
 * write; an owner's version is the newest of its own fields, so writes to fields it doesn't declare never conflict
 * with it. Cleared fields keep their clearing version in the counter row, so versions never go back. Writes by runs
 * are recorded on the run with the value before, so undoing the turn puts them back.
 */
import {
  GinTypeDef, Json, compositeKey, qualify, type JsonObject, type KeyOf, type Run, type RunId, type SessionId, type StateChange, type StateFieldValue, type StateField, type StateOwner, type SystemName,
} from '@harness/core';
import { canonicalJson, sha256 } from '@harness/sdk';
import { z } from 'zod';
import type { HubStore } from '../store/index.ts';
import type { ChatDeps } from './deps.ts';
import { ChatError } from './errors.ts';
import type { StateService } from './index.ts';
import { asQualified, entryOf, sameJson, turnScope } from './support.ts';

/** The name and type of the row that holds a session's counter for one system. No declared field can be named this. */
export const COUNTER_FIELD = '#counter';

/** The counter row's value. */
const Counter = z.object({ counter: z.number().int().min(0), cleared: z.record(z.string(), z.number().int().min(1)) });

/** The counter as the service works with it: `cleared` maps a field's key to the version that cleared it. */
interface CounterState {
  readonly counter: number;
  readonly cleared: Map<string, number>;
}

/** One declared field: its name, the hash of its type, and the type. */
export interface FieldSpec {
  readonly name: string;
  readonly type: string;
  readonly def: GinTypeDef;
}

/** Whose state a request touches, and which fields it may see. */
interface Scope {
  readonly session: SessionId;
  readonly system: SystemName;
  readonly fields: ReadonlyMap<string, FieldSpec>;
  readonly by: StateField['updatedBy'];
  readonly run?: RunId;
}

/** Drop `docs` everywhere in a gin definition, so documentation never splits a field. */
function withoutDocs(value: Json): Json {
  if (Array.isArray(value)) { return value.map(withoutDocs); }
  if (value === null || typeof value !== 'object') { return value; }
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'docs').map(([key, item]) => [key, withoutDocs(item)]));
}

/** A field's type with `optional` unwrapped: every state field may be absent, so `optional<text>` is `text`. */
function unwrapOptional(def: GinTypeDef): GinTypeDef {
  const inner = def.name === 'optional' ? def.generic?.['T'] : undefined;
  return inner === undefined ? def : unwrapOptional(inner);
}

/** The hash that identifies a field's type. */
export async function fieldType(def: GinTypeDef): Promise<string> {
  return sha256(canonicalJson(withoutDocs(Json.parse(unwrapOptional(def)))));
}

/** The session state service, on the `stateFields` table. */
export class TableStateService implements StateService {
  readonly #deps: Pick<ChatDeps, 'store' | 'catalog' | 'clock' | 'bus' | 'log'>;

  constructor(deps: Pick<ChatDeps, 'store' | 'catalog' | 'clock' | 'bus' | 'log'>) {
    this.#deps = deps;
  }

  /** The fields a state declaration holds. Named types are followed to their definition. */
  async fields(system: SystemName, def: GinTypeDef | undefined): Promise<Map<string, FieldSpec>> {
    const fields = new Map<string, FieldSpec>();
    const shape = await this.#objectShape(def);
    for (const [name, prop] of Object.entries(shape?.props ?? {})) {
      fields.set(name, { name, type: await fieldType(prop.type), def: unwrapOptional(prop.type) });
    }
    if (fields.has(COUNTER_FIELD)) { this.#deps.log.warn('chat.state.reserved', { system, field: COUNTER_FIELD }); fields.delete(COUNTER_FIELD); }
    return fields;
  }

  async get(owner: StateOwner): Promise<{ values: Record<string, Json>; version: number }> {
    const scope = await this.#scope(owner);
    return this.#read(this.#deps.store, scope);
  }

  async set(owner: StateOwner, input: { patch: Record<string, Json>; clear: readonly string[]; version?: number }): Promise<{ version: number } | { conflict: true }> {
    const scope = await this.#scope(owner);
    await this.#validate(scope, input.patch, input.clear);
    const now = this.#deps.clock();
    const result = await this.#deps.store.tx(async (store) => {
      const current = await this.#read(store, scope);
      if (input.version !== undefined && input.version !== current.version) { return { conflict: true as const }; }
      const touched = [...Object.keys(input.patch), ...input.clear.filter((name) => current.values[name] !== undefined)];
      if (touched.length === 0) { return { version: current.version, changes: [] }; }
      const counter = await this.#counter(store, scope);
      const next = counter.counter + 1;
      const changes: StateChange[] = [];
      for (const [name, value] of Object.entries(input.patch)) {
        const field = this.#field(scope, name);
        await store.table('stateFields').put({ session: scope.session, system: scope.system, name, type: field.type, def: field.def, value, version: next, updatedBy: scope.by, updatedAt: now });
        counter.cleared.delete(fieldKey(field));
        changes.push(change(field, current.values[name], value));
      }
      for (const name of input.clear) {
        const field = this.#field(scope, name);
        const before = current.values[name];
        if (before === undefined) { continue; }
        await store.table('stateFields').remove(this.#key(scope, field));
        counter.cleared.set(fieldKey(field), next);
        changes.push(change(field, before, undefined));
      }
      await this.#saveCounter(store, scope, { counter: next, cleared: counter.cleared }, now);
      if (scope.run !== undefined) { await this.#record(store, scope.run, changes); }
      return { version: next, changes };
    });
    if ('conflict' in result) { return result; }
    this.#publish(scope, result.changes);
    return { version: result.version };
  }

  async forRun(run: RunId): Promise<{ system: SystemName; fields: StateFieldValue[] }> {
    const scope = await this.#scope({ run });
    const { values } = await this.#read(this.#deps.store, scope);
    const fields = [...scope.fields.values()].map((field): StateFieldValue => {
      const value = values[field.name];
      return { name: field.name, type: field.type, ...(value === undefined ? {} : { value }) };
    });
    return { system: scope.system, fields };
  }

  async revert(run: RunId): Promise<void> {
    const scope = await this.#scope({ run });
    const now = this.#deps.clock();
    const reverted = await this.#deps.store.tx(async (store) => {
      const record = await store.table('runs').get(run);
      const changes = (record?.stateChanges ?? []).toReversed();
      if (changes.length === 0) { return []; }
      const counter = await this.#counter(store, scope);
      const next = counter.counter + 1;
      const done: StateChange[] = [];
      for (const recorded of changes) {
        const field = scope.fields.get(recorded.field) ?? { name: recorded.field, type: recorded.type, def: GinTypeDef.parse({ name: 'any' }) };
        if (field.type !== recorded.type) { this.#deps.log.warn('chat.state.revert.retyped', { run, field: recorded.field }); }
        const spec: FieldSpec = { ...field, type: recorded.type };
        const key = this.#key(scope, spec);
        const present = (await store.table('stateFields').get(key))?.value;
        if (!sameJson(present, recorded.after)) {
          this.#deps.log.info('chat.state.revert.skipped', { run, field: recorded.field, reason: 'changed-since' });
          continue;
        }
        if (recorded.before === undefined) {
          await store.table('stateFields').remove(key);
          counter.cleared.set(fieldKey(spec), next);
        } else {
          await store.table('stateFields').put({ session: scope.session, system: scope.system, name: spec.name, type: spec.type, def: spec.def, value: recorded.before, version: next, updatedBy: scope.by, updatedAt: now });
          counter.cleared.delete(fieldKey(spec));
        }
        done.push(change(spec, recorded.after, recorded.before));
      }
      if (done.length > 0) { await this.#saveCounter(store, scope, { counter: next, cleared: counter.cleared }, now); }
      return done;
    });
    this.#publish(scope, reverted);
  }

  /** The object type a state declaration names (directly, or through a named type). */
  async #objectShape(def: GinTypeDef | undefined, depth = 0): Promise<GinTypeDef | undefined> {
    if (def === undefined) { return undefined; }
    if (def.name === 'obj') { return def; }
    const name = asQualified(def.name);
    const named = depth < 8 && name !== undefined ? await this.#deps.catalog.type(name) : undefined;
    if (named === undefined) { throw new ChatError('invalid', `State must be declared as an object type, not ${def.name}.`); }
    return this.#objectShape(named.def, depth + 1);
  }

  /** Whose state an owner touches and the fields it declared. */
  async #scope(owner: StateOwner): Promise<Scope> {
    if ('run' in owner) {
      const run = await this.#deps.store.table('runs').get(owner.run);
      if (run === undefined) { throw new ChatError('not-found', `No run ${owner.run}.`); }
      const fn = await this.#deps.catalog.fn(run.fn);
      const system = fn?.system ?? run.system;
      return { session: run.session ?? turnScope(run.turn), system, fields: await this.fields(system, fn?.decl.state), by: { run: run.id }, run: run.id };
    }
    const delivery = await this.#deps.store.table('deliveries').get(owner.delivery);
    if (delivery === undefined) { throw new ChatError('not-found', `No delivery ${owner.delivery}.`); }
    if (!('action' in delivery.kind)) { throw new ChatError('invalid', 'A form submission has no session state of its own.'); }
    const action = await entryOf(this.#deps.catalog, 'actions', qualify(delivery.system, delivery.kind.action));
    return { session: delivery.session, system: delivery.system, fields: await this.fields(delivery.system, action?.decl.state), by: { delivery: delivery.id } };
  }

  async #validate(scope: Scope, patch: JsonObject, clear: readonly string[]): Promise<void> {
    for (const name of clear) {
      this.#field(scope, name);
      if (name in patch) { throw new ChatError('invalid', `The field ${name} can't be set and cleared at once.`); }
    }
    for (const [name, value] of Object.entries(patch)) {
      const problems = await this.#deps.catalog.check(scope.system, this.#field(scope, name).def, value);
      if (problems.length > 0) { throw new ChatError('invalid', `The value of ${name} doesn't fit its type: ${problems.join('; ')}`); }
    }
  }

  #field(scope: Scope, name: string): FieldSpec {
    const field = scope.fields.get(name);
    if (field === undefined) { throw new ChatError('invalid', `The state field ${name} isn't declared here.`); }
    return field;
  }

  #key(scope: Scope, field: Pick<FieldSpec, 'name' | 'type'>): KeyOf<'stateFields'> {
    return { session: scope.session, system: scope.system, name: field.name, type: field.type };
  }

  async #read(store: HubStore, scope: Scope): Promise<{ values: Record<string, Json>; version: number }> {
    const counter = await this.#counter(store, scope);
    const values: Record<string, Json> = {};
    let version = 0;
    for (const field of scope.fields.values()) {
      const row = await store.table('stateFields').get(this.#key(scope, field));
      if (row !== undefined) { values[field.name] = row.value; }
      version = Math.max(version, row?.version ?? counter.cleared.get(fieldKey(field)) ?? 0);
    }
    return { values, version };
  }

  async #counter(store: HubStore, scope: Scope): Promise<CounterState> {
    const row = await store.table('stateFields').get(this.#key(scope, { name: COUNTER_FIELD, type: COUNTER_FIELD }));
    if (row === undefined) { return { counter: 0, cleared: new Map() }; }
    const stored = Counter.parse(row.value);
    return { counter: stored.counter, cleared: new Map(Object.entries(stored.cleared)) };
  }

  async #saveCounter(store: HubStore, scope: Scope, counter: CounterState, now: number): Promise<void> {
    await store.table('stateFields').put({
      session: scope.session, system: scope.system, name: COUNTER_FIELD, type: COUNTER_FIELD, def: GinTypeDef.parse({ name: 'any' }),
      value: { counter: counter.counter, cleared: Object.fromEntries(counter.cleared) }, version: counter.counter, updatedBy: scope.by, updatedAt: now,
    });
  }

  async #record(store: HubStore, run: RunId, changes: readonly StateChange[]): Promise<Run> {
    const record = await store.table('runs').get(run);
    if (record === undefined) { throw new ChatError('not-found', `No run ${run}.`); }
    return store.table('runs').update(run, { stateChanges: [...record.stateChanges, ...changes] });
  }

  #publish(scope: Scope, changes: readonly StateChange[]): void {
    if (changes.length === 0) { return; }
    this.#deps.bus.publish('state.changed', {
      session: scope.session,
      system: scope.system,
      fields: changes.map((c) => ({ name: c.field, type: c.type, ...(c.after === undefined ? {} : { value: c.after }) })),
    });
  }
}

/** A field's entry in the counter row's `cleared` map. */
function fieldKey(field: Pick<FieldSpec, 'name' | 'type'>): string {
  return compositeKey(field.name, field.type);
}

/** A recorded change, without keys for absent values. */
function change(field: FieldSpec, before: Json | undefined, after: Json | undefined): StateChange {
  return { field: field.name, type: field.type, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
}

