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

/** Works out the availability of fns, following deps (a dep cycle counts as available as far as the cycle goes). */
export class AvailabilityRules {
  readonly #memo = new Map<string, Availability>();
  readonly #visiting = new Set<string>();

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
    const known = this.#memo.get(name);
    if (known !== undefined) { return known; }
    const record = this.inputs.fns.get(name);
    if (record === undefined) { return unavailable('dep-unavailable', `${name} does not exist`); }
    if (this.#visiting.has(name)) { return true; }
    this.#visiting.add(name);
    const result = this.#work(record);
    this.#visiting.delete(name);
    this.#memo.set(name, result);
    return result;
  }

  #work(record: FnRecord): Availability {
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
    for (const dep of record.decl.deps) {
      const found = this.fn(dep);
      if (found !== true) { return unavailable('dep-unavailable', `${dep}: ${found.detail}`); }
    }
    return true;
  }
}

/** Whether two availabilities say the same thing. */
export function sameAvailability(a: Availability, b: Availability): boolean {
  return a === true || b === true ? a === b : a.unavailable === b.unavailable && a.detail === b.detail;
}
