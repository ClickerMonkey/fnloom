/**
 * The widgets system's implementation: the `widget` kind (check, describe and run), `make_widget` (the authoring agent
 * in `authoring.ts`, which proposes) and `save_widget` (the person's Save, through `hub/save_fn`). Nothing is stored
 * here: saved widgets, who may use them and their versions are the hub's; every run reads its source fresh.
 */
import {
  ContributionView, Json, KindDescription, MakeWidgetArgs, QualifiedName, ResultTable, WIDGET_KIND, WidgetActionOption, WidgetResult, WidgetSpec, jsonOf, splitName,
  type GinTypeDef, type RunInfo,
} from '@harness/core';
import {
  CallFailed, SAVE_FN_TAKEN, argsOf, encodeValue, ginAs, hub, pagingOf, parseValue, returnsTable, sourceCompatible, widgetArgs, wireType,
  type FnCtx, type Infer, type KindCheckCtx, type StoredFn, type SystemImpl, type TypesOf,
} from '@harness/sdk';
import { AuthoringError } from '@harness/sdk/server';
import { z } from 'zod';
import { widgets, type WidgetsContract } from '../shared/index.ts';
import { WidgetAuthoring, widgetAuthoring, type SourceDecl } from './authoring.ts';
import type { WidgetsSettings } from './env.ts';
import { runWidget, type WidgetHub } from './run.ts';

/** Everything the implementation is built from. */
export interface WidgetsDeps {
  readonly settings: WidgetsSettings;
}

const VisualList = z.array(ContributionView);
const ActionList = z.array(WidgetActionOption);
const Args = z.record(z.string(), Json);

/** A run's args as an object (a widget's args type is an object, which the hub checked). */
function argsObject(args: Json): Record<string, Json> {
  const parsed = Args.safeParse(args);
  return parsed.success ? parsed.data : {};
}

/** A fn as `hub/fn_get` gives it, as the source a widget reads: its args type and whether its rows change on their own. */
function sourceDecl(stored: Infer<typeof StoredFn>): SourceDecl {
  const fn = QualifiedName.parse(stored.fn);
  if (stored.args === undefined) { throw new Error(`The hub gave no args type for ${fn}.`); }
  return { fn, description: stored.description, args: stored.args, ...(stored.live === undefined ? {} : { live: stored.live }) };
}

/** How a widget's source and drill are declared, wherever they are looked up (the kind's own lookups or `hub/fn_get`). */
interface DeclaredFn {
  readonly args: GinTypeDef;
  readonly returns: GinTypeDef;
}

/**
 * Every problem with a spec against its source (a fn returning a table, whose args take the plans) and its drill (a
 * fn returning a table); a fn the lookup can't find is not judged here.
 */
async function declaredProblems(spec: WidgetSpec, lookup: (fn: QualifiedName) => Promise<DeclaredFn | undefined>): Promise<string[]> {
  const problems: string[] = [];
  const source = await lookup(spec.source);
  if (source !== undefined) {
    if (!returnsTable(source.returns)) { problems.push(`${spec.source} does not return a table, so it can't be a widget's source: pick a read fn that returns one.`); }
    problems.push(...sourceCompatible(spec, source.args));
  }
  const drill = spec.drill === undefined ? undefined : await lookup(spec.drill.fn);
  if (spec.drill !== undefined && drill !== undefined && !returnsTable(drill.returns)) { problems.push(`Drill: ${spec.drill.fn} does not return a table to open.`); }
  return problems;
}

/**
 * Every problem with a payload against the fns the kind can look up: its source (a fn returning a table, whose args
 * take the plans) and its drill (a fn returning a table), as the hub declares them (`KindCheckCtx.fn`). A fn the
 * system may not see is not judged here; the run reads the source through the hub and lists what doesn't fit.
 */
function specProblems(spec: WidgetSpec, ctx: KindCheckCtx): Promise<string[]> {
  return declaredProblems(spec, (fn) => ctx.fn(fn));
}

/** When and where a run is: its person's now and time zone, and the pager's window. */
function runOptions(run: RunInfo, settings: WidgetsSettings): { now: Date; zone: string; window: number } {
  return { now: new Date(run.time.now), zone: run.user.timeZone, window: settings.WIDGETS_WINDOW };
}

/** The hub fns a run of `save_widget` calls. */
type SaveFns = FnCtx<TypesOf<WidgetsContract['defs']['fns']['save_widget']>>['fns'];
/** `hub/save_fn` as a run of `save_widget` calls it. */
type SaveFn = SaveFns['saveFn'];

/**
 * Every problem with a widget about to be saved, against its source and drill as `hub/fn_get` declares them to the
 * person (the kind's check sees them as the system): a source the person can't read, or that the hub gives no types
 * for, is a problem too. Whether the source only reads is the hub's to refuse when the widget runs (`hub/read_table`).
 */
async function saveProblems(spec: WidgetSpec, getFn: SaveFns['getFn']): Promise<string[]> {
  const unknown: string[] = [];
  const problems = await declaredProblems(spec, async (fn) => {
    try {
      const stored = await getFn({ fn });
      if (stored.args !== undefined && stored.returns !== undefined) { return { args: stored.args, returns: stored.returns }; }
    } catch (error) {
      if (!(error instanceof CallFailed)) { throw error; }
    }
    unknown.push(`${fn} is not a fn you can read, so the widget can't use it.`);
    return undefined;
  });
  return [...unknown, ...problems];
}

/** Whether a hub fn failed because the name is taken. */
function taken(error: unknown): boolean {
  return error instanceof CallFailed && error.error.class !== 'cancelled' && error.error.code === SAVE_FN_TAKEN;
}

/**
 * Keep a widget as a `widgets/widget` fn of the run's person: over the widget it replaces (the hub refuses unless the
 * person owns it), else under its name or the next free one (`sales_by_month`, `sales_by_month_2`, …).
 */
async function keepWidget(saveFn: SaveFn, args: Infer<typeof widgets.fns.save_widget.args>, tries: number): Promise<Infer<typeof widgets.fns.save_widget.returns> | undefined> {
  const spec = WidgetSpec.parse(args.spec);
  const save = (name: string, replace: boolean) => saveFn({
    kind: WIDGET_KIND, name, description: args.description.trim(),
    instructions: `Draws "${spec.title}" from ${spec.source}; give the widget's args to change its chips.`,
    payload: encodeValue(widgets.kinds.widget.payload, spec), examples: [{ args: {} }], tags: ['widgets'],
    ...(replace ? { replace: true } : { share: { visibility: 'private', with: [] } }),
  });
  if (args.replace !== undefined) {
    const saved = await save(splitName(QualifiedName.parse(args.replace)).local, true);
    return { fn: saved.fn, version: saved.version, created: saved.created };
  }
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const saved = await save(attempt === 0 ? args.name : `${args.name}_${String(attempt + 1)}`, false);
      return { fn: saved.fn, version: saved.version, created: saved.created };
    } catch (error) {
      if (!taken(error)) { throw error; }
    }
  }
  return undefined;
}

/** Build the widgets implementation. */
export function createWidgetsImpl(deps: WidgetsDeps): SystemImpl<WidgetsContract['defs']> {
  const s = deps.settings;
  return {
    fns: {
      make_widget: {
        async run(input, ctx) {
          // `args` is a JSON object in gin's eyes only as `any`, so its shape is checked here
          const checked = MakeWidgetArgs.safeParse(input);
          // each problem keeps its path, so the caller sees which arg is wrong (`source`, `args`)
          if (!checked.success) {
            return ctx.invalid(checked.error.issues.map((issue) => {
              const path = issue.path.join('.');
              return { path, message: path === 'args' ? `${issue.message}. Give \`args\` as an object of the source's args, such as { "since": "2026-03-01" }.` : issue.message };
            }));
          }
          const args = checked.data;
          const source = args.source;
          const sourceOf = async (fn: QualifiedName): Promise<SourceDecl> => sourceDecl(await ctx.fns.getFn({ fn }));
          const readTable = async (fn: QualifiedName, given: Readonly<Record<string, Json>>) => {
            const call = ctx.fns.readTable({ fn, args: { ...given } });
            return { table: ResultTable.parse(await call), run: await call.run };
          };
          const hubOf: WidgetHub = {
            read: readTable,
            visuals: async () => VisualList.parse(await ctx.fns.visuals({})),
            rowActions: async (query) => ActionList.parse(await ctx.fns.rowActions(query)),
          };
          // the source is sampled with the given args (the pager's own aside), so each required one must be there
          const declared = await sourceOf(source);
          const paging = pagingOf(declared.args);
          const missing = argsOf(declared.args).filter((arg) => arg.required && args.args?.[arg.name] === undefined && arg.name !== paging?.offset && arg.name !== paging?.limit);
          if (missing.length > 0) { return ctx.invalid(`${source} needs ${missing.map((arg) => arg.name).join(', ')}: give a sample value for each in \`args\`.`); }
          const edited = args.widget === undefined ? undefined : await ctx.fns.getFn({ fn: args.widget });
          if (edited !== undefined && edited.kind !== WIDGET_KIND) { return ctx.fail('caller', `${args.widget ?? ''} is not a widget, so it can't be changed here.`); }
          const state = new WidgetAuthoring({
            source: sourceOf,
            sample: async (fn, given) => (await readTable(fn, given)).table,
            visuals: () => hubOf.visuals(),
            rowActions: async (types, fns) => {
              // the types' methods, then the other fns named, each as the person may use it
              const methods = types.length === 0 ? [] : await hubOf.rowActions({ types: [...types] });
              const others = fns.length === 0 ? [] : await hubOf.rowActions({ types: [], narrow: fns.map((fn) => ({ fn, bind: {} })) });
              return [...methods, ...others.filter((other) => !methods.some((method) => method.fn === other.fn))];
            },
            preview: (spec, decl, given) => runWidget({ spec, source: decl, given, options: runOptions(ctx.run, s), liveFloor: s.HARNESS_WIDGET_LIVE_FLOOR }, hubOf),
            sampleRows: s.WIDGETS_SAMPLE_ROWS,
          }, {
            source, args: args.args ?? {}, fns: args.fns ?? [],
            ...(edited === undefined ? {} : { edited: { fn: QualifiedName.parse(edited.fn), spec: WidgetSpec.parse(edited.payload) } }),
          });
          try {
            await widgetAuthoring.run(await ctx.ai(), args.request, state);
          } catch (error) {
            if (!(error instanceof AuthoringError)) { throw error; }
            const last = error.problems.length === 0 ? '' : ` Its last problems: ${error.problems.join(' ')}`;
            return ctx.fail('caller', `No widget was proposed: ${error.message}${last} Say more exactly what to show, or pick another source.`);
          }
          const proposal = state.proposal;
          if (proposal === undefined) { return ctx.fail('caller', 'The widget authoring agent ended without a proposal.'); }
          return ctx.done({
            name: proposal.draft.name, description: proposal.draft.description, spec: proposal.draft.spec, preview: proposal.preview, show: args.show,
            ...(args.widget === undefined ? {} : { replaces: args.widget }),
          });
        },
      },
      save_widget: {
        async run(args, ctx) {
          const problems = await saveProblems(WidgetSpec.parse(args.spec), ctx.fns.getFn);
          if (problems.length > 0) { return ctx.fail('caller', `The widget can't be saved: ${problems.join(' ')}`); }
          const kept = await keepWidget(ctx.fns.saveFn, args, s.WIDGETS_NAME_TRIES);
          if (kept === undefined) { return ctx.fail('caller', `Every name tried for ${args.name} is taken; give the widget another name.`, { code: SAVE_FN_TAKEN }); }
          ctx.log.info('widgets.saved', { widget: kept.fn, created: kept.created });
          return ctx.done(kept);
        },
      },
    },
    kinds: {
      widget: {
        check: (payload, ctx) => specProblems(WidgetSpec.parse(payload), ctx),
        async describe(payload, ctx) {
          const spec = WidgetSpec.parse(payload);
          const source = await ctx.fn(spec.source);
          // a source the system may not see leaves the args to the run, which reads it through the hub as the person
          const args: GinTypeDef = source === undefined ? { name: 'any' } : widgetArgs(source.args, spec);
          return KindDescription.parse({
            args, returns: wireType(ginAs(WidgetResult)),
            deps: [spec.source, ...(spec.drill === undefined ? [] : [spec.drill.fn]), hub.fns.fn_get.name, hub.fns.read_table.name, hub.fns.visuals.name, hub.fns.row_actions.name],
            operations: { cancel: true, pause: false, undo: false, background: false },
            display: 'card',
            effects: { mode: 'read' },
          });
        },
        async run(payload, args, ctx) {
          const spec = WidgetSpec.parse(payload);
          const source = sourceDecl(parseValue(hub.fns.fn_get.returns, await ctx.call(hub.fns.fn_get.name, { fn: spec.source })));
          const widgetHub: WidgetHub = {
            async read(fn, given) {
              // through hub/read_table, which refuses a source that writes or doesn't return a table (a saved widget's
              // source is checked when it is saved, but its fn may change since) and runs it as a child of this run
              const call = ctx.call(hub.fns.read_table.name, jsonOf({ fn, args: given }));
              return { table: ResultTable.parse(await call), run: await call.run };
            },
            visuals: async () => VisualList.parse(await ctx.call(hub.fns.visuals.name, {})),
            rowActions: async (query) => ActionList.parse(await ctx.call(hub.fns.row_actions.name, jsonOf(query))),
          };
          const result = await runWidget({ spec, source, given: argsObject(args), options: runOptions(ctx.run, s), liveFloor: s.HARNESS_WIDGET_LIVE_FLOOR }, widgetHub);
          // a kind's result is plain JSON; runWidget checked it against WidgetResult already
          return ctx.done(jsonOf(result));
        },
      },
    },
  };
}

