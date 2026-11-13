/**
 * The hub's widget fns in memory, for tests of systems that draw from tables (the widgets system, a system with its
 * own visual): `hub/read_table` answers from the tables a test registers per fn, `hub/visuals` from `visuals` (every
 * built-in family, then whatever a test adds), and `hub/row_actions` derives the menu from the row fns a test registers
 * per row type with the SDK's own `widgetActionOptions`, as the hub does. `FakeHub` holds one as `widgets`.
 */
import { Json, ReadTableArgs, ResultTable, RowActionsQuery, SystemName, type ContributionView, type QualifiedName, type RunSettled } from '@harness/core';
import { hub } from '../hub.ts';
import { BUILT_IN_CONTRIBUTIONS, widgetActionOptions, type RowFn } from '../widgets.ts';

/** The hub fns this fake answers, by the hub contract's names. */
export const HUB_WIDGET_FNS = { readTable: hub.fns.read_table.name, visuals: hub.fns.visuals.name, rowActions: hub.fns.row_actions.name } as const;

/** What a registered source answers for its args. */
export type FakeTableSource = ResultTable | ((args: Readonly<Record<string, Json>>) => ResultTable);

/** A call the fake hub got. */
interface HubCall {
  readonly fn: string;
  readonly args: Json;
}

/** The hub's widget fns in memory. */
export class FakeHubWidgets {
  /** What `hub/visuals` answers: the built-in families as the hub contributes them; push a system's own. */
  readonly visuals: ContributionView[] = BUILT_IN_CONTRIBUTIONS.map((entry) => ({ ...entry, system: SystemName.parse('hub') }));
  /** Every `hub/read_table` call, in order: the fn and the args it ran with. */
  readonly reads: ReadTableArgs[] = [];
  readonly #tables = new Map<QualifiedName, FakeTableSource>();
  readonly #rowFns = new Map<QualifiedName, readonly RowFn[]>();

  /** Register a read fn returning a table: its rows, or a function of its args (to page or filter). */
  table(fn: QualifiedName, source: FakeTableSource): void {
    this.#tables.set(fn, source);
  }

  /** Register the fns a row type offers (its methods and any fn a widget may bind). */
  rowFns(type: QualifiedName, fns: readonly RowFn[]): void {
    this.#rowFns.set(type, fns);
  }

  /** Settle a call to one of `HUB_WIDGET_FNS`; `undefined` for any other fn. */
  settle(call: HubCall): RunSettled | undefined {
    try {
      switch (call.fn) {
        case HUB_WIDGET_FNS.readTable: return { status: 'done', result: this.#read(ReadTableArgs.parse(call.args)) };
        case HUB_WIDGET_FNS.visuals: return { status: 'done', result: Json.parse(this.visuals) };
        case HUB_WIDGET_FNS.rowActions: {
          const query = RowActionsQuery.parse(call.args);
          return { status: 'done', result: Json.parse(widgetActionOptions(query.types.flatMap((type) => this.#rowFns.get(type) ?? []), query.narrow)) };
        }
        default: return undefined;
      }
    } catch (error) {
      return { status: 'failed', error: { class: 'caller', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  /** `hub/read_table`: the registered source's table, refused (as the hub refuses) for any other fn. */
  #read(args: ReadTableArgs): Json {
    this.reads.push(args);
    const source = this.#tables.get(args.fn);
    if (source === undefined) { throw new Error(`${args.fn} is not a read fn that returns a table (register it with hub.widgets.table).`); }
    return Json.parse(ResultTable.parse(typeof source === 'function' ? source(args.args) : source));
  }
}

