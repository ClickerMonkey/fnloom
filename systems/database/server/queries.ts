/**
 * Saved queries on one instance, from the model's side: finding one to reuse for a request (names, embeddings and
 * the decision model), writing and keeping a new one, editing one (its old version kept), and running one into what
 * the model reads. Reads run straight away, their rows attached for the person; a write is proposed as a run of its
 * fn that waits for the person's approval, with a preview of what it would do.
 */
import { Json, qualify, type ApprovalPreview, type DecideAnswer, type DecideCandidate, type ProposedRun, type ResultTable, type RunInfo, type ShareRule } from '@harness/core';
import type { AnyFnDef, Llm, Log, ResultBlock } from '@harness/sdk';
import { resultBlock } from '@harness/sdk/server';
import { database } from '../shared/index.ts';
import { QueryPayload, SortArg, type QueryAnswer, type QueryHow, type WriteResult } from '../shared/shapes.ts';
import { WrittenQuery, type QueryAuthor } from './author.ts';
import { argsTypeOf, signatureOf, type CallPlan, type CompiledQuery, type Refusal } from './compile.ts';
import type { DatabaseSettings } from './env.ts';
import type { DatabaseInstance } from './instance.ts';
import { resultTable } from './results.ts';
import type { InstanceStore, SavedQuery } from './store.ts';
import { cosine, embedOne } from './vectors.ts';

/** What running a query needs from the run it is part of. */
export interface QueryRunCtx {
  readonly llm: Llm;
  readonly run: RunInfo;
  readonly log: Log;
  usableFns(fns: readonly string[]): Promise<string[]>;
  shareFn(fn: string, share: ShareRule): Promise<void>;
  decide(question: string, candidates: readonly DecideCandidate[], options?: { max?: number }): Promise<DecideAnswer>;
  propose(fn: string, args: Json, options: { preview: ApprovalPreview; approver?: 'person' | 'admins' }): Promise<ProposedRun>;
  /** Attach rows for the person. */
  attach(table: ResultTable, title: string): void;
}

/** Adds and removes fns at runtime (the running system's `add` and `remove`). */
export interface RuntimeFns {
  add(name: string, def: AnyFnDef): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Why a request couldn't be answered: the caller's to fix (`invalid`), or a failure. */
export type QueryProblem = { invalid: string } | { failed: string };

/** A fn's local name from a saved name (`Overdue invoices!` becomes `overdue_invoices`). */
export function slugOf(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return slug === '' || /^[0-9]/.test(slug) ? `query_${slug}` : slug;
}

/**
 * Where a saved query's name points: its instance and its stored name (`<instance>.<name>`). Takes the qualified name
 * (`database/main.orders`), the stored one (`main.orders`), or a bare one (`orders`), which means this instance.
 */
export function savedQueryName(name: string, here: string): { instance: string; stored: string } {
  const unqualified = name.replace(/^database\//, '');
  const dot = unqualified.indexOf('.');
  return dot <= 0 ? { instance: here, stored: `${here}.${unqualified}` } : { instance: unqualified.slice(0, dot), stored: unqualified };
}

/** The kind fn a saved query becomes. */
export function queryFn(query: SavedQuery, compiled: CompiledQuery | undefined): AnyFnDef {
  return database.kinds.query.fn({
    description: compiled?.writes === true ? `${query.payload.description} (Writes: waits for approval.)` : query.payload.description,
    payload: query.payload,
    tags: ['database', 'query', ...(compiled?.writes === true ? ['write'] : [])],
  });
}

/** The call's args a saved query's fn takes, read out of JSON: its params, the page and the sort. */
export function callArgs(args: Json): { values: Record<string, Json>; sort: SortArg } {
  const values: Record<string, Json> = {};
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args)) { if (key !== 'sort') { values[key] = value; } }
  }
  const sort = SortArg.safeParse(typeof args === 'object' && args !== null && !Array.isArray(args) ? args['sort'] : undefined);
  return { values, sort: sort.success ? sort.data : [] };
}

/** The saved queries of one instance, and running them for the model. */
export class QueryService {
  readonly #instance: () => DatabaseInstance | undefined;
  readonly #store: InstanceStore;
  readonly #author: QueryAuthor;
  readonly #settings: DatabaseSettings;
  readonly #runtime: () => RuntimeFns | undefined;
  readonly #now: () => number;

  constructor(deps: { instance: () => DatabaseInstance | undefined; store: InstanceStore; author: QueryAuthor; settings: DatabaseSettings; runtime: () => RuntimeFns | undefined; now: () => number }) {
    this.#instance = deps.instance;
    this.#store = deps.store;
    this.#author = deps.author;
    this.#settings = deps.settings;
    this.#runtime = deps.runtime;
    this.#now = deps.now;
  }

  /** The configured instance, or why there is none. */
  instance(): DatabaseInstance | QueryProblem {
    return this.#instance() ?? { failed: 'This database is not configured yet: an admin sets its connection on the system\'s page.' };
  }

  /** `get_query`: reuse a saved query that fits the request, else write and keep one; then run it. */
  async get(request: string, ctx: QueryRunCtx): Promise<QueryAnswer | QueryProblem> {
    const instance = this.instance();
    if (!('db' in instance)) { return instance; }
    const reuse = await this.#reusable(instance, request, ctx);
    if (reuse !== undefined) {
      const signature = this.signature(instance, reuse.query);
      const args = await this.#author.argsFor(request, signature, ctx.llm);
      ctx.log.info('database.reused', { query: reuse.query.name });
      return this.execute(instance, reuse.query, args, 'reused', reuse.why, ctx);
    }
    const authored = await this.#author.write(request, instance.catalog, { writes: instance.writes }, ctx.llm);
    if ('problems' in authored) { return { invalid: `The query agent couldn't write a query for this: ${authored.problems.join(' ')} Describe the rows and columns more exactly, using the table and column names.` }; }
    const saved = await this.#save(instance, authored.written, ctx);
    ctx.log.info('database.created', { query: saved.name, writes: authored.compiled.writes });
    return this.execute(instance, saved, authored.written.args, 'created', 'No saved query fit, so a new one was written and kept.', ctx);
  }

  /** `edit_query`: change a saved query by instructions, keep its old version, and run the new one. */
  async edit(name: string, instructions: string, ctx: QueryRunCtx): Promise<QueryAnswer | QueryProblem> {
    const instance = this.instance();
    if (!('db' in instance)) { return instance; }
    const { stored } = savedQueryName(name, instance.instance);
    const saved = (await this.#store.queries()).find((query) => query.name === stored);
    if (saved === undefined || !(await ctx.usableFns([saved.name])).includes(saved.name)) {
      return { invalid: `There is no saved query ${name} you may use here. Saved query fns are named database/${instance.instance}.<name>.` };
    }
    const current = WrittenQuery.parse({ name: saved.name.slice(instance.instance.length + 1), title: saved.title, description: saved.payload.description, query: saved.payload.query, sorters: saved.payload.sorters });
    const authored = await this.#author.edit(current, instructions, instance.catalog, { writes: instance.writes }, ctx.llm);
    if ('problems' in authored) { return { invalid: `The query agent couldn't make that change: ${authored.problems.join(' ')}` }; }
    const payload = this.#payload(instance, authored.written, authored.compiled);
    const edited: SavedQuery = {
      ...saved,
      title: authored.written.title,
      payload,
      vector: await embedOne(ctx.llm, `${authored.written.title}. ${payload.description}`),
      savedAt: this.#now(),
      history: [...saved.history, { payload: saved.payload, savedAt: saved.savedAt, note: instructions }],
    };
    const runtime = this.#runtime();
    if (runtime === undefined) { return { failed: 'The database system is not serving yet.' }; }
    await runtime.remove(saved.name);
    await runtime.add(saved.name, queryFn(edited, authored.compiled));
    await this.#store.putQuery(edited);
    ctx.log.info('database.edited', { query: saved.name, versions: edited.history.length + 1 });
    return this.execute(instance, edited, authored.written.args, 'edited', `Changed as asked; the version before is kept (${edited.history.length} earlier).`, ctx);
  }

  /** A saved query's one-line signature. */
  signature(instance: DatabaseInstance, query: SavedQuery): string {
    const compiled = instance.compile(query.payload);
    const fn = qualify(database.name, query.name);
    return 'query' in compiled ? signatureOf(fn, argsTypeOf(compiled, query.payload.sorters, this.#limits())) : `${fn}(…)`;
  }

  /** Run a saved query for the model: a read's result, or a write proposed for approval. */
  async execute(instance: DatabaseInstance, query: SavedQuery, args: Readonly<Record<string, Json>>, how: QueryHow, why: string, ctx: QueryRunCtx): Promise<QueryAnswer | QueryProblem> {
    const compiled = instance.compile(query.payload);
    if (!('query' in compiled)) { return this.#stale(query, compiled); }
    const { values, sort } = callArgs(args);
    const plan = instance.plan(compiled, values, sort);
    const fn = { name: qualify(database.name, query.name), signature: this.signature(instance, query) };
    const base = {
      database: instance.info,
      fn: { ...fn, how, why },
      query: { sql: plan.sql, structured: Json.parse(compiled.def), params: plan.bound, writes: compiled.writes },
    };
    if (compiled.writes) {
      const preview = await this.preview(instance, compiled, plan, query.payload.description);
      const proposed = await ctx.propose(query.name, values, { preview, approver: 'person' });
      return {
        ...base,
        approval: { run: proposed.run, state: 'waiting', says: `${preview.title}: this waits for the person to approve it in the chat. Tell them what it will do and end your turn; once approved it runs and its result shows, and if they decline you are told why.` },
      };
    }
    return { ...base, result: await this.read(instance, compiled, plan, fn, values, ctx) };
  }

  /** Read rows for a call: attach them for the person, and give the model its result block. */
  async read(instance: DatabaseInstance, compiled: CompiledQuery, plan: CallPlan, fn: { name: string; signature: string }, args: Readonly<Record<string, Json>>, ctx: Pick<QueryRunCtx, 'attach'>): Promise<ResultBlock> {
    const table = resultTable(await instance.read(plan), compiled.columns, plan);
    ctx.attach(table, fn.name);
    return resultBlock(table, { fn, args });
  }

  /** Run an approved write, and what the model reads about it. */
  async write(instance: DatabaseInstance, compiled: CompiledQuery, plan: CallPlan, fn: { name: string; signature: string }, ctx: Pick<QueryRunCtx, 'attach'>): Promise<WriteResult> {
    const written = await instance.write(plan);
    const shown = `${written.affected} ${written.affected === 1 ? 'row' : 'rows'} changed.`;
    if (written.columns.length === 0) { return { shown, affected: written.affected }; }
    const table = resultTable(written, compiled.columns, { offset: 0, limit: undefined, sort: [] });
    ctx.attach(table, fn.name);
    return { shown, affected: written.affected, returned: resultBlock(table, { fn }) };
  }

  /** What a write would do: its SQL, how many rows (from a rolled-back run), and the rows it matches now. */
  async preview(instance: DatabaseInstance, compiled: CompiledQuery, plan: CallPlan, description: string): Promise<ApprovalPreview> {
    const dry = await instance.dryRun(plan);
    const verb = compiled.def.kind === 'insert' ? 'Insert' : compiled.def.kind === 'delete' ? 'Delete' : 'Change';
    const target = compiled.tables[0] ?? 'rows';
    const parts: ApprovalPreview['parts'] = [
      { type: 'text', text: description },
      { type: 'code', language: 'sql', code: plan.sql, title: 'SQL' },
    ];
    const matched = await this.#matched(instance, compiled, plan);
    if (matched !== undefined) { parts.push({ type: 'table', title: compiled.def.kind === 'delete' ? 'Rows it deletes' : 'Rows it changes', table: matched }); }
    return { title: `${verb} ${dry.affected} ${dry.affected === 1 ? 'row' : 'rows'} in ${target}`, parts, irreversible: compiled.def.kind === 'delete' };
  }

  /** Add every saved query of this instance as a fn again (after a restart). */
  async restore(instance: DatabaseInstance): Promise<number> {
    const runtime = this.#runtime();
    if (runtime === undefined) { return 0; }
    const saved = (await this.#store.queries()).filter((query) => query.payload.instance === instance.instance);
    for (const query of saved) {
      const compiled = instance.compile(query.payload);
      await runtime.add(query.name, queryFn(query, 'query' in compiled ? compiled : undefined));
    }
    return saved.length;
  }

  #limits(): { page: number; max: number } {
    return { page: this.#settings.DATABASE_PAGE_ROWS, max: this.#settings.DATABASE_MAX_ROWS };
  }

  /** A saved query the tables no longer fit. */
  #stale(query: SavedQuery, refusal: Refusal): QueryProblem {
    return { invalid: `The saved query database/${query.name} no longer fits the tables: ${refusal.problems.join(' ')} Fix it with edit_query.` };
  }

  /** The rows an update or delete matches now, read with the same joins and conditions. */
  async #matched(instance: DatabaseInstance, compiled: CompiledQuery, plan: CallPlan): Promise<ResultTable | undefined> {
    const def = compiled.def;
    const target = def.kind === 'update' ? def.type : def.kind === 'delete' ? def.from : undefined;
    if (target === undefined || (def.kind !== 'update' && def.kind !== 'delete')) { return undefined; }
    const spec = instance.catalog.spec(target);
    if (spec === undefined) { return undefined; }
    const match = instance.compile({
      instance: instance.instance, description: 'matched rows', sorters: [], list: true,
      query: Json.parse({
        kind: 'select',
        fields: spec.columns.map((column) => ({ expr: { kind: 'field-ref', source: target, field: column.name }, as: column.name })),
        from: { kind: 'type', type: target },
        ...(def.joins === undefined ? {} : { joins: def.joins }),
        ...(def.where === undefined ? {} : { where: def.where }),
      }),
    });
    if (!('query' in match)) { return undefined; }
    const values: Record<string, Json> = { ...plan.bound, limit: this.#settings.DATABASE_PREVIEW_ROWS };
    const matchPlan = instance.plan(match, values, []);
    return resultTable(await instance.read(matchPlan), match.columns, matchPlan);
  }

  /** The saved query to reuse for a request, and why: one it names, else the decision model's pick, else the closest. */
  async #reusable(instance: DatabaseInstance, request: string, ctx: QueryRunCtx): Promise<{ query: SavedQuery; why: string } | undefined> {
    const mine = (await this.#store.queries()).filter((query) => query.payload.instance === instance.instance && 'query' in instance.compile(query.payload));
    if (mine.length === 0) { return undefined; }
    const allowed = new Set(await ctx.usableFns(mine.map((query) => query.name)));
    const usable = mine.filter((query) => allowed.has(query.name));
    if (usable.length === 0) { return undefined; }
    const asked = request.toLowerCase();
    const named = usable.find((query) => asked.includes(query.name.toLowerCase()) || asked.includes(`database/${query.name}`.toLowerCase()));
    if (named !== undefined) { return { query: named, why: 'The request names it.' }; }
    const vector = await embedOne(ctx.llm, request);
    const scored = usable
      .map((query) => ({ query, score: Math.max(0, cosine(vector, query.vector)) }))
      .filter((item) => item.score >= this.#settings.DATABASE_CANDIDATE_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.#settings.DATABASE_CANDIDATES);
    if (scored.length === 0) { return undefined; }
    const answer = await ctx.decide(
      `A database query for this request: ${request}`,
      scored.map((item) => ({ id: item.query.name, text: `${item.query.title}: ${item.query.payload.description} Signature: ${this.signature(instance, item.query)}`, score: item.score })),
      { max: 1 },
    );
    if (answer.by === 'decision') {
      const pick = answer.picked[0];
      const query = scored.find((item) => item.query.name === pick?.id)?.query;
      return query === undefined ? undefined : { query, why: pick?.why ?? 'The decision model picked it.' };
    }
    const best = scored[0];
    return best !== undefined && best.score >= this.#settings.DATABASE_REUSE_SCORE ? { query: best.query, why: `Its description matches the request (${best.score.toFixed(2)}).` } : undefined;
  }

  /** The payload of a written query. */
  #payload(instance: DatabaseInstance, written: WrittenQuery, compiled: CompiledQuery): QueryPayload {
    return QueryPayload.parse({
      instance: instance.instance,
      description: written.description,
      query: Json.parse(compiled.def),
      sorters: written.sorters.filter((name) => compiled.columns.some((column) => column.name === name)),
      list: compiled.list,
    });
  }

  /** Keep a new query: add its fn, give it to the instance's audience, then store it. */
  async #save(instance: DatabaseInstance, written: WrittenQuery, ctx: QueryRunCtx): Promise<SavedQuery> {
    const compiled = instance.compile({ instance: instance.instance, description: written.description, query: Json.parse(written.query), sorters: [], list: true });
    if (!('query' in compiled)) { throw new Error(`A checked query failed to compile again: ${compiled.problems.join(' ')}`); }
    const taken = new Set([...Object.keys(database.defs.fns), ...(await this.#store.queries()).map((query) => query.name)]);
    const base = `${instance.instance}.${slugOf(written.name)}`;
    let name = base;
    for (let n = 2; taken.has(name); n += 1) { name = `${base}_${n}`; }
    const saved: SavedQuery = {
      name,
      title: written.title,
      payload: this.#payload(instance, written, compiled),
      owner: ctx.run.user.id,
      vector: await embedOne(ctx.llm, `${written.title}. ${written.description}`),
      savedAt: this.#now(),
      history: [],
    };
    const runtime = this.#runtime();
    if (runtime === undefined) { throw new Error('The database system is not serving yet.'); }
    await runtime.add(name, queryFn(saved, compiled));
    try {
      await ctx.shareFn(name, instance.config.audience);
    } catch (error) {
      await runtime.remove(name);
      throw error;
    }
    await this.#store.putQuery(saved);
    return saved;
  }
}
