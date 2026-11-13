/**
 * Tables (widget pass, build-8-widgets-design.md): what the hub does for results that are tables, now that widgets
 * are the bundled `widgets` system's. The hub keeps only its `native` and `llm` kinds; this module is the rest:
 *
 * - **Read a table** (`hub/read_table`): run a read fn that returns a `ResultTable` as a child run of the caller, as
 *   its person, refused before anything runs when the fn is not a read (worked out deeply) and after when it gave no
 *   table.
 * - **The visual registry** (`hub/visuals`): every `HUB_VISUALS` contribution, the hub's own first (the built-in
 *   families, `core/visuals.ts`), then each system the person may see, in name order.
 * - **Row actions** (`hub/row_actions`, web `rowActions`): the methods of the rows' types and any fn a widget binds,
 *   as the person may use them, derived by the sdk's `widgetActionOptions`.
 * - **Streamed export** (`GET /api/export`): a read fn's whole result as CSV, page by page as the person in one turn,
 *   cut at `HARNESS_EXPORT_MAX_ROWS` with a final line.
 * - **The widget migration**: build 8's `hub/widget` fns become `widgets/<name>` fns of `widgets/widget`
 *   (`migrate.ts`), at start, whether or not the widgets system is paired yet.
 */
import type { ActorId, ContributionView, ExportQuery, Json, ReadTableArgs, ResultTable, RowActionsQuery, RunInfo, UserView, WidgetActionOption } from '@harness/core';

/**
 * The run a table is read in: its id, turn, person and caller. A source runs as a child called by the same caller (an
 * agent stays an agent, so its policies and approvals apply).
 */
export type TableAsker = Pick<RunInfo, 'id' | 'turn' | 'user' | 'session' | 'caller'>;

/** The hub's table operations. */
export interface TableService {
  /** Run a read fn returning a table as a child run of `run`; refused for a fn that is not a read or gives no table. */
  read(input: ReadTableArgs, run: TableAsker): Promise<ResultTable>;
  /**
   * Run a read fn as the person outside any session (the web's quiet read: a widget's pager, range, drill, refresh and
   * live re-runs) in a turn of its own, and give its output; refused for a fn the person can't see or that isn't a read,
   * and for a run that waits for an approval (nobody can give one there). The run is cancelled when `signal` aborts or
   * it runs past `HARNESS_QUIET_READ_TIMEOUT`.
   */
  readAs(input: ReadTableArgs, user: UserView, signal?: AbortSignal): Promise<Json>;
  /** Every visual of the registry the person may see: the hub's own in declared order, then each system's by name. */
  visuals(actor: ActorId): Promise<ContributionView[]>;
  /** The actions rows of these types offer the person, narrowed by a widget's list. */
  rowActions(query: RowActionsQuery, actor: ActorId): Promise<WidgetActionOption[]>;
  /**
   * A read fn's result as CSV, a page at a time, run as the person in one turn. Refuses (before the first byte) a fn
   * that is not a read, args that are not a JSON object, or a first page that is not a table.
   */
  export(query: ExportQuery, user: UserView, signal?: AbortSignal): Promise<{ name: string; lines: AsyncIterable<string> }>;
}
