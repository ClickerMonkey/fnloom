/**
 * A fn's facts, worked out deeply. Its own part comes from its declaration (or its kind's description of its
 * payload): `effects` when given, else the mode from the `read` tag (agents read until their tools say otherwise),
 * the types it reads from its result's named types, and those it writes from its args' when it isn't read-only. Then
 * every fn it uses (its deps, an agent's tools), followed to a tunable depth, folds in: the strongest mode, the union
 * of the types, and free only when all of them are. The stored part (`fnFacts`, `fnTypes`) is what search filters on;
 * `fnUses` lists what each fn uses so a changed fn refreshes the fns that use it. The cost estimate (from its kind's `CostEstimator`) and run times (from `fnMetrics`) are read when asked.
 */
import { READ_TAG, QualifiedName, type FnFacts, type FnFactsRecord, type FnMetricsDay, type FnMode, type FnRecord, type FnTypeUse, type Json, type RunTimes } from '@harness/core';
import { parseValue, LlmPayloadType } from '@harness/sdk';
import type { Catalog } from '../catalog/index.ts';
import { GinScopes } from '../catalog/scope.ts';
import { AGENT_KIND } from '../execution/index.ts';
import { allRows, rows } from '../execution/pages.ts';
import type { FnMetricsService } from '../metrics/index.ts';
import { emptyDurations, mergeDurations, percentile } from '../metrics/rollup.ts';
import type { HubStore } from '../store/index.ts';
import { estimateCost } from './costs.ts';
import type { FnsTuning } from './env.ts';
import { strongerMode, type CostEstimator, type FnFactsService } from './index.ts';

/** What facts read. */
export interface FnFactsDeps {
  readonly store: () => HubStore;
  readonly catalog: () => Pick<Catalog, 'fn' | 'type'>;
  readonly metrics: () => Pick<FnMetricsService, 'days'>;
  /** The estimators, asked in order (`costs.ts`). */
  readonly estimators: readonly CostEstimator[];
  readonly clock: () => number;
  readonly tuning: Pick<FnsTuning, 'HARNESS_FN_FACTS_DEPTH' | 'HARNESS_FN_LONG_RUNNING' | 'HARNESS_FN_HISTORY_DAYS'>;
}

/** A fn's own facts, before what it uses is folded in. */
interface OwnFacts {
  readonly mode: FnMode;
  readonly reads: readonly QualifiedName[];
  readonly writes: readonly QualifiedName[];
  readonly free: boolean;
  readonly uses: readonly QualifiedName[];
}

/** The longest a duration reads as minutes rather than seconds. */
const MINUTE = 60_000;

/** "about 3 minutes", "about 40 seconds". */
export function aboutDuration(ms: number): string {
  if (ms >= MINUTE) {
    const minutes = Math.round(ms / MINUTE);
    return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const seconds = Math.max(1, Math.round(ms / 1_000));
  return `about ${seconds} second${seconds === 1 ? '' : 's'}`;
}

/** Facts on the hub's store. */
export class StoreFnFacts implements FnFactsService {
  readonly #deps: FnFactsDeps;
  readonly #scopes = new GinScopes();

  constructor(deps: FnFactsDeps) {
    this.#deps = deps;
  }

  async facts(name: QualifiedName, args?: Json): Promise<FnFacts> {
    const fn = await this.#deps.catalog().fn(name);
    if (fn === undefined) throw new Error(`there is no fn ${name}`);
    const stored = await this.#stored(fn);
    const history = await this.#deps.metrics().days(fn.name, this.#deps.tuning.HARNESS_FN_HISTORY_DAYS);
    const cost = await estimateCost(this.#deps.estimators, { fn, free: stored.free, args, history });
    const times = runTimes(history);
    const longRunning = times !== undefined && times.typical > this.#deps.tuning.HARNESS_FN_LONG_RUNNING;
    return {
      fn: fn.name, kind: fn.decl.kind, mode: stored.mode, reads: stored.reads, writes: stored.writes, uses: stored.uses, free: stored.free, cost,
      ...(times === undefined ? {} : { times }), longRunning,
      ...(longRunning ? { notice: `${fn.name} usually takes ${aboutDuration(times.typical)}.` } : {}),
    };
  }

  async modes(fns: readonly QualifiedName[]): Promise<ReadonlyMap<QualifiedName, FnMode>> {
    const out = new Map<QualifiedName, FnMode>();
    for (const name of new Set(fns)) {
      const row = await this.#deps.store().table('fnFacts').get(name);
      if (row !== undefined) { out.set(name, row.mode); continue; }
      const fn = await this.#deps.catalog().fn(name);
      if (fn !== undefined) out.set(name, (await this.#stored(fn)).mode);
    }
    return out;
  }

  async refresh(fns: readonly FnRecord[], removed: readonly QualifiedName[]): Promise<void> {
    for (const fn of fns) await this.#save(fn, await this.#deep(fn));
    for (const name of removed) await this.#forget(name);
    // the fns that use a changed one (to any depth: `fnUses` holds the deep list) are worked out again
    const changed = [...fns.map((fn) => fn.name), ...removed];
    if (changed.length === 0) return;
    const done = new Set(changed);
    const users = new Set<QualifiedName>();
    for await (const row of rows(this.#deps.store().table('fnUses'), { where: { uses: { in: changed } } })) if (!done.has(row.fn)) users.add(row.fn);
    for (const name of users) {
      const fn = await this.#deps.catalog().fn(name);
      if (fn !== undefined) await this.#save(fn, await this.#deep(fn));
    }
  }

  /** The stored facts, worked out and saved first when there are none yet. */
  async #stored(fn: FnRecord): Promise<FnFactsRecord> {
    const row = await this.#deps.store().table('fnFacts').get(fn.name);
    return row ?? this.#save(fn, await this.#deep(fn));
  }

  /** A fn's facts with everything it uses folded in, followed breadth first to the depth limit. */
  async #deep(fn: FnRecord): Promise<OwnFacts> {
    const own = await this.#own(fn);
    let mode = own.mode;
    let free = own.free;
    const reads = new Set(own.reads);
    const writes = new Set(own.writes);
    const seen = new Set<QualifiedName>([fn.name]);
    let next = [...own.uses];
    for (let depth = 0; depth < this.#deps.tuning.HARNESS_FN_FACTS_DEPTH && next.length > 0; depth++) {
      const later: QualifiedName[] = [];
      for (const name of next) {
        if (seen.has(name)) continue;
        seen.add(name);
        const used = await this.#deps.catalog().fn(name);
        if (used === undefined) continue;
        const facts = await this.#own(used);
        mode = strongerMode(mode, facts.mode);
        free &&= facts.free;
        for (const type of facts.reads) reads.add(type);
        for (const type of facts.writes) writes.add(type);
        later.push(...facts.uses);
      }
      next = later;
    }
    seen.delete(fn.name);
    return { mode, free, reads: [...reads].sort(), writes: [...writes].sort(), uses: [...seen].sort() };
  }

  /** A fn's own facts, from what it declares and its signature. */
  async #own(fn: FnRecord): Promise<OwnFacts> {
    const { decl } = fn;
    const agent = decl.kind === AGENT_KIND;
    const tools = agent ? parseValue(LlmPayloadType, decl.payload).tools.flatMap((tool) => { const name = QualifiedName.safeParse(tool); return name.success ? [name.data] : []; }) : [];
    const mode = decl.effects?.mode ?? (agent || decl.tags.includes(READ_TAG) ? 'read' : 'write');
    const reads = decl.effects?.reads ?? await this.#named(this.#scopes.mentions(decl.returns));
    const writes = decl.effects?.writes ?? (mode === 'read' ? [] : await this.#named(this.#scopes.mentions(decl.args)));
    // an agent always spends on its model; anything else spends only if it says so or its history shows it
    const free = decl.effects?.free ?? (!agent && decl.limits.cost === undefined && fn.stats.averageCost === 0);
    return { mode, reads, writes, free, uses: [...new Set([...decl.deps, ...tools])] };
  }

  /** The names that are stored named types. */
  async #named(names: readonly string[]): Promise<QualifiedName[]> {
    const out: QualifiedName[] = [];
    for (const name of names) {
      const parsed = QualifiedName.safeParse(name);
      if (parsed.success && (await this.#deps.catalog().type(parsed.data)) !== undefined) out.push(parsed.data);
    }
    return out;
  }

  /** Store a fn's facts and its type uses. */
  async #save(fn: FnRecord, facts: OwnFacts): Promise<FnFactsRecord> {
    const instance = fn.decl.routing?.to === 'instance' ? fn.decl.routing.instance : undefined;
    const record: FnFactsRecord = {
      fn: fn.name, system: fn.system, kind: fn.decl.kind, mode: facts.mode, reads: [...facts.reads], writes: [...facts.writes], uses: [...facts.uses], free: facts.free,
      ...(instance === undefined ? {} : { instance }), updatedAt: this.#deps.clock(),
    };
    const uses: FnTypeUse[] = [
      ...facts.reads.map((type) => ({ fn: fn.name, type, use: 'read' as const })),
      ...facts.writes.map((type) => ({ fn: fn.name, type, use: 'write' as const })),
    ];
    await this.#deps.store().tx(async (store) => {
      for (const row of await allRows(store.table('fnTypes'), { where: { fn: fn.name } })) await store.table('fnTypes').remove(row);
      for (const row of uses) await store.table('fnTypes').put(row);
      for (const row of await allRows(store.table('fnUses'), { where: { fn: fn.name } })) await store.table('fnUses').remove(row);
      for (const used of facts.uses) await store.table('fnUses').put({ fn: fn.name, uses: used });
      await store.table('fnFacts').put(record);
    });
    return record;
  }

  /** Drop a removed fn's facts. */
  async #forget(name: QualifiedName): Promise<void> {
    await this.#deps.store().tx(async (store) => {
      for (const row of await allRows(store.table('fnTypes'), { where: { fn: name } })) await store.table('fnTypes').remove(row);
      for (const row of await allRows(store.table('fnUses'), { where: { fn: name } })) await store.table('fnUses').remove(row);
      await store.table('fnFacts').remove(name);
    });
  }
}

/** Run times from a fn's daily metrics: the median and 95th percentile of the merged histograms. */
export function runTimes(days: readonly FnMetricsDay[]): RunTimes | undefined {
  const ran = days.reduce((all, day) => mergeDurations(all, day.ran), emptyDurations());
  if (ran.count === 0) return undefined;
  return { runs: ran.count, typical: percentile(ran, 0.5) ?? ran.max, slow: percentile(ran, 0.95) ?? ran.max, longest: ran.max };
}
