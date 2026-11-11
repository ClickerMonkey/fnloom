/**
 * The database system's implementation: one instance per database. The lifecycle opens the configured database and
 * rescans it (on start and on every config change), proposing an admin approval for type changes that would break
 * saved queries or drop a type. `get_query` and `edit_query` are agents the hub runs; here are their tools: `databases`
 * (the fleet), and `tables`, `check_query`, `save_query` and `run_query`, each done by the instance that has the
 * database (`at_instance`, forwarded with `on` when that is another one). Saved queries live in the hub; the `query`
 * kind runs them, and previews the writes among them for their approval.
 */
import { InstanceName, Json, ShareRule, qualify, splitName, type ApprovalPreview, type FnEffects, type PreviewAnswer, type QualifiedName } from '@harness/core';
import { CallFailed, ResultBlockType, ginAs, wireType, type FnCtx, type Fleets, type SystemCtx, type SystemImpl, type TypesOf } from '@harness/sdk';
import { z } from 'zod';
import { QUERY_KIND, database, type DatabaseContract } from '../shared/index.ts';
import { ParamValues, QueryPayload, WriteResult, type Connection, type DatabaseConfig, type InstanceAnswer, type InstanceOp, type SchemaArgs, type SchemaChanged } from '../shared/shapes.ts';
import type { Enricher } from './author.ts';
import { argsTypeOf, effectsOf, signatureOf, type CompiledQuery } from './compile.ts';
import type { Database } from './drivers/index.ts';
import type { DatabaseSettings } from './env.ts';
import { DatabaseInstance, changeWords, widens, type HubSide, type ScanReport } from './instance.ts';
import { QueryService, callArgs, callOf, isProblem, mayUse, notYours, queryInstance, type QueryProblem, type QueryRunCtx } from './queries.ts';
import { hubTypeOf, qualifiedTypeOf, tableMetaOf } from './types.ts';

/** The run context of one of the contract's fns. */
type CtxOf<K extends keyof DatabaseContract['defs']['fns']> = FnCtx<TypesOf<DatabaseContract['defs']['fns'][K]>, DatabaseConfig>;

/** Another database instance of this system, as get_query chooses between them. */
export interface FleetMember {
  readonly instance: string;
  readonly label: string;
  /** Its tables, each with what it holds when known (`orders (one per checkout)`). */
  readonly tables: readonly string[];
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
 * the same way, by its label and its table types as the hub keeps them (with their enriched descriptions), so the
 * query agent compares like with like. A database with no tables yet is listed too (a new one to create tables in),
 * so every instance sees the same fleet. This instance comes from `self` when the hub doesn't list it yet.
 */
export const HUB_FLEET: Fleet = {
  async members(self, fleets) {
    const listed = (await fleets.fleet()).flatMap((member): FleetMember[] => {
      const label = LabelOnly.safeParse(member.config);
      if ((member.instance !== self.instance && !member.online) || !label.success) { return []; }
      const tables = member.types.map((type) => `${type.name.slice(type.name.lastIndexOf('.') + 1)}${type.description === '' ? '' : ` (${type.description})`}`);
      return [{ instance: member.instance, label: label.data.label, audience: label.data.audience, tables }];
    });
    return listed.some((member) => member.instance === self.instance) ? listed : [self, ...listed];
  },
};

/** The hub's side of this instance, as the running system gives it. */
export interface HubLink {
  /** Add or replace these table types, and take these away (local names). */
  types: HubSide['types'];
  /** Search the hub's fns as the system (`ctx.searchFns` outside a run). */
  searchFns: SystemCtx['searchFns'];
}

/** Everything the implementation is built from. */
export interface DatabaseDeps {
  readonly settings: DatabaseSettings;
  readonly instance: InstanceName;
  readonly dataDir: string;
  readonly enricher: Enricher;
  readonly fleet: Fleet;
  /** The hub's side of this instance; set once the system is serving. */
  readonly hub: () => HubLink | undefined;
  readonly now: () => number;
  /** Opens the database (tests may pass their own). */
  readonly open?: (connection: Connection, options: { dataDir: string; readonly: boolean }) => Database;
}

/** What configuring needs from the system: its model, log and proposals, and the hub's fleet and types. */
export type ConfigureCtx = Pick<SystemCtx, 'llm' | 'log' | 'propose' | 'fleet' | 'types'>;

/** A kind's check or describe before the database is open: the hub keeps the fn's last description then. */
class NotOpenYet extends Error {
  constructor() {
    super('This database is not open yet; its saved queries are described once it is.');
  }
}

/** The implementation, and the instance it serves. */
export interface DatabaseServer {
  readonly impl: SystemImpl<DatabaseContract['defs']>;
  readonly queries: QueryService;
  /** The open instance, once configured. */
  current(): DatabaseInstance | undefined;
  /** Open (or reopen) the database for a config and rescan it. */
  configure(config: DatabaseConfig, ctx: ConfigureCtx): Promise<ScanReport>;
  close(): Promise<void>;
}

/** The saved query fns that read a type, by the hub's search (every page). */
async function readersOf(link: HubLink, instance: InstanceName, type: QualifiedName): Promise<string[]> {
  const found: string[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = await link.searchFns({ kinds: [QUERY_KIND], instance, types: { reads: [type] }, available: false, order: 'alphabetical', offset, limit: 100 });
    found.push(...page.items.map((hit) => hit.name));
    offset = page.next;
  }
  return found;
}

/**
 * What a schema change will do: its DDL steps, the table before and after with the saved queries a narrowing change
 * breaks (the hub's search), or why it can't.
 */
async function schemaPlan(
  instance: DatabaseInstance, args: SchemaArgs, hub: Pick<HubSide, 'readers'>,
): Promise<{ steps: ReturnType<DatabaseInstance['catalog']['dialect']['ddl']['alterTable']>; preview: ApprovalPreview } | { refused: string }> {
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
  const type = qualifiedTypeOf(instance.instance, args.table);
  const changes = changeWords(planned.current, planned.wanted);
  // only a change that narrows the table can break a saved query that reads it
  const breaks = planned.current === undefined || widens(planned.current, planned.wanted)
    ? []
    : (await hub.readers(type)).map((fn) => ({ fn, why: `It reads ${args.table}: ${changes.join(' ')}` }));
  const where = `(${instance.config.label} database)`;
  return {
    steps,
    preview: {
      title: planned.current === undefined ? `Create table ${args.table} ${where}` : `Change table ${args.table} ${where} (${steps.length} ${steps.length === 1 ? 'step' : 'steps'})`,
      parts: [
        { type: 'text', text: steps.map((step) => `- ${step.summary}${step.irreversible ? ' **Can lose data.**' : ''}`).join('\n') },
        { type: 'code', language: 'sql', code: steps.flatMap((step) => step.sql).join(';\n'), title: 'DDL' },
        {
          type: 'type-diff', name: type,
          ...(planned.current === undefined ? {} : { before: hubTypeOf(planned.current) }),
          after: hubTypeOf(planned.wanted), changes, breaks,
        },
      ],
      irreversible,
    },
  };
}

/**
 * The problem when a model gives a query's args as something other than values by param name (gin reads an open
 * record as any JSON, so text gets this far).
 */
const NOT_VALUES = { path: 'args', message: 'args must be a JSON object of values by param name, such as { "status": "paid" }; you sent a string or a list. Send the object itself, not a string holding it.' };

/** A query's effects with its tables as the hub's type names. */
function effectsOfQuery(instance: string, compiled: CompiledQuery): FnEffects {
  const { mode, reads, writes } = effectsOf(compiled);
  return { mode, reads: reads.map((table) => qualifiedTypeOf(instance, table)), writes: writes.map((table) => qualifiedTypeOf(instance, table)), free: true };
}

/** Build the database implementation. */
export function createDatabaseImpl(deps: DatabaseDeps): DatabaseServer {
  const s = deps.settings;
  let instance: DatabaseInstance | undefined;
  // the instance once its tables are scanned (or none, when opening failed): the hub describes saved queries while a
  // scan's types are on their way to it, so check and describe wait for this, never for the whole configure
  let scanned: Promise<DatabaseInstance | undefined> = Promise.resolve(undefined);
  // the system's side of the hub (its fleet and types), as the last configure gave it
  let system: Pick<ConfigureCtx, 'fleet' | 'types'> | undefined;
  const queries = new QueryService({ instance: () => instance, settings: s });
  const limits = { page: s.DATABASE_PAGE_ROWS, max: s.DATABASE_MAX_ROWS };
  // before the system serves, nothing is sent and no saved query is known
  const hubSide: HubSide = {
    types: (upsert, remove) => deps.hub()?.types(upsert, remove) ?? Promise.resolve(),
    known: async () => {
      if (system === undefined) { return new Map(); }
      const names = (await system.fleet()).find((member) => member.instance === deps.instance)?.types.map((type) => type.name) ?? [];
      if (names.length === 0) { return new Map(); }
      const wanted = new Set<string>(names);
      // the closure comes with what the types reference; only this instance's own table types are wanted
      const found = (await system.types.definitions(names)).types.filter((type) => wanted.has(type.name));
      return new Map(found.map((type) => [splitName(type.name).local, { def: type.def, meta: tableMetaOf(type.meta) }]));
    },
    readers: async (type) => {
      const link = deps.hub();
      return link === undefined ? [] : await readersOf(link, deps.instance, type);
    },
  };

  /** Propose the changes a rescan left waiting, for an admin; the same changes keep the same key, so one approval waits. */
  async function proposePending(report: ScanReport, label: string, ctx: Pick<SystemCtx, 'propose'>): Promise<void> {
    if (report.pending === undefined) { return; }
    await ctx.propose(database.fns.apply_type_changes, { scan: report.pending.scan }, {
      approver: 'admins',
      key: report.pending.scan,
      preview: { title: `Apply ${report.parts.length} table type ${report.parts.length === 1 ? 'change' : 'changes'} in ${label}`, parts: [...report.parts], irreversible: report.pending.dropped.length > 0 },
    });
  }

  // configs are applied one at a time, so a second one never opens a database beside the first
  let configuring: Promise<unknown> = Promise.resolve();

  function configure(config: DatabaseConfig, ctx: ConfigureCtx): Promise<ScanReport> {
    const next = configuring.catch(() => undefined).then(() => reconfigure(config, ctx));
    configuring = next;
    return next;
  }

  async function reconfigure(config: DatabaseConfig, ctx: ConfigureCtx): Promise<ScanReport> {
    system = ctx;
    const scanning = (async () => {
      const before = instance;
      instance = undefined;
      await before?.close();
      const opening = new DatabaseInstance(config, {
        instance: deps.instance, dataDir: deps.dataDir, enricher: deps.enricher, hub: hubSide, limits,
        distinctMax: s.DATABASE_DISTINCT_MAX, now: deps.now, ...(deps.open === undefined ? {} : { open: deps.open }),
      });
      try {
        await opening.scan(ctx.llm);
      } catch (error) {
        await opening.close();
        throw error;
      }
      // open before the hub hears of the tables, so the saved queries it describes again see them
      instance = opening;
      return opening;
    })();
    scanned = scanning.catch(() => undefined);
    const opened = await scanning;
    const report = await opened.publish();
    ctx.log.info('database.scanned', { tables: opened.catalog.tables.length, added: report.added.length, changed: report.changed.length, waiting: report.pending === undefined ? 0 : report.parts.length });
    await proposePending(report, config.label, ctx);
    return report;
  }

  /**
   * The open instance a saved query of `payload` is for, once its tables are scanned. Throws while there is none (or
   * the payload is another instance's), so the hub keeps the fn's last description rather than one made without tables.
   */
  async function openFor(payloadInstance: string): Promise<DatabaseInstance> {
    await scanned;
    const here = instance;
    if (here === undefined) { throw new NotOpenYet(); }
    if (payloadInstance !== here.instance) { throw new Error(`This is the ${here.instance} database; the saved query is for ${payloadInstance}.`); }
    return here;
  }

  /** The run's side of a query tool: its approvals, attachments and the hub's fns as its person. */
  function runCtx(ctx: CtxOf<'at_instance'>): QueryRunCtx {
    return {
      run: ctx.run, log: ctx.log,
      propose: (fn, args, options) => ctx.propose(fn, args, options),
      attach: (table, title) => { ctx.attach(database.attachments.result, table, title); },
      getFn: async (fn) => await ctx.fns.getFn({ fn }),
      saveFn: async (save) => await ctx.fns.saveFn(save),
    };
  }

  /** Do one tool's work here. */
  async function atHere(op: InstanceOp, ctx: CtxOf<'at_instance'>): Promise<InstanceAnswer | QueryProblem> {
    const here = queries.instance(ctx.run.user);
    if (!('db' in here)) { return here; }
    // tables a scan outside a run left plain are enriched now, with this run's model
    await here.enrichLater(ctx.llm);
    switch (op.op) {
      case 'tables': return { op: 'tables', tables: queries.tables(here) };
      case 'check': return { op: 'check', check: queries.check(here, op.draft) };
      case 'save': {
        const saved = await queries.save(here, op.draft, { args: op.args, askedFor: op.askedFor, replace: op.replace }, runCtx(ctx));
        return 'fn' in saved ? { op: 'save', saved } : saved;
      }
      case 'run': {
        const ran = await queries.run(here, op.fn, op.args ?? {}, runCtx(ctx));
        return 'database' in ran ? { op: 'run', run: ran } : ran;
      }
    }
  }

  /**
   * A tool's work on the instance that has the database: here, or forwarded with `on`. The answer is the one for the
   * op asked (`pick` narrows it); a problem is the caller's to fix.
   */
  async function at<T>(
    ctx: Pick<CtxOf<'tables'>, 'fns'>, target: string, op: InstanceOp, pick: (answer: InstanceAnswer) => T | undefined,
  ): Promise<T | QueryProblem> {
    const on = InstanceName.safeParse(target.replace(/^database\//, ''));
    if (!on.success) { return { invalid: `"${target}" isn't a database instance name; call database/databases for them.` }; }
    try {
      const answer = await ctx.fns.at(op, { on: on.data });
      return pick(answer) ?? { failed: `The ${on.data} database answered another question than asked.` };
    } catch (error) {
      if (error instanceof CallFailed && error.error.class !== 'cancelled') {
        return error.error.class === 'caller' ? { invalid: error.error.message } : { failed: error.error.message };
      }
      throw error;
    }
  }

  /** A problem as the run's outcome: the caller's to fix, or a failure. */
  function refuse<O>(ctx: { invalid(problems: string): O; fail(cls: 'caller', message: string): O }, problem: QueryProblem): O {
    return 'invalid' in problem ? ctx.invalid(problem.invalid) : ctx.fail('caller', problem.failed);
  }

  async function changeSchema(args: SchemaArgs, ctx: Pick<CtxOf<'change_schema'>, 'llm' | 'propose'>): Promise<SchemaChanged | QueryProblem> {
    if (instance === undefined) { return { failed: 'This database is not configured yet.' }; }
    const planned = await schemaPlan(instance, args, hubSide);
    if ('refused' in planned) { return { invalid: planned.refused }; }
    await instance.db.write(planned.steps.flatMap((step) => step.sql.map((sql) => ({ sql, params: [] }))));
    // a change that breaks saved queries leaves the table's type waiting for an admin, as any rescan does
    await proposePending(await instance.rescan(ctx.llm), instance.config.label, ctx);
    return {
      database: instance.info,
      shown: `${planned.preview.title}: done.`,
      steps: planned.steps.map((step) => ({ sql: step.sql.join(';\n'), irreversible: step.irreversible })),
      types: instance.catalog.typeDecls(instance.config).map((decl) => qualify(database.name, decl.name)),
    };
  }

  const impl: SystemImpl<DatabaseContract['defs']> = {
    lifecycle: {
      started: async (ctx) => { await configure(ctx.config, ctx); },
      configured: async (ctx) => { await configure(ctx.config, ctx); },
      stopping: async () => { await instance?.close(); },
    },
    fns: {
      databases: {
        async run(_args, ctx) {
          const here = instance;
          if (here === undefined) { return ctx.fail('caller', 'This database is not configured yet: an admin sets its connection on the system\'s page.'); }
          const members = (await deps.fleet.members({ instance: here.instance, label: here.config.label, tables: here.catalog.tableList(), audience: here.config.audience }, ctx))
            .filter((member) => member.audience === undefined || mayUse(member.audience, ctx.run.user));
          return ctx.done(members.map((member) => ({ instance: member.instance, label: member.label, tables: [...member.tables] })));
        },
      },
      at_instance: {
        async run(args, ctx) {
          const answer = await atHere(args, ctx);
          return 'op' in answer ? ctx.done(answer) : 'failed' in answer ? ctx.fail('caller', answer.failed) : ctx.invalid(answer.invalid);
        },
      },
      tables: {
        async run(args, ctx) {
          const answer = await at(ctx, args.database, { op: 'tables' }, (found) => (found.op === 'tables' ? found.tables : undefined));
          return isProblem(answer) ? refuse(ctx, answer) : ctx.done(answer);
        },
      },
      check_query: {
        async run(args, ctx) {
          const answer = await at(ctx, args.database, { op: 'check', draft: args.draft }, (found) => (found.op === 'check' ? found.check : undefined));
          return isProblem(answer) ? refuse(ctx, answer) : ctx.done(answer);
        },
      },
      save_query: {
        async run(args, ctx) {
          if (!ParamValues.optional().safeParse(args.args).success) { return ctx.invalid([NOT_VALUES]); }
          const answer = await at(ctx, args.database, {
            op: 'save', draft: args.draft,
            ...(args.args === undefined ? {} : { args: args.args }),
            ...(args.askedFor === undefined ? {} : { askedFor: args.askedFor }),
            ...(args.replace === undefined ? {} : { replace: args.replace }),
          }, (found) => (found.op === 'save' ? found.saved : undefined));
          return isProblem(answer) ? refuse(ctx, answer) : ctx.done(answer);
        },
      },
      run_query: {
        async run(args, ctx) {
          const target = queryInstance(args.fn);
          if (!ParamValues.optional().safeParse(args.args).success) { return ctx.invalid([NOT_VALUES]); }
          if (target === undefined) { return ctx.invalid([{ path: 'fn', message: `"${args.fn}" isn't a saved query fn; they are named database/<database>.<name>.` }]); }
          const answer = await at(ctx, target.instance, { op: 'run', fn: qualify(database.name, target.local), ...(args.args === undefined ? {} : { args: args.args }) }, (found) => (found.op === 'run' ? found.run : undefined));
          return isProblem(answer) ? refuse(ctx, answer) : ctx.done(answer);
        },
      },
      create_table: { run: (args, ctx) => forwardSchema('create', args, ctx) },
      alter_table: { run: (args, ctx) => forwardSchema('alter', args, ctx) },
      change_schema: {
        async run(args, ctx) {
          if (instance !== undefined && !mayUse(instance.config.audience, ctx.run.user)) { return ctx.invalid(notYours(instance.config.label).invalid); }
          const changed = await changeSchema(args, ctx);
          return 'database' in changed ? ctx.done(changed) : 'failed' in changed ? ctx.fail('caller', changed.failed) : ctx.invalid(changed.invalid);
        },
        async preview(args, ctx): Promise<PreviewAnswer> {
          if (instance === undefined) { return { refused: 'This database is not configured yet.' }; }
          if (!mayUse(instance.config.audience, ctx.user)) { return { refused: notYours(instance.config.label).invalid }; }
          const planned = await schemaPlan(instance, args, hubSide);
          return 'refused' in planned ? { refused: planned.refused } : { preview: planned.preview };
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
        // SQL against the database, no model: free, whatever the payload
        estimate: (_payload, input) => Promise.resolve({ min: 0, typical: 0, max: 0, basis: 'free', runs: input.history?.runs ?? 0 }),
        async check(payload) {
          const here = await openFor(payload.instance);
          const compiled = here.compile(QueryPayload.parse(payload));
          const problems = 'query' in compiled ? [] : compiled.problems;
          if ('query' in compiled && compiled.writes && !here.writes) { problems.push(`${here.config.label} is read-only: a query that writes can't be saved.`); }
          return problems;
        },
        async describe(payload) {
          const here = await openFor(payload.instance);
          const parsed = QueryPayload.parse(payload);
          const compiled = here.compile(parsed);
          // check refused a payload that doesn't fit the tables; one that stopped fitting since keeps its last description
          if (!('query' in compiled)) { throw new Error(`The saved query no longer fits the tables: ${compiled.problems.join(' ')}`); }
          return {
            args: argsTypeOf(compiled, parsed.sorters, limits),
            returns: wireType(compiled.writes ? ginAs(WriteResult) : ResultBlockType),
            deps: [],
            types: compiled.tables.map((table) => qualifiedTypeOf(parsed.instance, table)),
            // what it reads and writes, for its facts (and so for the hub's search by type, and the tables a schema change breaks)
            effects: effectsOfQuery(parsed.instance, compiled),
            // its SQL in this database's dialect, params as placeholders, for the fn's page
            readable: { language: 'sql', code: here.plan(compiled, {}, []).sql },
            operations: { cancel: true, pause: false, undo: false, background: false },
            ...(compiled.writes ? { approval: { preview: true, remember: false } } : {}),
          };
        },
        async run(payload, args, ctx) {
          const parsed = QueryPayload.parse(payload);
          if (instance === undefined) { return ctx.fail('caller', 'This database is not configured yet.'); }
          // who may use the database is its config's say now, whoever the fn was shared with when it was saved
          if (!mayUse(instance.config.audience, ctx.run.user)) { return ctx.invalid(notYours(instance.config.label).invalid); }
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
          return ctx.done(Json.parse(await queries.read(instance, compiled, plan, fn, callOf(values, sort), { attach })));
        },
        async preview(payload, args, ctx): Promise<PreviewAnswer> {
          if (instance === undefined) { return { refused: 'This database is not configured yet.' }; }
          if (!mayUse(instance.config.audience, ctx.user)) { return { refused: notYours(instance.config.label).invalid }; }
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
    const here = instance;
    if (here === undefined) { return ctx.fail('caller', 'This database is not configured yet.'); }
    let target = args.database;
    if (target === undefined) {
      // with no database named, only the one database the person may use is meant, never whichever instance answered
      const members = (await deps.fleet.members({ instance: here.instance, label: here.config.label, tables: here.catalog.tableList(), audience: here.config.audience }, ctx))
        .filter((member) => member.audience === undefined || mayUse(member.audience, ctx.run.user));
      const [only, ...others] = members;
      if (only === undefined || others.length > 0) {
        const named = members.map((member) => `${member.instance} (${member.label})`).join(', ');
        return ctx.invalid([{ path: 'database', message: `Say which database: ${named === '' ? 'there is none you may use' : named}.` }]);
      }
      target = only.instance;
    }
    const on = InstanceName.safeParse(target.replace(/^database\//, ''));
    if (!on.success) { return ctx.invalid([{ path: 'database', message: `"${target}" isn't a database instance name; call database/databases for them.` }]); }
    try {
      return ctx.done(await ctx.fns.change_schema({ table: args.table, type: args.type, action, database: on.data }, { on: on.data }));
    } catch (error) {
      if (error instanceof CallFailed) {
        return error.error.class === 'cancelled' ? ctx.fail('caller', `Not done: ${error.message}`) : ctx.fail('caller', error.error.message);
      }
      throw error;
    }
  }

  return { impl, queries, current: () => instance, configure, close: async () => { await instance?.close(); } };
}
