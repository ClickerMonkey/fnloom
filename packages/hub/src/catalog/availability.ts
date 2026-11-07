/**
 * Whether things can be used now. A system's contributions are usable only while it is connected, paired and has a
 * valid config. A fn also needs its functions switched on, not to be paused, its kind to exist on a usable system,
 * and every fn it depends on to be available. These rules are pure, so the catalog and its tests share them.
 */
import { splitName, type Availability, type FnRecord, type FnUnavailable, type KindRecord, type QualifiedName, type SystemName, type SystemRecord } from '@harness/core';

/** The hub's own system name. The hub is the process itself, so it is always connected. */
export const HUB_SYSTEM = 'hub';

/** Unavailable, for a reason. */
export function unavailable(reason: FnUnavailable, detail: string): Availability {
  return { unavailable: reason, detail };
}

/** Whether a system's contributions can be used now. */
export function systemAvailability(system: SystemName | string, record: SystemRecord | undefined): Availability {
  if (system === HUB_SYSTEM) { return true; }
  if (record === undefined) { return unavailable('system-disconnected', `${system} has never connected`); }
  switch (record.status) {
    case 'connected': return true;
    case 'needs-config': return unavailable('system-needs-config', `${system} needs a valid config before it can be used`);
    case 'removed': return unavailable('system-removed', `${system} was removed; pair it again to use it`);
    case 'pairing': return unavailable('system-disconnected', `${system} is waiting to be paired`);
    case 'disconnected': return unavailable('system-disconnected', `${system} is not connected`);
  }
}

/** What the availability of fns is worked out from. */
export interface AvailabilityInputs {
  readonly systems: ReadonlyMap<string, SystemRecord>;
  readonly kinds: ReadonlyMap<string, KindRecord>;
  readonly fns: ReadonlyMap<string, FnRecord>;
}

/**
 * Works out the availability of fns, following deps. A dep cycle counts as available as far as the cycle goes: the fns
 * of a cycle (a strongly connected component of the dep graph) are settled together, so each one's answer is the same
 * whichever fn is asked about first.
 */
export class AvailabilityRules {
  readonly #memo = new Map<string, Availability>();

  private readonly inputs: AvailabilityInputs;

  constructor(inputs: AvailabilityInputs) {
    this.inputs = inputs;
  }

  /** The availability of a system's contributions. */
  system(system: string): Availability {
    return systemAvailability(system, this.inputs.systems.get(system));
  }

  /** The availability of a fn, by name. */
  fn(name: QualifiedName): Availability {
    const known = this.#settled(name);
    if (known !== undefined) { return known; }
    this.#components(name);
    const result = this.#memo.get(name);
    if (result === undefined) { throw new Error(`availability of ${name} was not settled`); }
    return result;
  }

  /** An answer already known: memoized, or a fn that does not exist. */
  #settled(name: string): Availability | undefined {
    if (!this.inputs.fns.has(name)) { return unavailable('dep-unavailable', `${name} does not exist`); }
    return this.#memo.get(name);
  }

  /** Tarjan's walk from one fn, settling every component it reaches; components finish deps first. */
  #components(root: string): void {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const visit = (name: string): void => {
      const order = index.size;
      index.set(name, order);
      low.set(name, order);
      stack.push(name);
      onStack.add(name);
      for (const dep of this.#deps(name)) {
        if (this.#settled(dep) !== undefined) { continue; }
        if (!index.has(dep)) {
          visit(dep);
          low.set(name, Math.min(lowOf(name), lowOf(dep)));
        } else if (onStack.has(dep)) {
          low.set(name, Math.min(lowOf(name), index.get(dep) ?? order));
        }
      }
      if (lowOf(name) !== order) { return; }
      const members = new Set<string>();
      for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
        onStack.delete(top);
        members.add(top);
        if (top === name) { break; }
      }
      this.#settle(members);
    };
    const lowOf = (name: string): number => low.get(name) ?? 0;
    visit(root);
  }

  /** The deps a fn declares (none for a fn that does not exist). */
  #deps(name: string): readonly string[] {
    return this.inputs.fns.get(name)?.decl.deps ?? [];
  }

  /**
   * Settle one component. Every dep outside it is already settled. A member is unavailable when its own checks fail or
   * a dep is unavailable; failures spread through the component in rounds, members in name order, until nothing
   * changes. Members left standing are available.
   */
  #settle(members: ReadonlySet<string>): void {
    const results = new Map<string, Availability>();
    const order = [...members].sort();
    for (const name of order) {
      const record = this.inputs.fns.get(name);
      const own = record === undefined ? unavailable('dep-unavailable', `${name} does not exist`) : this.#own(record);
      if (own !== true) { results.set(name, own); }
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const name of order) {
        if (results.has(name)) { continue; }
        for (const dep of this.#deps(name)) {
          const found = members.has(dep) ? results.get(dep) : this.#settled(dep);
          if (found === undefined || found === true) { continue; }
          results.set(name, unavailable('dep-unavailable', `${dep}: ${found.detail}`));
          changed = true;
          break;
        }
      }
    }
    for (const name of order) { this.#memo.set(name, results.get(name) ?? true); }
  }

  /** The checks a fn passes or fails on its own, before its deps. */
  #own(record: FnRecord): Availability {
    const own = this.system(record.system);
    if (own !== true) { return own; }
    const system = this.inputs.systems.get(record.system);
    if (record.disabled || system?.enabled.functions === false) { return unavailable('disabled', `${record.name} is switched off`); }
    if (record.paused) { return unavailable('paused', `${record.name} is paused`); }
    if (record.decl.kind !== 'native') {
      const kind = this.inputs.kinds.get(record.decl.kind);
      if (kind === undefined) { return unavailable('kind-missing', `its kind ${record.decl.kind} does not exist`); }
      const kindSystem = this.system(splitName(kind.name).system);
      if (kindSystem !== true) { return unavailable('kind-system-disconnected', `its kind ${kind.name}: ${kindSystem.detail}`); }
    }
    return true;
  }
}

/** Whether two availabilities say the same thing. */
export function sameAvailability(a: Availability, b: Availability): boolean {
  return a === true || b === true ? a === b : a.unavailable === b.unavailable && a.detail === b.detail;
}
