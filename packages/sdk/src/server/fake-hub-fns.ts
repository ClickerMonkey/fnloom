/**
 * The hub's fns in memory, for tests of systems that keep and find fns through the hub: `hub/save_fn` and `hub/fn_get`
 * (calls), and the link's `searchFns` and `fnExamples` (`ctx.searchFns`, `ctx.fnExamples`). `FakeHub` holds one as
 * `fns`. It matches by words only and scores by the share of the query's words found: the real hub searches its
 * database by meaning and words.
 */
import {
  InstanceName, QualifiedName, SystemName, mintId, qualify, splitName, type FnExamplesPage, type FnExamplesQuery, type FnSearchHit, type FnSearchPage, type FnSearchQuery, type Json, type RunSettled,
} from '@harness/core';
import { encodeValue, parseValue, type GinType, type Infer } from '../gin.ts';
import { SAVE_FN_TAKEN, SaveFnArgs, StoredFn, hub } from '../hub.ts';

/** A fn kept in the fake hub: the latest save, its version and the saves before it. */
export interface KeptFn {
  readonly fn: string;
  readonly saved: Infer<typeof SaveFnArgs>;
  readonly version: number;
  /** Every earlier save, oldest first. */
  readonly history: ReadonlyArray<Infer<typeof SaveFnArgs>>;
}

/** A call the fake hub got. */
interface HubCall {
  readonly fn: string;
  readonly args: Json;
}

/** A name as the hub types it, or `undefined` when it isn't qualified (`system/name`). */
function qualified(name: string): QualifiedName | undefined {
  const parsed = QualifiedName.safeParse(name);
  return parsed.success ? parsed.data : undefined;
}

/** The words of a text, lower case, three letters or more. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
}

/** The hub's kept fns in memory. */
export class FakeHubFns {
  readonly kept = new Map<string, KeptFn>();
  /** The hub fns called and link searches made, in order (`hub/save_fn`, `searchFns`, …). */
  readonly called: string[] = [];

  /** Settle a call to `hub/save_fn` or `hub/fn_get`; `undefined` for any other fn. */
  settle(call: HubCall): RunSettled | undefined {
    if (call.fn !== hub.fns.save_fn.name && call.fn !== hub.fns.fn_get.name) { return undefined; }
    this.called.push(call.fn);
    try {
      return call.fn === hub.fns.save_fn.name
        ? this.#done(hub.fns.save_fn.returns, this.save(parseValue(SaveFnArgs, call.args)))
        : this.#get(parseValue(hub.fns.fn_get.args, call.args).fn);
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      return { status: 'failed', error: { class: 'caller', message: error instanceof Error ? error.message : String(error), ...(code === undefined ? {} : { code }) } };
    }
  }

  /** Keep a fn as `hub/save_fn` does; a taken name without `replace` throws with `SAVE_FN_TAKEN`. */
  save(args: Infer<typeof SaveFnArgs>): Infer<typeof hub.fns.save_fn.returns> {
    const fn = qualify(splitName(QualifiedName.parse(args.kind)).system, args.name);
    const prior = this.kept.get(fn);
    if (prior !== undefined && args.replace !== true) { throw Object.assign(new Error(`${fn} is taken.`), { code: SAVE_FN_TAKEN }); }
    const saved = prior?.saved.share !== undefined && args.share === undefined ? { ...args, share: prior.saved.share } : args;
    const version = (prior?.version ?? 0) + 1;
    this.kept.set(fn, { fn, saved, version, history: prior === undefined ? [] : [...prior.history, prior.saved] });
    return { fn, version, created: prior === undefined };
  }

  /** Search the kept fns as the link's `searchFns` does, by words, with the kind, system, instance and name filters. */
  search(query: FnSearchQuery): FnSearchPage {
    this.called.push('searchFns');
    const words = wordsOf(query.text ?? '');
    const hits = [...this.kept.values()].flatMap((kept): FnSearchHit[] => {
      const name = qualified(kept.fn);
      const kind = qualified(kept.saved.kind);
      const instance = kept.saved.routing?.to === 'instance' ? InstanceName.parse(kept.saved.routing.instance) : undefined;
      if (name === undefined || kind === undefined) { return []; }
      const system = SystemName.parse(splitName(name).system);
      if (query.kinds !== undefined && !query.kinds.some((wanted) => wanted === kind)) { return []; }
      if (query.systems !== undefined && !query.systems.includes(system)) { return []; }
      if (query.instance !== undefined && instance !== query.instance) { return []; }
      if (query.names !== undefined && !query.names.includes(name)) { return []; }
      const has = new Set(wordsOf(`${kept.saved.name} ${kept.saved.description}`));
      const score = words.length === 0 ? undefined : words.filter((word) => has.has(word)).length / words.length;
      if (score === 0) { return []; }
      return [{ item: 'fn', name, system, description: kept.saved.description, kind, available: true, ...(score === undefined ? {} : { score }), ...(instance === undefined ? {} : { instance }) }];
    });
    hits.sort((a, b) => (query.order === 'alphabetical' || a.score === undefined ? a.name.localeCompare(b.name) : (b.score ?? 0) - (a.score ?? 0)));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 10;
    const items = hits.slice(offset, offset + limit);
    return { items, ...(offset + items.length < hits.length ? { next: offset + items.length } : {}) };
  }

  /** A page of a kept fn's examples, as the link's `fnExamples` gives it (in their saved order). */
  examples(query: FnExamplesQuery): FnExamplesPage {
    this.called.push('fnExamples');
    const all = this.kept.get(query.fn)?.saved.examples ?? [];
    const offset = query.offset ?? 0;
    const page = all.slice(offset, offset + (query.limit ?? 5));
    return {
      fn: query.fn,
      items: page.map((example) => ({ ...example, id: mintId('fnExample') })),
      total: all.length,
      ...(offset + page.length < all.length ? { next: offset + page.length } : {}),
    };
  }

  #get(name: string): RunSettled {
    const kept = this.kept.get(name);
    if (kept === undefined) { return { status: 'failed', error: { class: 'caller', message: `No such fn: ${name}.`, code: 'not-found' } }; }
    const { saved } = kept;
    return this.#done(StoredFn, {
      fn: kept.fn, kind: saved.kind, description: saved.description, payload: saved.payload, version: kept.version, available: true,
      ...(saved.instructions === undefined ? {} : { instructions: saved.instructions }),
      ...(saved.routing === undefined ? {} : { routing: saved.routing }),
    });
  }

  #done<T>(type: GinType<T>, value: T): RunSettled {
    return { status: 'done', result: encodeValue(type, value) };
  }
}
