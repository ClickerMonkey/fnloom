/**
 * Queries on one instance, as the query agents' tools use them: the tables to write against, checking a draft, keeping
 * a checked one in the hub as a `database/query` fn of this instance (`hub/save_fn`), and running a saved one into
 * what the model reads. Saved queries are the hub's: their payload is read back with `hub/fn_get`, as the run's
 * person, so who may use one is always the hub's to say. Reads run straight away, their rows attached for the person;
 * a write is proposed as a run of its fn that waits for the person's approval, with a preview of what it would do.
 */
import { CallFailed, SAVE_FN_TAKEN, type Log, type ResultBlock } from '@harness/sdk';
import { Json, qualify, type InstanceName, type ApprovalPreview, type FnExample, type ProposedRun, type ResultTable, type RunInfo, type ShareRule, type UserInfo } from '@harness/core';
import { resultBlock } from '@harness/sdk/server';
import { QUERY_KIND, database } from '../shared/index.ts';
import { QueryPayload, SortArg, type QueryCheck, type QueryDraft, type QueryRun, type SavedQueryRef, type TablesInfo, type WriteResult } from '../shared/shapes.ts';
import { argProblems, argsTypeOf, signatureOf, type CallPlan, type CompiledQuery, type Refusal } from './compile.ts';
import type { DatabaseSettings } from './env.ts';
import type { DatabaseInstance } from './instance.ts';
import { resultTable } from './results.ts';

/** A saved fn as `hub/fn_get` gives it (the parts a query needs). */
export interface StoredQuery {
  readonly fn: string;
  readonly kind: string;
  readonly payload?: Json | undefined;
  readonly version: number;
}

/** What `hub/save_fn` is given for a query. */
export interface SaveQuery {
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly payload: Json;
  readonly examples: FnExample[];
  readonly tags: string[];
  readonly share: ShareRule;
  readonly routing: { to: 'instance'; instance: InstanceName };
  readonly replace?: boolean;
}

/** What running and saving a query need from the run they are part of. */
export interface QueryRunCtx {
  readonly run: RunInfo;
  readonly log: Log;
  propose(fn: string, args: Json, options: { preview: ApprovalPreview; approver?: 'person' | 'admins' }): Promise<ProposedRun>;
  /** Attach rows for the person. */
  attach(table: ResultTable, title: string): void;
  /** `hub/fn_get`: a saved fn, as the run's person may see it. */
  getFn(fn: string): Promise<StoredQuery>;
  /** `hub/save_fn`. */
  saveFn(save: SaveQuery): Promise<{ fn: string; version: number; created: boolean }>;
}

/** Why a request couldn't be answered: the caller's to fix (`invalid`), or a failure. */
export type QueryProblem = { invalid: string } | { failed: string };

/**
 * Whether a person may use a database with this audience (`DatabaseConfig.audience`): anyone when it is public; admins
 * always; otherwise the people and groups it names.
 */
export function mayUse(audience: ShareRule, user: UserInfo): boolean {
  if (audience.visibility === 'public' || user.role === 'admin') { return true; }
  return audience.visibility === 'shared' && (audience.with.includes(user.id) || user.groups.some((group) => audience.with.includes(group.id)));
}

/** What a person who may not use a database is told. */
export function notYours(label: string): { invalid: string } {
  return { invalid: `You may not use the ${label} database; an admin chooses who may on its config.` };
}

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

/** The call's args a saved query's fn takes, read out of JSON: its params, the page and the sort. */
export function callArgs(args: Json): { values: Record<string, Json>; sort: SortArg } {
  const values: Record<string, Json> = {};
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args)) { if (key !== 'sort') { values[key] = value; } }
  }
  const sort = SortArg.safeParse(typeof args === 'object' && args !== null && !Array.isArray(args) ? args['sort'] : undefined);
  return { values, sort: sort.success ? sort.data : [] };
}

/** A call's args again from its param values and sort (the sort left out when there is none). */
export function callOf(values: Readonly<Record<string, Json>>, sort: SortArg): Record<string, Json> {
  return sort.length === 0 ? { ...values } : { ...values, sort: sort.map((entry) => ({ column: entry.column, dir: entry.dir })) };
}

/** Whether an answer is a problem rather than what was asked for. */
export function isProblem<T extends object>(answer: T | QueryProblem): answer is QueryProblem {
  return 'invalid' in answer || 'failed' in answer;
}

/** Whether a hub call failed because the name is taken. */
function nameTaken(error: unknown): boolean {
  return error instanceof CallFailed && error.error.class !== 'cancelled' && error.error.code === SAVE_FN_TAKEN;
}

/** Where a saved query fn points: its instance and its local name (`database/main.orders` gives `main`, `main.orders`). */
export function queryInstance(fn: string): { instance: string; local: string } | undefined {
  const local = fn.replace(/^database\//, '');
  const dot = local.indexOf('.');
  return dot <= 0 ? undefined : { instance: local.slice(0, dot), local };
}

/** One instance's queries, for the query agents' tools. */
export class QueryService {
  readonly #instance: () => DatabaseInstance | undefined;
  readonly #settings: DatabaseSettings;

  constructor(deps: { instance: () => DatabaseInstance | undefined; settings: DatabaseSettings }) {
    this.#instance = deps.instance;
    this.#settings = deps.settings;
  }

  /** The configured instance the person may use, or why not. */
  instance(user: UserInfo): DatabaseInstance | QueryProblem {
    const instance = this.#instance();
    if (instance === undefined) { return { failed: 'This database is not configured yet: an admin sets its connection on the system\'s page.' }; }
    return mayUse(instance.config.audience, user) ? instance : notYours(instance.config.label);
  }

  /** `tables`: what the agent writes against. */
  tables(instance: DatabaseInstance): TablesInfo {
    return { database: instance.info, writes: instance.writes, schema: instance.catalog.describe() };
  }

  /** `check_query`: whether a draft runs here, its SQL and signature, or what to fix. */
  check(instance: DatabaseInstance, draft: QueryDraft): QueryCheck {
    const compiled = instance.compile(this.#payload(instance, draft));
    if (!('query' in compiled)) { return { ok: false, problems: compiled.problems }; }
    const problems = compiled.writes && !instance.writes ? [`${instance.config.label} is read-only: only select queries.`] : [];
    const plan = instance.plan(compiled, {}, []);
    const fn = qualify(database.name, `${instance.instance}.${draft.name}`);
    return { ok: problems.length === 0, problems, sql: plan.sql, signature: signatureOf(fn, argsTypeOf(compiled, draft.sorters ?? [], this.#limits())), writes: compiled.writes };
  }

  /** `save_query`: keep a checked draft in the hub as this instance's query fn; a taken name gets the next free one. */
  async save(
    instance: DatabaseInstance, draft: QueryDraft,
    extra: { args?: Readonly<Record<string, Json>> | undefined; askedFor?: string | undefined; replace?: boolean | undefined }, ctx: QueryRunCtx,
  ): Promise<SavedQueryRef | QueryProblem> {
    const compiled = instance.compile(this.#payload(instance, draft));
    if (!('query' in compiled)) { return { invalid: `The draft doesn't run here: ${compiled.problems.join(' ')} Fix it with check_query first.` }; }
    if (compiled.writes && !instance.writes) { return { invalid: `${instance.config.label} is read-only: a query that writes can't be saved.` }; }
    const payload = this.#payload(instance, draft, compiled);
    const example: FnExample = { args: Json.parse({ ...extra.args }), ...(extra.askedFor === undefined ? {} : { note: extra.askedFor }) };
    for (let attempt = 0; attempt < this.#settings.DATABASE_NAME_TRIES; attempt += 1) {
      const name = `${instance.instance}.${attempt === 0 ? draft.name : `${draft.name}_${attempt + 1}`}`;
      try {
        const saved = await ctx.saveFn({
          kind: QUERY_KIND, name, payload: Json.parse(payload),
          description: compiled.writes ? `${draft.description} (Writes: waits for approval.)` : draft.description,
          instructions: `${draft.title}, on the ${instance.config.label} database. ${compiled.writes ? 'A write: every run waits for the person to approve it.' : 'Its rows are shown to the person; you get the columns, counts and first rows. Page with limit and offset.'}`,
          examples: [example],
          tags: ['database', 'query', ...(compiled.writes ? ['write'] : [])],
          share: instance.config.audience,
          // a saved query reads its own database, so it always runs on that instance
          routing: { to: 'instance', instance: instance.instance },
          ...(extra.replace === true ? { replace: true } : {}),
        });
        ctx.log.info('database.saved', { query: saved.fn, version: saved.version, writes: compiled.writes });
        return { fn: saved.fn, signature: signatureOf(saved.fn, argsTypeOf(compiled, payload.sorters, this.#limits())), version: saved.version, created: saved.created };
      } catch (error) {
        if (extra.replace === true || !nameTaken(error)) { throw error; }
      }
    }
    return { invalid: `Every name tried for ${draft.name} is taken; choose another name.` };
  }

  /** `run_query`: run a saved query for the model: a read's result, or a write proposed for approval. */
  async run(instance: DatabaseInstance, fn: string, args: Readonly<Record<string, Json>>, ctx: QueryRunCtx): Promise<QueryRun | QueryProblem> {
    const stored = await ctx.getFn(fn);
    const payload = QueryPayload.safeParse(stored.payload);
    if (stored.kind !== QUERY_KIND || !payload.success) { return { invalid: `${fn} is not a saved database query.` }; }
    if (payload.data.instance !== instance.instance) { return { invalid: `${fn} runs on the ${payload.data.instance} database, not this one.` }; }
    const compiled = instance.compile(payload.data);
    if (!('query' in compiled)) { return this.#stale(fn, compiled); }
    const argsType = argsTypeOf(compiled, payload.data.sorters, this.#limits());
    const called = { name: stored.fn, signature: signatureOf(stored.fn, argsType) };
    // the hub checks a direct call's args against the fn's type; through run_query they are checked here the same way
    const problems = argProblems(argsType, Json.parse({ ...args }));
    if (problems.length > 0) { return { invalid: `The args don't fit ${called.signature}: ${problems.join('; ')}` }; }
    const { values, sort } = callArgs(Json.parse({ ...args }));
    const plan = instance.plan(compiled, values, sort);
    const base = { database: instance.info, fn: called, query: { sql: plan.sql, structured: Json.parse(compiled.def), params: plan.bound, writes: compiled.writes } };
    if (compiled.writes) {
      if (!instance.writes) { return { invalid: `${instance.config.label} is read-only now.` }; }
      const preview = await this.preview(instance, compiled, plan, payload.data.description);
      const local = queryInstance(stored.fn)?.local ?? stored.fn;
      const proposed = await ctx.propose(local, Json.parse(callOf(values, sort)), { preview, approver: 'person' });
      return {
        ...base,
        approval: { run: proposed.run, state: 'waiting', says: `${preview.title}: this waits for the person to approve it in the chat. Tell them what it will do and end your turn; once approved it runs and its result shows, and if they decline you are told why.` },
      };
    }
    return { ...base, result: await this.read(instance, compiled, plan, called, callOf(values, sort), ctx) };
  }

  /** Read rows for a call: attach them for the person, and give the model its result block (`args` as called, sort too, for the next page's call). */
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
    const table = resultTable(written, compiled.columns, { offset: 0, limit: undefined, sort: [], cap: this.#settings.DATABASE_MAX_ROWS });
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
    return { title: `${verb} ${dry.affected} ${dry.affected === 1 ? 'row' : 'rows'} in ${target} (${instance.config.label} database)`, parts, irreversible: compiled.def.kind === 'delete' };
  }

  #limits(): { page: number; max: number } {
    return { page: this.#settings.DATABASE_PAGE_ROWS, max: this.#settings.DATABASE_MAX_ROWS };
  }

  /** A saved query the tables no longer fit. */
  #stale(fn: string, refusal: Refusal): QueryProblem {
    return { invalid: `The saved query ${fn} no longer fits the tables: ${refusal.problems.join(' ')} Fix it with edit_query.` };
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

  /** The payload of a draft: checked against the tables when `compiled` is given (only its output columns kept as sorters). */
  #payload(instance: DatabaseInstance, draft: QueryDraft, compiled?: CompiledQuery): QueryPayload {
    const sorters = draft.sorters ?? [];
    return QueryPayload.parse({
      instance: instance.instance,
      description: draft.description,
      query: compiled === undefined ? draft.query : Json.parse(compiled.def),
      sorters: compiled === undefined ? sorters : sorters.filter((name) => compiled.columns.some((column) => column.name === name)),
      list: compiled?.list ?? true,
    });
  }
}
