/**
 * One person's view of visibility: the stored rows, the groups they are in and their per-person connections, checked
 * without further reads.
 */
import { accessKey, seesOrigin, splitName, SystemName, type QualifiedName, type SessionId, type AccessRecord, type AccessTarget, type ActorId, type Sharing, type ShareRule } from '@harness/core';
import type { AccessScope, ConnectionGate, ContextRef, FnConnection, FnRef } from './index.ts';

/** Whether a sharing lets a person (in these groups) in. */
export function letsIn(sharing: Pick<Sharing, 'owner'> & ShareRule, actor: ActorId, groups: ReadonlySet<ActorId>): boolean {
  switch (sharing.visibility) {
    case 'public': return true;
    case 'private': return sharing.owner === actor;
    case 'shared': return sharing.owner === actor || sharing.with.some((who) => who === actor || groups.has(who));
  }
}

/** Whether `uri` is `root` or lies under it. */
export function underRoot(uri: string, root: string): boolean {
  if (uri === root) return true;
  return uri.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** What a scope is made from. */
export interface ScopeParts {
  readonly actor: ActorId;
  readonly admin: boolean;
  readonly groups: ReadonlySet<ActorId>;
  /** Every stored row, by key. */
  readonly rows: ReadonlyMap<string, AccessRecord>;
  readonly gate: ConnectionGate;
  /** The system serving a URI, when one does (its visibility counts too). */
  readonly systemOf: (uri: string) => string | undefined;
}

/** A person's scope over the rows as they were when it was made. */
export class ActorScope implements AccessScope {
  readonly actor: ActorId;
  readonly admin: boolean;
  readonly #parts: ScopeParts;
  /** The root rows, longest URI first, so the closest root above a resource is found first. */
  readonly #roots: readonly AccessRecord[];

  constructor(parts: ScopeParts) {
    this.actor = parts.actor;
    this.admin = parts.admin;
    this.#parts = parts;
    this.#roots = [...parts.rows.values()]
      .filter((row) => row.target.kind === 'root')
      .sort((a, b) => rootUri(b).length - rootUri(a).length);
  }

  sees(target: AccessTarget): boolean {
    if (this.admin) return true;
    const row = this.#parts.rows.get(accessKey(target));
    return row === undefined || letsIn(row.sharing, this.actor, this.#parts.groups);
  }

  seesSystem(system: string): boolean {
    const name = systemName(system);
    return name === undefined || this.sees({ kind: 'system', system: name });
  }

  seesFn(record: FnRef): boolean {
    if (!this.seesSystem(record.system) || !this.sees({ kind: 'fn', fn: record.name })) return false;
    return this.connection(record)?.state !== 'off';
  }

  mayUse(record: FnRef): boolean {
    if (!this.seesFn(record)) return false;
    const connection = this.connection(record);
    return connection === undefined || connection.state === 'ready';
  }

  seesContext(record: ContextRef): boolean {
    if (!this.seesSystem(record.system) || !this.sees({ kind: 'context', context: record.name })) return false;
    return record.origin?.type !== 'resource' || this.seesUri(record.origin.uri);
  }

  seesUri(uri: string): boolean {
    if (this.admin) return true;
    const system = this.#parts.systemOf(uri);
    if (system !== undefined && !this.seesSystem(system)) return false;
    const root = this.#roots.find((row) => underRoot(uri, rootUri(row)));
    return root === undefined || letsIn(root.sharing, this.actor, this.#parts.groups);
  }

  connection(record: FnRef): FnConnection | undefined {
    return this.#parts.gate.fn(record);
  }
}

/** A root row's URI ('' for any other row, which never matches as a root). */
function rootUri(row: AccessRecord): string {
  return row.target.kind === 'root' ? row.target.uri : '';
}

/** A system name as the targets take it, or undefined for a string that isn't one. */
function systemName(system: string): SystemName | undefined {
  const parsed = SystemName.safeParse(system);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether a person may see a context item: its access (a resource-made item follows its resource too) and, for a
 * memory, its scope (`seesOrigin`; a session-scoped memory needs the session it is asked from).
 */
export function seesContextAs(access: AccessScope, record: ContextRef, session?: SessionId): boolean {
  return seesOrigin(record.origin, { actor: access.actor, session }) && access.seesContext(record);
}

/**
 * Whether a person may see a context item by name: by its record when the catalog has one (`seesContextAs`), else by
 * its name and system alone.
 */
export async function seesContextNamed(access: AccessScope, lookup: (name: QualifiedName) => Promise<ContextRef | undefined>, name: QualifiedName, session?: SessionId): Promise<boolean> {
  const record = await lookup(name);
  return seesContextAs(access, record ?? { name, system: splitName(name).system, origin: undefined }, session);
}
