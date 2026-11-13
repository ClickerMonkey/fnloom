/**
 * Build 7: the hub enforces what a system declared, over the link, in one place. The `linkSession` guard asks
 * `SystemGrantGuard.check` before every endpoint a linked system calls:
 * - **capability:** the endpoint's group (`HUB_CAPABILITIES`) must be in `grants.hub`; the base is always allowed
 * - **calls:** a call to another system's fn needs `fns` and the fn or its system in `grants.calls`
 * - **mode:** a fn declared `read` can't call or propose a write or delete fn (a hub fn that changes only what the
 *   system owns, tagged `own`, and a call of a fn that waits for its own approval, aside); `write` can't call a
 *   delete fn
 * - **types:** a run whose fn declares the types it reads and writes asks for no others (beyond its system's own)
 * - **data:** a record endpoint keeps to the types the run's fn declares (it saves and removes only those it writes),
 *   and to its mode: saving needs `write`, removing `delete`
 * - **models and spend:** the model roles and models it may use, and its per-run and per-day caps
 *
 * Each refusal is a `RefusalRecord`. Past `HARNESS_REFUSALS_PAUSE` refusals in `HARNESS_REFUSALS_WINDOW`, the system's
 * functions are switched off and the admins are told (`system.paused`). With `HARNESS_GRANTS=log` refusals are only logged.
 */
import { reject as refuse } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import {
  HUB_CAPABILITIES, LocalName, mintId, ModelChoice, OWN_TAG, qualify, QualifiedName, RunId, splitName,
  type hubLinkSpec, type FnMode, type FnRecord, type HubCapability, type LinkSession, type ModelRole, type RefusalRecord, type RefusalRule, type Run, type SystemGrants, type SystemName,
} from '@harness/core';
import { z } from 'zod';
import type { EventBus } from '../bus.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { Catalog } from '../catalog/index.ts';
import { ROLE_OF } from '../models/gateway.ts';
import type { HubStore } from '../store/index.ts';
import type { ReviewEnv } from './env.ts';
import type { SystemAdmin } from './index.ts';

/** A hub link endpoint's name. */
export type HubLinkEndpoint = keyof (typeof hubLinkSpec)['endpoints'];

/** The link endpoints each capability opens (`HUB_CAPABILITIES`); `call` to the system's own fns is always open. */
export const CAPABILITY_ENDPOINTS = {
  ai: ['llm', 'model', 'models'],
  embed: [],
  resources: ['resource', 'resourceSections', 'content', 'mentionResources'],
  fns: ['call', 'usableFns', 'shareFn'],
  search: ['searchFns', 'fnExamples', 'examples'],
  decide: ['decide'],
  approvals: ['propose', 'grantPairing', 'reportRefusal'],
  connections: ['connectionUpdate'],
  settings: ['setting'],
  state: ['stateGet', 'stateSet'],
  // build 8: served by the hub lane (the data system)
  data: ['records', 'record', 'recordTable', 'saveRecord', 'removeRecord'],
} as const satisfies Record<HubCapability, readonly HubLinkEndpoint[]>;

/** The capability an endpoint needs, or none for the base (handshake, contract, uploads, its own runs, logs, types, fleet). */
export function capabilityOf(endpoint: string): HubCapability | undefined {
  return HUB_CAPABILITIES.find((capability) => {
    const endpoints: readonly string[] = CAPABILITY_ENDPOINTS[capability];
    return endpoints.includes(endpoint);
  });
}

/** How far each mode reaches: a fn may only use fns at or below its own declared mode. */
const MODE_RANK: Record<FnMode, number> = { read: 0, write: 1, delete: 2 };

/** A refusal the guard decided: its rule, what was tried, and one readable line. */
export interface Refusal {
  readonly rule: RefusalRule;
  readonly attempt: string;
  readonly detail: string;
  readonly run?: RunId | undefined;
  readonly fn?: QualifiedName | undefined;
}

/** The parts of a call's body the checks read; the endpoint's own schema checks the rest after. */
const CallBody = z.object({ parent: RunId, fn: QualifiedName });
const TypesBody = z.object({ names: z.array(QualifiedName), run: RunId.optional() });
const ProposeBody = z.object({ fn: LocalName, parent: RunId.optional() });
const DataBody = z.object({ type: QualifiedName, run: RunId.optional() });
const ModelBody = z.object({ run: RunId.optional(), model: ModelChoice.optional(), modality: z.string().optional() });

/** The role a model call that names no model uses, by its modality (`ROLE_OF`); none for a modality without one. */
function roleOfModality(modality: string | undefined): ModelRole | undefined {
  return Object.entries(ROLE_OF).find(([name]) => name === modality)?.[1];
}

/** What the guard reads and does. */
export interface GrantGuardOptions {
  readonly store: HubStore;
  readonly catalog: Catalog;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly clock: () => number;
  /** Switches a paused system's functions off. */
  readonly admin: () => Pick<SystemAdmin, 'setEnabled'>;
  readonly settings: Pick<ReviewEnv, 'HARNESS_GRANTS' | 'HARNESS_REFUSALS_PAUSE' | 'HARNESS_REFUSALS_WINDOW'>;
}

/** One day, for the per-day spend cap. */
const DAY = 86_400_000;

/** Enforces systems' grants over the link and keeps the refusals. */
export class SystemGrantGuard {
  readonly #options: GrantGuardOptions;

  constructor(options: GrantGuardOptions) {
    this.#options = options;
  }

  /**
   * The grants the hub enforces for a system: once it is live, the ones an admin approved (`LiveContract.grants`), so a
   * newer contract asking for more (waiting for review, or rejected) gets nothing more; before that (installed, or live
   * from before build 7 with no review yet), what its contract declares. None declared is the base only.
   */
  async grants(system: SystemName): Promise<SystemGrants> {
    const live = (await this.#options.store.table('systemReviews').get(system))?.live;
    if (live !== undefined) { return live.grants; }
    return (await this.#options.catalog.manifest(system))?.grants ?? { hub: [] };
  }

  /**
   * Check one call a linked system makes, before it reaches its handler. Throws a 403 with the reason when it is
   * refused (and logs it); with `HARNESS_GRANTS=log` it only logs it.
   */
  async check(link: LinkSession, endpoint: string, body: unknown): Promise<void> {
    if (link.system === HUB_SYSTEM) { return; }
    const refusal = await this.#decide(link, endpoint, body);
    if (refusal === undefined) { return; }
    await this.refused(link, refusal);
    if (this.#options.settings.HARNESS_GRANTS === 'enforce') { throw refuse(403, 'NOT_GRANTED', refusal.detail); }
  }

  /** Keep a refusal (also those fs's supervisor reports), and pause a system that keeps going past them. */
  async refused(link: Pick<LinkSession, 'system' | 'instance'>, refusal: Refusal): Promise<RefusalRecord> {
    const { store, clock, log, settings } = this.#options;
    const record: RefusalRecord = {
      id: mintId('refusal'), system: link.system, instance: link.instance, rule: refusal.rule, attempt: refusal.attempt, detail: refusal.detail, at: clock(),
      ...(refusal.run === undefined ? {} : { run: refusal.run }), ...(refusal.fn === undefined ? {} : { fn: refusal.fn }),
    };
    await store.table('refusals').insert(record);
    log.warn('system.refused', { system: link.system, instance: link.instance, rule: refusal.rule, attempt: refusal.attempt, detail: refusal.detail, enforced: settings.HARNESS_GRANTS === 'enforce' });
    if (settings.HARNESS_GRANTS === 'enforce') { await this.#pauseIfOver(link.system); }
    return record;
  }

  async #pauseIfOver(system: SystemName): Promise<void> {
    const { store, clock, settings, bus, log } = this.#options;
    const recent = await store.table('refusals').count({ system, at: { gt: clock() - settings.HARNESS_REFUSALS_WINDOW } });
    if (recent < settings.HARNESS_REFUSALS_PAUSE) { return; }
    const record = await store.table('systems').get(system);
    if (record === undefined || !record.enabled.functions) { return; }
    await this.#options.admin().setEnabled(system, { functions: false }, record.actor);
    await this.#options.catalog.refreshAvailability(system);
    bus.publish('system.paused', { system, refusals: recent });
    log.warn('system.paused', { system, refusals: recent, window: settings.HARNESS_REFUSALS_WINDOW });
  }

  async #decide(link: LinkSession, endpoint: string, body: unknown): Promise<Refusal | undefined> {
    const grants = await this.grants(link.system);
    switch (endpoint) {
      case 'call': return this.#call(link, grants, body);
      case 'propose': return this.#capability(grants, endpoint) ?? await this.#propose(link, body);
      case 'llm': return this.#capability(grants, endpoint) ?? await this.#model(link, grants, endpoint, ModelBody.safeParse(body).data);
      case 'model': {
        const parsed = ModelBody.safeParse(body).data;
        // an embedding is the `embed` capability's, every other modality `ai`'s
        const own = parsed?.modality === 'embed' && grants.hub.includes('embed') ? undefined : this.#capability(grants, endpoint);
        return own ?? await this.#model(link, grants, endpoint, parsed);
      }
      case 'types': return this.#types(link, body);
      case 'records': case 'record': case 'recordTable': return this.#capability(grants, endpoint) ?? await this.#data(link, body, 'read');
      case 'saveRecord': return this.#capability(grants, endpoint) ?? await this.#data(link, body, 'write');
      case 'removeRecord': return this.#capability(grants, endpoint) ?? await this.#data(link, body, 'delete');
      default: return this.#capability(grants, endpoint);
    }
  }

  /** The endpoint's capability, when it needs one the system didn't declare. */
  #capability(grants: SystemGrants, endpoint: string): Refusal | undefined {
    const capability = capabilityOf(endpoint);
    if (capability === undefined || grants.hub.includes(capability)) { return undefined; }
    return { rule: 'capability', attempt: endpoint, detail: `it didn't declare the ${capability} capability, which ${endpoint} needs` };
  }

  /** A child call: to another system it needs `fns` and `grants.calls`; its mode can't go past its parent fn's declared mode. */
  async #call(link: LinkSession, grants: SystemGrants, body: unknown): Promise<Refusal | undefined> {
    const parsed = CallBody.safeParse(body);
    if (!parsed.success) { return undefined; }
    const { parent: parentId, fn: target } = parsed.data;
    const parent = await this.#ownRun(link, parentId);
    const base = { run: parentId, fn: parent?.fn };
    const targetSystem = splitName(target).system;
    if (targetSystem !== link.system) {
      if (!grants.hub.includes('fns')) { return { ...base, rule: 'capability', attempt: target, detail: `it didn't declare the fns capability, which calling ${target} needs` }; }
      const calls = grants.calls ?? [];
      if (!calls.some((allowed) => allowed === target || allowed === targetSystem)) { return { ...base, rule: 'calls', attempt: target, detail: `it didn't declare that it calls ${target}` }; }
    }
    return parent === undefined ? undefined : this.#mode(parent, target, false);
  }

  /** A proposal under a run is a call of the system's own fn: its mode can't go past the run's fn's. */
  async #propose(link: LinkSession, body: unknown): Promise<Refusal | undefined> {
    const parsed = ProposeBody.safeParse(body);
    if (!parsed.success || parsed.data.parent === undefined) { return undefined; }
    const parent = await this.#ownRun(link, parsed.data.parent);
    return parent === undefined ? undefined : this.#mode(parent, qualify(link.system, parsed.data.fn), true);
  }

  /** Whether the run's fn, by its declared mode, may call (or, `proposed`, propose a run of) the target fn. */
  async #mode(parent: Run, target: QualifiedName, proposed: boolean): Promise<Refusal | undefined> {
    const [caller, callee] = await Promise.all([this.#options.catalog.fn(parent.fn), this.#options.catalog.fn(target)]);
    const declared = caller?.decl.effects?.mode;
    if (declared === undefined || callee === undefined) { return undefined; }
    // a hub fn that changes only what the calling system owns (`own`, as a web page it keeps as a resource) is part of
    // its own work, as the fallback policy has it
    if (callee.system === HUB_SYSTEM && callee.decl.tags.includes(OWN_TAG)) { return undefined; }
    // a call of a fn that waits for its own approval every time (`approval`, as a schema change's DDL) changes nothing
    // until a person has seen what it does and allowed it
    if (!proposed && callee.decl.approval !== undefined) { return undefined; }
    const needs = await this.#modeOf(callee);
    if (MODE_RANK[needs] <= MODE_RANK[declared]) { return undefined; }
    return { rule: 'mode', attempt: target, run: parent.id, fn: parent.fn, detail: `${parent.fn} is declared ${declared} and tried ${target}, which can ${needs === 'delete' ? 'delete' : 'write'}` };
  }

  /** A fn's mode: worked out deeply when its facts are stored, else what it declares (a fn that declares none reads). */
  async #modeOf(fn: FnRecord): Promise<FnMode> {
    return (await this.#options.store.table('fnFacts').get(fn.name))?.mode ?? fn.decl.effects?.mode ?? 'read';
  }

  /** The run a body names, when it is one of this link's system's own (another system's is the handler's to refuse). */
  async #ownRun(link: LinkSession, id: RunId): Promise<Run | undefined> {
    const run = await this.#options.store.table('runs').get(id);
    return run?.system === link.system ? run : undefined;
  }

  /**
   * Types asked for under a run whose fn declares the types it reads and writes: those and its system's own only.
   * Asked for under no run (or not its own), the union of what the system's fns declare, unless one declares none.
   */
  async #types(link: LinkSession, body: unknown): Promise<Refusal | undefined> {
    const parsed = TypesBody.safeParse(body);
    if (!parsed.success) { return undefined; }
    const run = parsed.data.run === undefined ? undefined : await this.#ownRun(link, parsed.data.run);
    const declared = await this.#declaredTypes(link, run, 'read');
    if (declared === undefined) { return undefined; }
    const outside = parsed.data.names.filter((name) => splitName(name).system !== link.system && !declared.has(name));
    if (outside.length === 0) { return undefined; }
    const asker = run === undefined ? `${link.system}'s fns declare the types they read and write` : `${run.fn} declares the types it reads and writes`;
    return { rule: 'types', attempt: outside.join(', '), run: run?.id, fn: run?.fn, detail: `${asker}, and ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not among them` };
  }

  /**
   * A record endpoint: under a run of the system's whose fn declares a mode, that mode must reach the change (saving
   * needs `write`, removing `delete`); and the record's type must be among the types declared (`#declaredTypes`), or
   * the system's own. Under no run, the types the system's fns declare between them.
   */
  async #data(link: LinkSession, body: unknown, needs: FnMode): Promise<Refusal | undefined> {
    const parsed = DataBody.safeParse(body);
    if (!parsed.success) { return undefined; }
    const { type } = parsed.data;
    const run = parsed.data.run === undefined ? undefined : await this.#ownRun(link, parsed.data.run);
    const declaredMode = run === undefined ? undefined : (await this.#options.catalog.fn(run.fn))?.decl.effects?.mode;
    if (run !== undefined && declaredMode !== undefined && MODE_RANK[needs] > MODE_RANK[declaredMode]) {
      return { rule: 'mode', attempt: type, run: run.id, fn: run.fn, detail: `${run.fn} is declared ${declaredMode} and tried to ${needs === 'delete' ? 'remove' : 'save'} a ${type} record` };
    }
    if (splitName(type).system === link.system) { return undefined; }
    const declared = await this.#declaredTypes(link, run, needs);
    if (declared === undefined || declared.has(type)) { return undefined; }
    const asker = run === undefined ? `${link.system}'s fns declare the types they ${needs === 'read' ? 'read and write' : 'write'}` : `${run.fn} declares the types it ${needs === 'read' ? 'reads and writes' : 'writes'}`;
    return { rule: 'types', attempt: type, run: run?.id, fn: run?.fn, detail: `${asker}, and ${type} is not among them` };
  }

  /**
   * The types a run's fn declares (or, under no run, the system's fns between them): those it reads and writes, or for a
   * change only those it writes. Undefined when a fn declares none, so nothing is narrowed.
   */
  async #declaredTypes(link: LinkSession, run: Run | undefined, use: FnMode): Promise<Set<QualifiedName> | undefined> {
    const fns = run === undefined ? await this.#options.catalog.fns({ system: link.system }) : [await this.#options.catalog.fn(run.fn)];
    const declared = new Set<QualifiedName>();
    for (const fn of fns) {
      const effects = fn?.decl.effects;
      if (effects === undefined || (effects.reads === undefined && effects.writes === undefined)) { return undefined; }
      for (const name of [...(use === 'read' ? effects.reads ?? [] : []), ...(effects.writes ?? [])]) { declared.add(name); }
    }
    return declared;
  }

  /**
   * A model call: its model or role must be granted, and the run and the system's day must be under their caps. A call
   * that names no model uses its role's (`chat` for `llm`, `ROLE_OF` for the rest), so that role must be granted;
   * automatic selection, or a modality with no role, may pick any model, so it is refused once roles or models are declared.
   * An embedding is the `embed` capability's: it uses the hub's embedder, not a model role.
   */
  async #model(link: LinkSession, grants: SystemGrants, endpoint: string, body: { run?: RunId | undefined; model?: ModelChoice | undefined; modality?: string | undefined } | undefined): Promise<Refusal | undefined> {
    const limits = grants.models;
    if (limits === undefined || body === undefined) { return undefined; }
    const run = body.run;
    const choice = body.model;
    if (choice !== undefined && 'model' in choice && !(limits.models ?? []).includes(choice.model)) {
      return { rule: 'models', attempt: choice.model, run, detail: `it didn't declare that it uses the model ${choice.model}` };
    }
    if (choice !== undefined && 'category' in choice && limits.roles !== undefined && !limits.roles.some((role) => role === choice.category)) {
      return { rule: 'models', attempt: choice.category, run, detail: `it didn't declare that it uses the ${choice.category} models` };
    }
    const restricted = limits.roles !== undefined || limits.models !== undefined;
    if (choice !== undefined && 'auto' in choice && restricted) {
      return { rule: 'models', attempt: 'auto', run, detail: 'it declared the models it uses, and automatic selection may pick any model' };
    }
    if (choice === undefined && body.modality !== 'embed') {
      const role = endpoint === 'llm' ? 'chat' : roleOfModality(body.modality);
      if (role === undefined && restricted) {
        return { rule: 'models', attempt: body.modality ?? endpoint, run, detail: `it declared the models it uses, and a ${body.modality ?? endpoint} call that names none may use any model` };
      }
      if (role !== undefined && limits.roles !== undefined && !limits.roles.includes(role)) {
        return { rule: 'models', attempt: role, run, detail: `it names no model, so it would use the ${role} role, which it didn't declare` };
      }
    }
    if (limits.perDay !== undefined) {
      const spent = await this.spentToday(link.system);
      if (spent >= limits.perDay) { return { rule: 'budget', attempt: endpoint, run, detail: `it has spent $${spent.toFixed(4)} today, its cap of $${limits.perDay.toFixed(4)} per day` }; }
    }
    if (limits.perRun !== undefined) {
      // a per-run cap only holds when every model call names the run it is for
      const row = run === undefined ? undefined : await this.#ownRun(link, run);
      if (row === undefined) { return { rule: 'budget', attempt: endpoint, run, detail: `it declares a cap of $${limits.perRun.toFixed(4)} per run, so each model call must name one of its own runs` }; }
      if (row.totalCost >= limits.perRun) {
        return { rule: 'budget', attempt: endpoint, run, fn: row.fn, detail: `this run has spent $${row.totalCost.toFixed(4)}, its cap of $${limits.perRun.toFixed(4)} per run` };
      }
    }
    return undefined;
  }

  /** What a system's runs spent in the last day, from the ledger. */
  async spentToday(system: SystemName): Promise<number> {
    const { store, clock } = this.#options;
    let total = 0;
    let cursor: string | undefined;
    do {
      const page = await store.table('ledger').find({ where: { system, at: { gt: clock() - DAY } }, limit: 500, ...(cursor === undefined ? {} : { cursor }) });
      for (const entry of page.items) { total += entry.cost; }
      cursor = page.cursor;
    } while (cursor !== undefined);
    return total;
  }
}
