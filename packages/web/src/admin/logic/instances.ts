/**
 * What an instance's admin page works out from its system's records: the fns and types that belong to the instance
 * (a database's saved queries and table types), the type names its fns and waiting changes mention, the changes its
 * system proposed (a rescan's breaking type changes), and the secret fields of a config as the hub sends it.
 */
import {
  isJsonObject, QualifiedName, SECRET_KEPT, type Approval, type FnRecord, type InstanceName, type Json, type Run, type SystemName,
  type TypeRecord,
} from '@harness/core';

/** The fns a fleet instance owns: those routed to it alone. */
export function instanceFns(fns: readonly FnRecord[], instance: InstanceName): FnRecord[] {
  return fns.filter((fn) => fn.decl.routing?.to === 'instance' && fn.decl.routing.instance === instance);
}

/** The types a fleet instance owns, by name. */
export function instanceTypes(types: readonly TypeRecord[], instance: InstanceName): TypeRecord[] {
  return types.filter((type) => type.instance === instance).sort((a, b) => a.name.localeCompare(b.name));
}

/** A type name as a type-diff part gives it (`shop.Orders`, or already qualified), qualified by its system. */
export function qualifiedType(system: SystemName, name: string): QualifiedName | undefined {
  const parsed = QualifiedName.safeParse(name.includes('/') ? name : `${system}/${name}`);
  return parsed.success ? parsed.data : undefined;
}

/** The types each type-diff of these approvals changes, qualified. */
export function changedTypes(system: SystemName, approvals: readonly Approval[]): Set<QualifiedName> {
  const names = new Set<QualifiedName>();
  for (const approval of approvals) {
    for (const part of approval.preview?.parts ?? []) {
      if (part.type !== 'type-diff') { continue; }
      const name = qualifiedType(system, part.name);
      if (name !== undefined) { names.add(name); }
    }
  }
  return names;
}

/**
 * The type names worth asking the hub for: what the instance's fns depend on and what its waiting changes touch.
 * The hub answers the ones that are types and lists the rest as missing.
 */
export function typeNamesOf(system: SystemName, fns: readonly FnRecord[], approvals: readonly Approval[]): QualifiedName[] {
  const names = changedTypes(system, approvals);
  const prefix = `${system}/`;
  for (const fn of fns) { for (const dep of fn.decl.deps) { if (dep.startsWith(prefix)) { names.add(dep); } } }
  return [...names].sort();
}

/** The runs of an instance its system added for someone to approve (not ones a person called). */
export function waitingRunsOf(runs: readonly Run[], instance: InstanceName): Run[] {
  return runs.filter((run) => run.status === 'awaiting-approval' && run.instance === instance);
}

/** Only the approvals the system proposed, in the order their runs came. */
export function proposedOnly(approvals: readonly Approval[]): Approval[] {
  return approvals.filter((approval) => approval.proposed === true && approval.status === 'pending');
}

/**
 * The dot paths a config form draws as password inputs: the fields its system declares secret (`configSecrets`), and
 * any the hub sends as `SECRET_KEPT` (a saved secret).
 */
export function secretFields(declared: readonly string[] | undefined, value: Json | undefined): string[] {
  return [...new Set([...(declared ?? []), ...keptSecrets(value)])];
}

/** The dot paths of a config's secret fields that are set: the hub sends each as `SECRET_KEPT`. */
export function keptSecrets(value: Json | undefined, path = ''): string[] {
  if (value === SECRET_KEPT) { return path === '' ? [] : [path]; }
  if (!isJsonObject(value)) { return []; }
  return Object.entries(value).flatMap(([key, inner]) => keptSecrets(inner, path === '' ? key : `${path}.${key}`));
}
