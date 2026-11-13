/**
 * The hub's table operations (`index.ts`): reading a table from a read fn, the visual registry, row actions and the
 * streamed export. The pure parts (action options, whether a return is a table) are the sdk's, so a menu or a route
 * means the same thing here, in the widgets system and in the web app.
 */
import { reject } from '@ayepi/core';
import {
  HUB_VISUALS, Json, qualify, ResultTable, splitName, SystemName, csvHeader, csvRows,
  type ActorId, type ContributionView, type ExportQuery, type FnRecord, type Priority, type QualifiedName, type ReadTableArgs, type RowActionsQuery, type TurnId,
  type UserView, type WidgetActionOption,
} from '@harness/core';
import { returnsTable, widgetActionOptions, type RowFn } from '@harness/sdk';
import type { AccessScope } from '../access/index.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { Catalog } from '../catalog/index.ts';
import { fnError, RunRefused } from '../execution/errors.ts';
import type { RunInput, RunService } from '../execution/index.ts';
import type { FnFactsService } from '../fns/index.ts';
import type { TablesEnv } from './env.ts';
import type { TableAsker, TableService } from './index.ts';

/** A turn a person's own call from the web runs in (an export): open while it runs, then finished with how it went. */
export interface PersonTurn {
  readonly id: TurnId;
  readonly priority: Priority;
  finish(ok: boolean): Promise<void>;
}

/** What the table service uses, each looked up when it is needed. */
export interface TableDeps {
  readonly catalog: () => Pick<Catalog, 'fn' | 'manifest'>;
  readonly runs: () => Pick<RunService, 'start'>;
  readonly facts: () => Pick<FnFactsService, 'modes'>;
  readonly access: (actor: ActorId) => Promise<AccessScope>;
  /** The registry entries of the systems the person may see (`contributionsTo`), by system then name. */
  readonly contributions: (registry: QualifiedName, actor: ActorId) => Promise<ContributionView[]>;
  /** Open a turn for a person's export. */
  readonly turn: (user: UserView) => Promise<PersonTurn>;
  readonly settings: TablesEnv;
}

/** Why a fn can't be read as a table, as the refusal's code. */
const NOT_A_READ = 'not-a-read';
const NOT_A_TABLE = 'not-a-table';
const SOURCE_FAILED = 'source-failed';

/** The hub's table operations. */
export class HubTables implements TableService {
  readonly #deps: TableDeps;

  constructor(deps: TableDeps) {
    this.#deps = deps;
  }

  async read(input: ReadTableArgs, run: TableAsker): Promise<ResultTable> {
    const source = await this.#readable(input.fn);
    // the same read asked again in a run is the same child run
    return this.#call(source.name, input.args, {
      turn: run.turn, ...(run.session === undefined ? {} : { session: run.session }), parent: run.id, key: `table:${source.name}:${JSON.stringify(input.args)}`,
      actor: run.user.id, caller: run.caller, priority: 'interactive',
    });
  }

  async readAs(input: ReadTableArgs, user: UserView): Promise<Json> {
    const access = await this.#deps.access(user.id);
    const found = await this.#deps.catalog().fn(input.fn);
    if (found === undefined || !access.seesFn(found)) { throw reject(404, 'NO_FN', `there is no fn ${input.fn}`); }
    const source = await this.#readable(found.name).catch((error: unknown) => { throw refusedAs400(error, 'NOT_A_READ'); });
    const turn = await this.#deps.turn(user);
    let ok = false;
    try {
      const started = await this.#deps.runs().start({
        fn: source.name, args: input.args, turn: turn.id, key: 'read', actor: user.id, caller: user.id, priority: turn.priority, background: false, handlers: [],
      });
      const settled = await started.settled;
      if (settled.status !== 'done') {
        const why = settled.status === 'background' ? 'it went to the background' : settled.error?.message ?? settled.status;
        throw reject(400, 'READ_FAILED', `${source.name} did not finish: ${why}`);
      }
      ok = true;
      return settled.result ?? null;
    } finally {
      await turn.finish(ok);
    }
  }

  async visuals(actor: ActorId): Promise<ContributionView[]> {
    const own = (await this.#deps.catalog().manifest(HUB_SYSTEM))?.contributes ?? [];
    const others = await this.#deps.contributions(HUB_VISUALS, actor);
    return [
      ...own.filter((entry) => entry.registry === HUB_VISUALS).map((entry): ContributionView => ({ ...entry, system: HUB_SYSTEM })),
      ...others.filter((entry) => entry.system !== HUB_SYSTEM),
    ];
  }

  async rowActions(query: RowActionsQuery, actor: ActorId): Promise<WidgetActionOption[]> {
    const access = await this.#deps.access(actor);
    const catalog = this.#deps.catalog();
    const usable = new Map<QualifiedName, FnRecord>();
    const take = async (name: QualifiedName): Promise<void> => {
      const fn = usable.has(name) ? undefined : await catalog.fn(name);
      if (fn !== undefined && access.mayUse(fn)) { usable.set(name, fn); }
    };
    for (const type of query.types) {
      const { system, local } = splitName(type);
      const decl = (await catalog.manifest(SystemName.parse(system)))?.types.find((t) => t.name === local);
      for (const method of decl?.methods ?? []) { await take(qualify(system, `${local}.${method}`)); }
    }
    for (const action of query.narrow ?? []) { await take(action.fn); }
    const fns = [...usable.values()];
    const modes = await this.#deps.facts().modes(fns.map((fn) => fn.name));
    const rowFns: RowFn[] = fns.map((fn) => ({ fn: fn.name, mode: modes.get(fn.name) ?? 'write', args: fn.decl.args, returnsTable: returnsTable(fn.decl.returns) }));
    return widgetActionOptions(rowFns, query.narrow);
  }

  async export(query: ExportQuery, user: UserView): Promise<{ name: string; lines: AsyncIterable<string> }> {
    const args = exportArgs(query.args);
    const access = await this.#deps.access(user.id);
    const found = await this.#deps.catalog().fn(query.fn);
    if (found === undefined || !access.seesFn(found)) { throw reject(404, 'NO_FN', `there is no fn ${query.fn}`); }
    const source = await this.#readable(found.name).catch((error: unknown) => { throw refusedAs400(error); });
    const turn = await this.#deps.turn(user);
    const { HARNESS_EXPORT_PAGE: page, HARNESS_EXPORT_MAX_ROWS: max } = this.#deps.settings;
    const pageOf = (offset: number): Promise<ResultTable> => this.#call(source.name, { ...args, [query.offset]: offset, [query.limit]: Math.min(page, max - offset) }, {
      turn: turn.id, key: `export:${String(offset)}`, actor: user.id, caller: user.id, priority: turn.priority,
    });
    // the first page is read before the first byte, so a source that fails or gives no table is refused, not cut short
    const first = await pageOf(0).catch(async (error: unknown) => { await turn.finish(false); throw refusedAs400(error); });
    return { name: `${splitName(source.name).local}.csv`, lines: exportLines(first, pageOf, max, turn) };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** A fn that reads (its mode worked out deeply, `FnFacts`); refused before anything runs otherwise. */
  async #readable(name: QualifiedName): Promise<FnRecord> {
    const source = await this.#deps.catalog().fn(name);
    if (source === undefined) { throw new RunRefused(fnError('caller', `there is no fn ${name}`, 'no-fn')); }
    const mode = (await this.#deps.facts().modes([source.name])).get(source.name) ?? 'write';
    if (mode !== 'read') {
      throw new RunRefused(fnError('caller', `${source.name} ${mode === 'delete' ? 'deletes' : 'writes'}, so it can't be read as a table: pick a fn that reads and returns a table`, NOT_A_READ));
    }
    return source;
  }

  /** Run a fn and read its result as a table; refused when it fails or isn't one. */
  async #call(fn: QualifiedName, args: Json, input: Omit<RunInput, 'fn' | 'args' | 'background' | 'handlers'>): Promise<ResultTable> {
    const started = await this.#deps.runs().start({ ...input, fn, args, background: false, handlers: [] });
    const settled = await started.settled;
    if (settled.status !== 'done') {
      const why = settled.status === 'background' ? 'went to the background' : settled.error?.message ?? settled.status;
      throw new RunRefused(fnError('caller', `${fn} did not give a table: ${why}`, SOURCE_FAILED));
    }
    const table = ResultTable.safeParse(settled.result);
    if (!table.success) { throw new RunRefused(fnError('caller', `${fn} does not return a table`, NOT_A_TABLE)); }
    return table.data;
  }
}

/** An export's args (JSON text of an object of the fn's args); refused otherwise. */
function exportArgs(text: string): Record<string, Json> {
  let value: Json;
  try { value = Json.parse(JSON.parse(text)); } catch { throw reject(400, 'BAD_ARGS', 'args must be JSON text of an object of the fn\'s args'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { throw reject(400, 'BAD_ARGS', 'args must be JSON text of an object of the fn\'s args'); }
  return value;
}

/** A refusal of the source as a 400 with this code (the export's by default), with its words; anything else as it is. */
function refusedAs400(error: unknown, code = 'NOT_EXPORTABLE'): unknown {
  return error instanceof RunRefused ? reject(400, code, error.error.message) : error;
}

/**
 * The export's CSV lines: the header and the first page, then a page at a time until a short page, the ceiling, or a
 * failed page (which ends the file with a line saying so, since the headers are already sent). The turn is finished
 * with how it went, also when the download is cancelled.
 */
async function* exportLines(first: ResultTable, pageOf: (offset: number) => Promise<ResultTable>, max: number, turn: PersonTurn): AsyncGenerator<string, void, undefined> {
  let ok = true;
  try {
    const columns = first.columns;
    yield csvHeader(columns);
    let table = first;
    let written = 0;
    for (;;) {
      const rows = table.rows.slice(0, max - written);
      if (rows.length > 0) { yield csvRows(columns, rows); }
      written += rows.length;
      const more = table.truncated && table.rows.length > 0;
      if (!more) { return; }
      if (written >= max) { yield `# Cut at ${String(max)} rows: more rows were left out.\r\n`; return; }
      try {
        table = await pageOf(written);
      } catch (error) {
        ok = false;
        yield `# The export stopped after ${String(written)} rows: ${error instanceof RunRefused ? error.error.message : 'a page could not be read'}.\r\n`;
        return;
      }
    }
  } finally {
    await turn.finish(ok);
  }
}
