/**
 * Widgets on the hub (build 8, `core/widgets.ts`): the `hub/widget` kind's description and runs, the tools
 * `hub/make_widget` works with, and the actions a row offers. The pure parts (args, checks, fits, action options) are
 * the SDK's (`@harness/sdk` widgets), so a fit or a check means the same thing here, in systems and in the web app.
 *
 * - **Describe:** a widget's args are its source's minus the pinned and paging ones; it returns a `WidgetResult`,
 *   depends on its source, and does to data what its source does.
 * - **Run:** the source runs as a child run (cost, approval and provenance as for any call) with the pinned values and
 *   the first page; the spec's bindings are checked against the real columns, and a binding that no longer fits is a
 *   problem listed with the result, never a failure.
 * - **Actions:** every method of a row's type (`ResultColumn.ref`), labelled from its name, narrowed and relabelled by
 *   the widget; anything that is not a read confirms first.
 */
import {
  HUB_VISUALS, Json, jsonOf, KindDescription, qualify, SystemName, ResultTable, splitName, WIDGET_KIND, WidgetSpec,
  type ActorId, type ContributionDecl, type FnDecl, type FnRecord, type QualifiedName, type RunId, type RunInfo, type WidgetActionOption,
  type WidgetActionsQuery, type WidgetCheck, type WidgetVisual,
  WidgetResult,
} from '@harness/core';
import { checkWidget, fittingVisuals, ginAs, SAVE_FN_TAKEN, widgetActionOptions, widgetArgs, wireType, type RowFn } from '@harness/sdk';
import { allRows } from '../store/rows.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import type { Catalog } from '../catalog/index.ts';
import type { RunService } from '../execution/index.ts';
import { InvalidArgs } from '../execution/executors.ts';
import { fnError, RunRefused } from '../execution/errors.ts';
import type { FnFactsService } from '../fns/index.ts';
import type { HubStore } from '../store/index.ts';
import type { AccessScope, AccessService } from '../access/index.ts';

/** The table visual every result fits; a widget always offers it last. */
const TABLE_VISUAL: WidgetVisual = { visual: 'table', bind: {} };

/**
 * The sample args an authoring tool was given, as an object of the source's args. A model in strict tool mode sends a
 * free-form `args` as JSON text, so text holding an object is read as that object; anything else is refused with how
 * to give them, never run as no args.
 */
function sampleArgs(args: Json | undefined): { [key: string]: Json } {
  const value = typeof args === 'string' ? parsedJson(args) : args;
  if (value === undefined || value === null) { return {}; }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidArgs('args must be an object of the source fn args by name, such as {"type": "notes/Note"}');
  }
  return value;
}

/** JSON text as a value, or the text itself when it is not JSON. */
function parsedJson(text: string): Json {
  try { return Json.parse(JSON.parse(text)); } catch { return text; }
}

/** How many rows a sample for an authoring tool holds. */
const SAMPLE_ROWS = 5;

/** What the widget service uses, each looked up when it is needed. */
export interface WidgetDeps {
  readonly catalog: () => Pick<Catalog, 'fn' | 'entries' | 'manifest' | 'declare'>;
  readonly runs: () => Pick<RunService, 'start'>;
  readonly facts: () => Pick<FnFactsService, 'modes'>;
  readonly store: () => HubStore;
  readonly access: (actor: ActorId) => Promise<AccessScope>;
  /** Who owns a saved widget, and handing a new one to its person. */
  readonly sharing: () => Pick<AccessService, 'sharing' | 'own'>;
}

/**
 * The run a widget tool or a widget run acts in: its id, turn, person and caller. A source runs as a child called by the
 * same caller (an agent stays an agent, so its policies and approvals apply), never as the person running it by hand.
 */
type Asking = Pick<RunInfo, 'id' | 'turn' | 'user' | 'session' | 'caller'>;

/**
 * The `hub/widget` kind's description of a payload, worked out in the hub (its kind's system): refused when it isn't a
 * spec or names no fn. Its args are the source's minus the pinned and paging ones; it depends on its source and does
 * to data what its source does.
 */
export async function describeWidget(fnOf: (name: QualifiedName) => Promise<FnRecord | undefined>, payload: Json): Promise<{ problems: string[]; description?: KindDescription }> {
  const spec = WidgetSpec.safeParse(payload);
  if (!spec.success) { return { problems: spec.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`) }; }
  const source = await fnOf(spec.data.source);
  if (source === undefined) { return { problems: [`there is no fn ${spec.data.source} to draw`] }; }
  return {
    problems: [],
    description: KindDescription.parse({
      args: widgetArgs(source.decl.args, spec.data), returns: wireType(ginAs(WidgetResult)), deps: [source.name],
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card',
      ...(source.decl.effects === undefined ? {} : { effects: source.decl.effects }),
      ...(source.decl.approval === undefined ? {} : { approval: source.decl.approval }),
    }),
  };
}

/** The hub's widgets. */
export class WidgetService {
  readonly #deps: WidgetDeps;

  constructor(deps: WidgetDeps) {
    this.#deps = deps;
  }

  /** Run a widget: its source as a child run, the bindings checked against what came back. */
  async run(fn: FnRecord, args: Json, run: Asking): Promise<WidgetResult> {
    const spec = WidgetSpec.parse(fn.decl.payload);
    const source = await this.#readSource(spec.source);
    const pinned = Object.fromEntries(spec.controls.flatMap((control) => (control.pinned === undefined ? [] : [[control.arg, control.pinned]])));
    const given = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {};
    // the pager asks for a page by its offset arg; the page size is the widget's own
    const offsetArg = spec.paging?.offset;
    const asked = offsetArg === undefined ? undefined : given[offsetArg];
    const offset = typeof asked === 'number' && Number.isSafeInteger(asked) && asked >= 0 ? asked : 0;
    const paging = spec.paging === undefined ? {} : {
      ...(offsetArg === undefined ? {} : { [offsetArg]: offset }), ...(spec.paging.limit === undefined ? {} : { [spec.paging.limit]: spec.paging.size }),
    };
    const { table, run: child } = await this.#call(source.name, { ...given, ...pinned, ...paging }, run, `source:${String(offset)}`);
    const check = checkWidget(spec, { args: source.decl.args, table, visuals: await this.#visuals() });
    const visuals = [...check.visuals.filter((v) => v.visual !== TABLE_VISUAL.visual), ...check.visuals.filter((v) => v.visual === TABLE_VISUAL.visual)];
    return WidgetResult.parse({
      title: spec.title, table, source: { fn: source.name, run: child },
      visuals: visuals.some((v) => v.visual === TABLE_VISUAL.visual) ? visuals : [...visuals, TABLE_VISUAL], problems: check.problems,
      ...(offsetArg === undefined || spec.paging === undefined ? {} : { paging: { arg: offsetArg, size: spec.paging.size } }),
    });
  }

  /** `hub/widget_source`: the source's description and args, and a small sample of its result. */
  async source(name: QualifiedName, args: Json | undefined, run: Asking): Promise<{ fn: QualifiedName; description: string; args: FnDecl['args']; sample: ResultTable }> {
    const source = await this.#readSource(name);
    return { fn: source.name, description: source.decl.description, args: source.decl.args, sample: await this.#sample(source, args, run) };
  }

  /** `hub/widget_visuals`: the declared visuals that fit the source's sample, with their channels. */
  async fits(name: QualifiedName, args: Json | undefined, run: Asking) {
    const sample = await this.#sample(await this.#readSource(name), args, run);
    return fittingVisuals(sample, await this.#visuals(), true).map((fit) => ({ visual: fit.name, label: fit.label, channels: fit.shape.channels, rows: fit.shape.rows, whole: fit.shape.whole }));
  }

  /** `hub/widget_check`: every problem with a spec against a sample, and the visuals that still fit. */
  async check(input: WidgetCheck): Promise<{ problems: string[]; visuals: string[] }> {
    const source = await this.#deps.catalog().fn(input.spec.source);
    if (source === undefined) { return { problems: [`there is no fn ${input.spec.source}`], visuals: [] }; }
    const check = checkWidget(input.spec, { args: source.decl.args, table: input.sample, visuals: await this.#visuals() });
    return { problems: check.problems, visuals: check.visuals.map((v) => v.visual) };
  }

  /**
   * `hub/widget_save`: declare the widget as a fn of the hub's widget kind, as the run's person. A new widget is
   * private to them; only its owner (or an admin) saves over one.
   */
  async save(input: { name: string; description: string; spec: WidgetSpec; replace?: boolean | undefined }, run: Asking): Promise<{ fn: QualifiedName; created: boolean }> {
    const checked = await this.check({ spec: input.spec, sample: { columns: [], rows: [], offset: 0, truncated: false, sort: [] } });
    // only problems the spec has whatever the data (a missing source) stop a save; bindings were checked on a sample
    if (checked.problems.some((p) => p.startsWith('there is no fn'))) { throw new InvalidArgs(checked.problems.join('; ')); }
    const name = qualify(HUB_SYSTEM, input.name);
    const existing = await this.#deps.catalog().fn(name);
    if (existing !== undefined && input.replace !== true) { throw new RunRefused(fnError('caller', `${name} is taken: pick another name, or save over it with replace`, SAVE_FN_TAKEN)); }
    if (existing !== undefined && existing.decl.kind !== WIDGET_KIND) { throw new RunRefused(fnError('caller', `${name} is not a widget and can't be saved over`, SAVE_FN_TAKEN)); }
    const person = run.user.id;
    if (existing !== undefined) {
      const [sharing, access] = await Promise.all([this.#deps.sharing().sharing({ kind: 'fn', fn: name }), this.#deps.access(person)]);
      if (sharing.owner !== person && !access.admin) { throw new RunRefused(fnError('caller', `${name} is someone else's widget: save yours under another name`, SAVE_FN_TAKEN)); }
    }
    await this.#readSource(input.spec.source);
    const decl: FnDecl = {
      name: input.name, description: input.description, kind: WIDGET_KIND, payload: jsonOf(input.spec),
      // its kind works out the signature from the payload
      args: { name: 'any' }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: [], group: 'widgets',
    };
    const report = await this.#deps.catalog().declare(HUB_SYSTEM, decl, person);
    const refused = report.refused[0];
    if (refused !== undefined) { throw new InvalidArgs(refused.problems.join('; ') || `${name} was refused`); }
    if (existing === undefined) { await this.#deps.sharing().own({ kind: 'fn', fn: name }, person, { visibility: 'private', with: [] }); }
    return { fn: name, created: existing === undefined };
  }

  /**
   * The actions rows of these types offer, as the person may use them: each type's methods, or a widget's own list,
   * which narrows and relabels them and may bind any other fn to the row's columns.
   */
  async actions(query: WidgetActionsQuery, actor: ActorId): Promise<WidgetActionOption[]> {
    const access = await this.#deps.access(actor);
    const widget = query.widget === undefined ? undefined : await this.#deps.catalog().fn(query.widget);
    const parsed = widget?.decl.kind === WIDGET_KIND ? WidgetSpec.safeParse(widget.decl.payload) : undefined;
    const listed = parsed?.success === true ? parsed.data.actions : undefined;
    const usable = new Map<QualifiedName, FnRecord>();
    const take = async (name: QualifiedName): Promise<void> => {
      const fn = usable.has(name) ? undefined : await this.#deps.catalog().fn(name);
      if (fn !== undefined && access.mayUse(fn)) { usable.set(name, fn); }
    };
    for (const type of query.types) {
      const { system, local } = splitName(type);
      const decl = (await this.#deps.catalog().manifest(SystemName.parse(system)))?.types.find((t) => t.name === local);
      for (const method of decl?.methods ?? []) { await take(qualify(system, `${local}.${method}`)); }
    }
    for (const action of listed ?? []) { await take(action.fn); }
    const fns = [...usable.values()];
    const modes = await this.#deps.facts().modes(fns.map((fn) => fn.name));
    const rowFns: RowFn[] = fns.map((fn) => ({ fn: fn.name, mode: modes.get(fn.name) ?? 'write', args: fn.decl.args }));
    return widgetActionOptions(rowFns, listed);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** A source fn; refused when there is none. */
  async #source(name: QualifiedName): Promise<FnRecord> {
    const source = await this.#deps.catalog().fn(name);
    if (source === undefined) { throw new InvalidArgs(`there is no fn ${name}`); }
    return source;
  }

  /**
   * A source fn that reads (its mode worked out deeply, `FnFacts`); refused before anything runs otherwise. A widget
   * draws what a fn reads; its rows' actions are where it changes things.
   */
  async #readSource(name: QualifiedName): Promise<FnRecord> {
    const source = await this.#source(name);
    const mode = (await this.#deps.facts().modes([source.name])).get(source.name) ?? 'write';
    if (mode !== 'read') {
      throw new RunRefused(fnError('caller', `${source.name} ${mode === 'delete' ? 'deletes' : 'writes'}, so it can't be a widget's source: pick a fn that reads and returns a table`, 'not-a-read'));
    }
    return source;
  }

  /** A small sample of a source's result, for the authoring tools. */
  async #sample(source: FnRecord, args: Json | undefined, run: Asking): Promise<ResultTable> {
    const given = sampleArgs(args);
    const limit = 'limit' in (source.decl.args.props ?? {}) ? { limit: SAMPLE_ROWS } : {};
    // the same sample asked again in a run is the same child run
    const { table } = await this.#call(source.name, { ...given, ...limit }, run, `sample:${source.name}:${JSON.stringify(given)}`);
    return { ...table, rows: table.rows.slice(0, SAMPLE_ROWS), truncated: table.truncated || table.rows.length > SAMPLE_ROWS };
  }

  /** Call a fn as a child run of `run` and read its result as a table; refused when it isn't one. */
  async #call(fn: QualifiedName, args: Json, run: Asking, key: string): Promise<{ table: ResultTable; run: RunId }> {
    const started = await this.#deps.runs().start({
      fn, args, turn: run.turn, ...(run.session === undefined ? {} : { session: run.session }), parent: run.id, key,
      actor: run.user.id, caller: run.caller, priority: 'interactive', background: false, handlers: [],
    });
    const settled = await started.settled;
    if (settled.status !== 'done') {
      const why = settled.status === 'background' ? 'went to the background' : settled.error?.message ?? settled.status;
      throw new RunRefused(fnError('caller', `${fn} did not give a table: ${why}`, 'source-failed'));
    }
    const table = ResultTable.safeParse(settled.result);
    if (!table.success) { throw new RunRefused(fnError('caller', `${fn} does not return a table, so it can't be drawn as a widget`, 'not-a-table')); }
    return { table: table.data, run: started.run };
  }

  /** Every visual of the hub's registry, as every system contributes them. */
  async #visuals(): Promise<ContributionDecl[]> {
    // the systems table is small and bounded; each manifest is the catalog's kept copy
    const systems = (await allRows(this.#deps.store().table('systems'))).map((row) => row.name);
    const manifests = await Promise.all([...new Set([HUB_SYSTEM, ...systems])].map((system) => this.#deps.catalog().manifest(system)));
    return manifests.flatMap((manifest) => (manifest?.contributes ?? []).filter((entry) => entry.registry === HUB_VISUALS));
  }
}
