/**
 * What an instance's admin page works out from its system's records: the fns and types that belong to the instance
 * (a database's saved queries and table types), the hub query for its types, the changes its
 * system proposed (a rescan's breaking type changes), the secret fields of a config as the hub sends it, and the facts
 * its overview lists.
 */
import {
  isJsonObject, QualifiedName, SECRET_KEPT, type ActorId, type Approval, type FnRecord, type InstanceName, type InstanceView, type Json, type Run, type SystemName,
  type QueryFnArgs,
} from '@harness/core';
import { fullTime, relativeTime } from '../../ui/format.ts';
import type { Fact } from './service-views.ts';

/** The fns a fleet instance owns: those routed to it alone. */
export function instanceFns(fns: readonly FnRecord[], instance: InstanceName): FnRecord[] {
  return fns.filter((fn) => fn.decl.routing?.to === 'instance' && fn.decl.routing.instance === instance);
}

/**
 * The hub `types` list query, by name, one page: a fleet instance's types (a database's tables), or with no instance
 * every type its system declared or made.
 */
export function typesQuery(key: { readonly system: SystemName; readonly instance?: InstanceName | undefined }, cursor: string | undefined, limit: number): QueryFnArgs {
  return {
    list: 'types',
    query: {
      filters: [{ field: 'system', op: 'is', value: key.system }, ...(key.instance === undefined ? [] : [{ field: 'instance', op: 'is' as const, value: key.instance }])],
      sort: [{ field: 'name', dir: 'asc' }], limit, ...(cursor === undefined ? {} : { cursor }),
    },
  };
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

/** What an instance's facts are read from: its own record, or a system's view (its default instance's facts). */
export type InstanceFactsSource = Pick<InstanceView, 'version' | 'keyFingerprint' | 'manifestHash' | 'status' | 'address' | 'pairedAt' | 'pairedBy' | 'lastSeenAt' | 'config'>;

/**
 * An instance's facts, in the order its pages show them: version, address (unless `hosted` already says where it
 * runs), key, pairing, last sighting, config and manifest. The system page (its default instance) and the instance page
 * both show these.
 */
export function instanceFacts(source: InstanceFactsSource, now: number, nameOf: (actor: ActorId) => string, hosted = false): Fact[] {
  const list: Fact[] = [{ label: 'Version', value: source.version }];
  if (source.address !== undefined && !hosted) { list.push({ label: 'Address', value: source.address }); }
  list.push({ label: 'Key', value: source.keyFingerprint });
  if (source.pairedAt !== undefined) {
    list.push({ label: 'Paired', value: `${relativeTime(source.pairedAt, now)}${source.pairedBy === undefined ? '' : ` by ${nameOf(source.pairedBy)}`}`, title: fullTime(source.pairedAt) });
  }
  if (source.lastSeenAt !== undefined) {
    list.push({ label: 'Last seen', value: source.status === 'connected' ? 'Online now' : relativeTime(source.lastSeenAt, now), title: fullTime(source.lastSeenAt) });
  }
  if (source.config !== undefined) { list.push({ label: 'Config', value: `Version ${source.config.version}, ${relativeTime(source.config.setAt, now)}`, title: fullTime(source.config.setAt) }); }
  list.push({ label: 'Manifest', value: source.manifestHash, code: true });
  return list;
}
