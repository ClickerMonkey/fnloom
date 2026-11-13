/**
 * The access module (build 4): who may see and use each system, fn, context item, resource root and person's
 * connection. A thing with no stored row is `public` and owned by whoever added it, so earlier data keeps working.
 * Admins see everything. Every read, list, query, suggestion and fn call asks an `AccessScope` made for the person
 * asking, so they all answer the same way.
 *
 * Owner: the hub lane. `StoreAccessService` (`access/service.ts`) implements `AccessService`; `ActorScope`
 * (`access/scope.ts`) implements `AccessScope`.
 */
import type {
  AccessInfo, AccessTarget, AccessView, ActorId, ConnectionFnOption, ContextRecord, FnRecord, FnRouting, FnShare, FnUsable, Sharing, ShareRule, SystemName, UserConnection,
} from '@harness/core';

/** The parts of a fn record access looks at. */
export interface FnRef {
  readonly name: FnRecord['name'];
  readonly system: string;
  /** Its tags, when the caller has the record: an `admin` fn is hidden from everyone but admins (build 6). */
  readonly decl?: { readonly tags: readonly string[]; readonly routing?: FnRouting | undefined };
}

/** The parts of a type record access looks at. */
export interface TypeRef {
  readonly system: string;
  readonly audience?: ShareRule | undefined;
}

/** The parts of a context record access looks at. */
export interface ContextRef {
  readonly name: ContextRecord['name'];
  readonly system: string;
  readonly origin?: ContextRecord['origin'] | undefined;
}

/**
 * Where a per-person fn (a `connect` system's) stands for one person: switched off (left out everywhere), no usable
 * connection yet (shown as unavailable), or ready to act as a connection.
 */
export type FnConnection =
  | { readonly state: 'off' }
  | { readonly state: 'missing'; readonly page: string }
  | { readonly state: 'ready'; readonly connection: UserConnection; readonly option: ConnectionFnOption };

/** How the per-person fns stand for one person (made by the connections module). */
export interface ConnectionGate {
  /** Undefined when the fn doesn't act as a person. */
  fn(record: FnRef): FnConnection | undefined;
}

/** What one person may see and use, answered without further reads. */
export interface AccessScope {
  readonly actor: ActorId;
  /** Admins see everything (per-person fns still need their own or a shared connection). */
  readonly admin: boolean;
  /** Whether the person may see a target by its own visibility (a fn's system is not considered). */
  sees(target: AccessTarget): boolean;
  /** Whether a system may be seen. */
  seesSystem(system: string): boolean;
  /** A fn: its system and itself visible, and not switched off by the connection it would act as. */
  seesFn(record: FnRef): boolean;
  /** `seesFn`, and a per-person fn has a connection to act as. What tool lists and run starts ask. */
  mayUse(record: FnRef): boolean;
  /** A type: its system visible, and its audience (`TypeDecl.audience`) letting the person in when it has one. */
  seesType(record: TypeRef): boolean;
  /** A context item: its system and itself visible, and the resource it was made from when it was. */
  seesContext(record: ContextRef): boolean;
  /** A resource: the closest root above it with a visibility, and the system serving it, visible. */
  seesUri(uri: string): boolean;
  /** How a per-person fn stands for this person; undefined for any other fn. */
  connection(record: FnRef): FnConnection | undefined;
}

/** Visibility: the stored rows, scopes for people, and the web slice's answers. */
export interface AccessService {
  /** Whether the hub has more than one person (the web shows the controls only then). */
  info(): Promise<AccessInfo>;
  /** What a person may see and use now. */
  scope(actor: ActorId): Promise<AccessScope>;
  /** A target's owner and visibility (`public`, owned by whoever added it, when no row is stored). */
  sharing(target: AccessTarget): Promise<Sharing>;
  /** Targets' visibility for the asker, each with whether they may change it. Targets the asker can't see are left out. */
  views(asker: ActorId, targets: readonly AccessTarget[]): Promise<AccessView[]>;
  /** Change a target's visibility; refused (403) unless the asker owns it or is an admin. */
  set(asker: ActorId, target: AccessTarget, rule: ShareRule): Promise<AccessView>;
  /**
   * A running fn of `system` gives one of its system's fns to its run's person (`shareFn`): refused unless the run is
   * that system's and still going, the fn is that system's, and nobody else owns it already.
   */
  give(system: SystemName, share: FnShare): Promise<AccessView>;
  /**
   * Which of `query.fns` (fns of `system`) a running fn of that system's person may use now (`usableFns`): refused
   * unless the run is that system's and still going. Fns the person may not use are left out.
   */
  usable(system: SystemName, query: FnUsable): Promise<string[]>;
  /**
   * Build 5: the hub hands something it made to a person, with who else may see it (a person's browser log folder,
   * private to them; admins see everything anyway). Only the hub's own code calls this.
   */
  own(target: AccessTarget, owner: ActorId, rule: ShareRule): Promise<AccessView>;
}

/** A scope that sees and may use everything, acting as `actor` (the hub's own work, tests). */
export function openScope(actor: ActorId): AccessScope {
  return {
    actor,
    admin: true,
    sees: () => true,
    seesSystem: () => true,
    seesFn: () => true,
    seesType: () => true,
    mayUse: () => true,
    seesContext: () => true,
    seesUri: () => true,
    connection: () => undefined,
  };
}
