/**
 * The database system's implementation: one instance per database. The lifecycle opens the configured database and
 * rescans it (on start and on every config change), proposing an admin approval for type changes that would break
 * saved queries or drop a type. `get_query` / `edit_query` / `create_table` / `alter_table` pick the database and
 * forward to it (`query_on`, `edit_on`, `change_schema`) when it is another instance; the `query` kind runs saved
 * queries, and previews the writes among them for their approval.
 */
import { InstanceName, Json, qualify, ShareRule, type ApprovalPreview, type PreviewAnswer } from '@harness/core';
import { CallFailed, ResultBlockType, g, ginAs, wireType, type FnCtx, type Fleets, type SystemCtx, type SystemImpl, type TypesOf, type UntypedFn } from '@harness/sdk';
import { z } from 'zod';
import { database, type DatabaseContract } from '../shared/index.ts';
import { QueryPayload, WriteResult, type Connection, type DatabaseConfig, type SchemaArgs, type SchemaChanged } from '../shared/shapes.ts';
import type { Enricher, QueryAuthor } from './author.ts';
import { argsTypeOf, signatureOf } from './compile.ts';
import type { Database } from './drivers/index.ts';
import type { DatabaseSettings } from './env.ts';
import { DatabaseInstance, changeWords, type HubSide, type ScanReport } from './instance.ts';
import { QueryService, callArgs, mayUse, notYours, savedQueryName, type QueryProblem, type QueryRunCtx, type RuntimeFns } from './queries.ts';
import type { InstanceStore } from './store.ts';
import { hubTypeOf, qualifiedTypeOf } from './types.ts';
import { cosine, embedOne } from '@harness/sdk/server';

/** The run context of one of the contract's fns. */
type CtxOf<K extends keyof DatabaseContract['defs']['fns']> = FnCtx<TypesOf<DatabaseContract['defs']['fns'][K]>, DatabaseConfig>;

/** What a query needs from any run's context (the same members on every fn's and kind's). */
type RunSide = Pick<FnCtx<UntypedFn>, 'llm' | 'run' | 'log' | 'usableFns' | 'shareFn' | 'decide' | 'propose' | 'attach'>;

/** Another database instance of this system, as get_query chooses between them. */
export interface FleetMember {
  readonly instance: string;
  readonly label: string;
  /** Its tables and what they hold, in a line. */
  readonly summary: string;
  /** Who may use it; absent when the fleet doesn't say (then its own instance decides). */
  readonly audience?: ShareRule;
}

/** The database instances of this system. */
export interface Fleet {
  members(self: FleetMember, fleets: Fleets): Promise<FleetMember[]>;
}

/** A fleet that knows only this instance (tests of one database). */
export const SELF_FLEET: Fleet = { members: (self) => Promise.resolve([self]) };

/** The part of another instance's config the choice needs. */
const LabelOnly = z.object({ label: z.string().min(1), audience: ShareRule });

/**
 * The fleet as the hub lists it (`ctx.fleet()`): every online, configured instance, this one included, each described
 * the same way, by its label and its table types as the hub keeps them (enriched descriptions and columns), so the
 * embedding match compares like with like. This instance comes from `self` when the hub doesn't list it yet.
 */
export const HUB_FLEET: Fleet = {
  async members(self, fleets) {
    const listed = (await fleets.fleet()).flatMap((member): FleetMember[] => {
      const label = LabelOnly.safeParse(member.config);
      if ((member.instance !== self.instance && !member.online) || !label.success || member.types.length === 0) { return []; }
      const tables = member.types.map((type) => `${type.name.slice(type.name.lastIndexOf('.') + 1)}${type.description === '' ? '' : ` (${type.description})`}`);
      return [{ instance: member.instance, label: label.data.label, audience: label.data.audience, summary: `${label.data.label}: ${tables.join('; ')}` }];
    });
    return listed.some((member) => member.instance === self.instance) ? listed : [self, ...listed];
  },
};

/** Everything the implementation is built from. */
export interface DatabaseDeps {
  readonly settings: DatabaseSettings;
  readonly instance: InstanceName;
  readonly dataDir: string;
  readonly store: InstanceStore;
  readonly author: QueryAuthor;
  readonly enricher: Enricher;
  readonly fleet: Fleet;
  /** The hub's side of this instance's types; set once the system is serving. */
  readonly hub: () => HubSide | undefined;
  /** Where saved queries are added as fns; set once the system is serving. */
  readonly runtime: () => RuntimeFns | undefined;
  readonly now: () => number;
  /** Opens the database (tests may pass their own). */
  readonly open?: (connection: Connection, options: { dataDir: string; readonly: boolean }) => Database;
}

/** The implementation, and the instance it serves. */
export interface DatabaseServer {
  readonly impl: SystemImpl<DatabaseContract['defs']>;
  readonly queries: QueryService;
  /** The open instance, once configured. */
  current(): DatabaseInstance | undefined;
  /** Open (or reopen) the database for a config and rescan it. */
  configure(config: DatabaseConfig, ctx: Pick<SystemCtx, 'llm' | 'log' | 'propose'>): Promise<ScanReport>;
  close(): Promise<void>;
}

/** The hub's side when the system isn't serving yet: nothing is sent. */
const NO_HUB: HubSide = { types: () => Promise.resolve() };

/** What a schema change will do: its DDL steps, the table before and after, or why it can't. */
function schemaPlan(instance: DatabaseInstance, args: SchemaArgs): { steps: ReturnType<DatabaseInstance['catalog']['dialect']['ddl']['alterTable']>; preview: ApprovalPreview } | { refused: string } {
  if (!instance.schemaChanges) { return { refused: `The database ${instance.config.label} doesn't allow schema changes (its admin can allow them on the system's page).` }; }
  let planned: ReturnType<DatabaseInstance['tableFor']>;
  try {
    planned = instance.tableFor(args.table, args.type);
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
  const ddl = instance.catalog.dialect.ddl;
  if (args.action === 'create' && planned.current !== undefined) { return { refused: `${args.table} exists already: use alter_table to change it.` }; }
  if (args.action === 'alter' && planned.current === undefined) { return { refused: `There is no table ${args.table}: use create_table to make it.` }; }
  let steps: ReturnType<typeof ddl.alterTable>;
  try {
    steps = planned.current === undefined ? [ddl.createTable(planned.wanted)] : ddl.alterTable(planned.current, planned.wanted);
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
  if (steps.length === 0) { return { refused: `${args.table} already matches that type.` }; }
  const irreversible = steps.some((step) => step.irreversible);
  return {
    steps,
    preview: {
      title: planned.current === undefined ? `Create table ${args.table}` : `Change table ${args.table} (${steps.length} ${steps.length === 1 ? 'step' : 'steps'})`,
      parts: [
        { type: 'text', text: steps.map((step) => `- ${step.summary}${step.irreversible ? ' **Can lose data.**' : ''}`).join('\n') },
        { type: 'code', language: 'sql', code: steps.flatMap((step) => step.sql).join(';\n'), title: 'DDL' },
        {
          type: 'type-diff', name: qualifiedTypeOf(instance.instance, args.table),
          ...(planned.current === undefined ? {} : { before: hubTypeOf(planned.current) }),
          after: hubTypeOf(planned.wanted), changes: changeWords(planned.current, planned.wanted), breaks: [],
        },
      ],
      irreversible,
    },
  };
}

/** Build the database implementation. */
export function createDatabaseImpl(deps: DatabaseDeps): DatabaseServer {
  const s = deps.settings;
  let instance: DatabaseInstance | undefined;
  const queries = new QueryService({ instance: () => instance, store: deps.store, author: deps.author, settings: s, runtime: deps.runtime, now: deps.now });
  const limits = { page: s.DATABASE_PAGE_ROWS, max: s.DATABASE_MAX_ROWS };
  const hub: HubSide = { types: (upsert, remove) => (deps.hub() ?? NO_HUB).types(upsert, remove) };

  async function configure(config: DatabaseConfig, ctx: Pick<SystemCtx, 'llm' | 'log' | 'propose'>): Promise<ScanReport> {
    const before = instance;
    instance = undefined;
    await before?.close();
    const opened = new DatabaseInstance(config, {
      instance: deps.instance, dataDir: deps.dataDir, store: deps.store, enricher: deps.enricher, hub, limits,
      distinctMax: s.DATABASE_DISTINCT_MAX, now: deps.now, ...(deps.open === undefined ? {} : { open: deps.open }),
    });
    const report = await opened.rescan(ctx.llm);
    instance = opened;
    ctx.log.info('database.scanned', { tables: opened.catalog.tables.length, added: report.added.length, changed: report.changed.length, waiting: report.pending === undefined ? 0 : report.parts.length });
    if (report.pending !== undefined) {
      await ctx.propose(database.fns.apply_type_changes, { scan: report.pending.scan }, {
        approver: 'admins',
        key: report.pending.scan,
        preview: { title: `Apply ${report.parts.length} table type ${report.parts.length === 1 ? 'change' : 'changes'} in ${config.label}`, parts: [...report.parts], irreversible: report.pending.dropped.length > 0 },
      });
    }
    await queries.restore(opened);
    return report;
  }

  /** Which instance a request is for: the one named, the only one, the best match, or a question back. */
  async function pick(named: string | undefined, request: string, ctx: QueryRunCtx, here: DatabaseInstance, fleets: Fleets): Promise<string | QueryProblem> {
    if (named !== undefined) { return named.replace(/^database\//, ''); }
    const members = (await deps.fleet.members({ instance: here.instance, label: here.config.label, summary: here.catalog.summary(here.config.label), audience: here.config.audience }, fleets))
      .filter((member) => member.audience === undefined || mayUse(member.audience, ctx.run.user));
    if (members.length <= 1) { return members[0]?.instance ?? here.instance; }
    const vector = await embedOne(ctx.llm, request);
    const scored = await Promise.all(members.map(async (member) => ({ member, score: Math.max(0, cosine(vector, await embedOne(ctx.llm, member.summary))) })));
    scored.sort((a, b) => b.score - a.score);
    ctx.log.info('database.picking', { request, scores: scored.map((item) => `${item.member.instance} ${item.score.toFixed(3)}`) });
    const [best, next] = scored;
    if (best !== undefined && (next === undefined || best.score - next.score > 0.05)) { return best.member.instance; }
    const answer = await ctx.decide(`Which database answers this request: ${request}`, scored.map((item) => ({ id: item.member.instance, text: item.member.summary, score: item.score })), { max: 1 });
    const picked = answer.by === 'decision' ? answer.picked[0]?.id : undefined;
    return picked ?? { invalid: `Several databases could answer this; ask the person which (with ask_choice), then call again with database set to one of: ${members.map((member) => `${member.instance} (${member.label})`).join(', ')}.` };
  }

  /** The run's side of a query, from a native fn's or a kind's context. */
  function runCtx(ctx: RunSide): QueryRunCtx {
    return {
      llm: ctx.llm, run: ctx.run, log: ctx.log,
      usableFns: (fns) => ctx.usableFns(fns),
      shareFn: (fn, rule) => ctx.shareFn(fn, rule),
      decide: (question, candidates, options) => ctx.decide(question, candidates, options),
      propose: (fn, args, options) => ctx.propose(fn, args, options),
      attach: (table, title) => { ctx.attach(database.attachments.result, table, title); },
    };
  }

  async function changeSchema(args: SchemaArgs, llm: Parameters<DatabaseInstance['rescan']>[0]): Promise<SchemaChanged | QueryProblem> {
    if (instance === undefined) { return { failed: 'This database is not configured yet.' }; }
    const planned = schemaPlan(instance, args);
    if ('refused' in planned) { return { invalid: planned.refused }; }
    await instance.db.write(planned.steps.flatMap((step) => step.sql.map((sql) => ({ sql, params: [] }))));
    await instance.rescan(llm);
    return {
      database: instance.info,
      shown: `${planned.preview.title}: done.`,
      steps: planned.steps.map((step) => ({ sql: step.sql.join(';\n'), irreversible: step.irreversible })),
      types: instance.catalog.typeDecls(instance.config.label).map((decl) => qualify(database.name, decl.name)),
    };
  }

  const impl: SystemImpl<DatabaseContract['defs']> = {
    lifecycle: {
      started: async (ctx) => { await configure(ctx.config, ctx); },
      configured: async (ctx) => { await configure(ctx.config, ctx); },
      stopping: async () => { await instance?.close(); },
    },
    fns: {
      get_query: {
        async run(args, ctx) {
          const here = queries.instance();
          if (!('db' in here)) { return 'failed' in here ? ctx.fail('caller', here.failed) : ctx.invalid(here.invalid); }
          const target = await pick(args.database, args.detailedDescription, runCtx(ctx), here, ctx);
          if (typeof target !== 'string') { return 'failed' in target ? ctx.fail('caller', target.failed) : ctx.invalid(target.invalid); }
          if (target !== here.instance) { return ctx.done(await ctx.fns.query_on({ detailedDescription: args.detailedDescription, database: target }, { on: InstanceName.parse(target) })); }
          const answer = await queries.get(args.detailedDescription, runCtx(ctx));
          return 'database' in answer ? ctx.done(answer) : 'failed' in answer ? ctx.fail('caller', answer.failed) : ctx.invalid(answer.invalid);
        },
      },
      query_on: {
        async run(args, ctx) {
          const answer = await queries.get(args.detailedDescription, runCtx(ctx));
          return 'database' in answer ? ctx.done(answer) : 'failed' in answer ? ctx.fail('caller', answer.failed) : ctx.invalid(answer.invalid);
        },
      },
      edit_query: {
        async run(args, ctx) {
          const here = queries.instance();
          if (!('db' in here)) { return 'failed' in here ? ctx.fail('caller', here.failed) : ctx.invalid(here.invalid); }
          const target = savedQueryName(args.name, here.instance).instance;
          if (target !== here.instance) { return ctx.done(await ctx.fns.edit_on(args, { on: InstanceName.parse(target) })); }
          const answer = await queries.edit(args.name, args.instructions, runCtx(ctx));
          return 'database' in answer ? ctx.done(answer) : 'failed' in answer ? ctx.fail('caller', answer.failed) : ctx.invalid(answer.invalid);
        },
      },
      edit_on: {
        async run(args, ctx) {
          const answer = await queries.edit(args.name, args.instructions, runCtx(ctx));
          return 'database' in answer ? ctx.done(answer) : 'failed' in answer ? ctx.fail('caller', answer.failed) : ctx.invalid(answer.invalid);
        },
      },
      create_table: { run: (args, ctx) => forwardSchema('create', args, ctx) },
      alter_table: { run: (args, ctx) => forwardSchema('alter', args, ctx) },
      change_schema: {
        async run(args, ctx) {
          if (instance !== undefined && !mayUse(instance.config.audience, ctx.run.user)) { return ctx.invalid(notYours(instance.config.label).invalid); }
          const changed = await changeSchema(args, ctx.llm);
          return 'database' in changed ? ctx.done(changed) : 'failed' in changed ? ctx.fail('caller', changed.failed) : ctx.invalid(changed.invalid);
        },
        preview(args, ctx): Promise<PreviewAnswer> {
          if (instance === undefined) { return Promise.resolve({ refused: 'This database is not configured yet.' }); }
          if (!mayUse(instance.config.audience, ctx.user)) { return Promise.resolve({ refused: notYours(instance.config.label).invalid }); }
          const planned = schemaPlan(instance, args);
          return Promise.resolve('refused' in planned ? { refused: planned.refused } : { preview: planned.preview });
        },
      },
      apply_type_changes: {
        async run(args, ctx) {
          if (instance === undefined) { return ctx.fail('caller', 'This database is not configured yet.'); }
          const applied = await instance.applyPending(args.scan);
          if ('problem' in applied) { return ctx.invalid(applied.problem); }
          return ctx.done({
            database: instance.info,
            shown: `The table types now match ${instance.config.label}: ${applied.applied.length} changed, ${applied.removed.length} removed.`,
            steps: [],
            types: [...applied.applied, ...applied.removed].map((name) => qualify(database.name, name)),
          });
        },
      },
    },
    kinds: {
      query: {
        check(payload) {
          if (instance === undefined || payload.instance !== instance.instance) { return Promise.resolve([]); }
          const compiled = instance.compile(QueryPayload.parse(payload));
          const problems = 'query' in compiled ? [] : compiled.problems;
          if ('query' in compiled && compiled.writes && !instance.writes) { problems.push(`${instance.config.label} is read-only: a query that writes can't be saved.`); }
          return Promise.resolve(problems);
        },
        describe(payload) {
          const parsed = QueryPayload.parse(payload);
          const compiled = instance?.compile(parsed);
          if (compiled === undefined || !('query' in compiled)) {
            // a payload that doesn't fit the tables (yet) takes no args; running it says why
            return Promise.resolve({ args: wireType(g.obj({})), returns: wireType(ResultBlockType), deps: [], operations: { cancel: true, pause: false, undo: false, background: false } });
          }
          return Promise.resolve({
            args: argsTypeOf(compiled, parsed.sorters, limits),
            returns: wireType(compiled.writes ? ginAs(WriteResult) : ResultBlockType),
            deps: [],
            types: compiled.tables.map((table) => qualifiedTypeOf(parsed.instance, table)),
            operations: { cancel: true, pause: false, undo: false, background: false },
            ...(compiled.writes ? { approval: { preview: true, remember: false } } : {}),
          });
        },
        async run(payload, args, ctx) {
          const parsed = QueryPayload.parse(payload);
          if (instance === undefined) { return ctx.fail('caller', 'This database is not configured yet.'); }
          const compiled = instance.compile(parsed);
          if (!('query' in compiled)) { return ctx.invalid(`This saved query no longer fits the tables: ${compiled.problems.join(' ')} Fix it with edit_query.`); }
          const { values, sort } = callArgs(args);
          const plan = instance.plan(compiled, values, sort);
          const fn = { name: ctx.run.fn, signature: signatureOf(ctx.run.fn, argsTypeOf(compiled, parsed.sorters, limits)) };
          const attach = (table: Parameters<QueryRunCtx['attach']>[0], title: string): void => { ctx.attach(database.attachments.result, table, title); };
          if (compiled.writes) {
            if (!instance.writes) { return ctx.fail('caller', `${instance.config.label} is read-only now.`); }
            return ctx.done(Json.parse(await queries.write(instance, compiled, plan, fn, { attach })));
          }
          return ctx.done(Json.parse(await queries.read(instance, compiled, plan, fn, values, { attach })));
        },
        async preview(payload, args): Promise<PreviewAnswer> {
          if (instance === undefined) { return { refused: 'This database is not configured yet.' }; }
          const parsed = QueryPayload.parse(payload);
          const compiled = instance.compile(parsed);
          if (!('query' in compiled)) { return { refused: `This saved query no longer fits the tables: ${compiled.problems.join(' ')}` }; }
          if (!instance.writes) { return { refused: `${instance.config.label} is read-only.` }; }
          const { values, sort } = callArgs(args);
          return { preview: await queries.preview(instance, compiled, instance.plan(compiled, values, sort), parsed.description) };
        },
      },
    },
  };

  /** `create_table` / `alter_table`: hand the change to its instance's `change_schema`, which waits for approval. */
  async function forwardSchema(action: 'create' | 'alter', args: { table: string; type: SchemaArgs['type']; database?: string | undefined }, ctx: CtxOf<'create_table'>) {
    const target = args.database ?? instance?.instance;
    if (target === undefined) { return ctx.fail('caller', 'This database is not configured yet.'); }
    try {
      return ctx.done(await ctx.fns.change_schema({ table: args.table, type: args.type, action, database: target }, { on: InstanceName.parse(target) }));
    } catch (error) {
      if (error instanceof CallFailed) {
        return error.error.class === 'cancelled' ? ctx.fail('caller', `Not done: ${error.message}`) : ctx.fail('caller', error.error.message);
      }
      throw error;
    }
  }

  return { impl, queries, current: () => instance, configure, close: async () => { await instance?.close(); } };
}
