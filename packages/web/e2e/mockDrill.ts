/**
 * The mock hub's drill-downs (build-9 feedback, drill-downs through the query): the chart gallery's grouped results
 * carry the drill a saved grouped query's result would (`ResultTable.drill`, naming `database/drill_down`), and the
 * quiet read answers `database/drill_down` with the rows behind the group clicked, a page at a time. The notes widget's
 * own pages and its own drill (a note's words) are read quietly here too, so its pager and drill modal open in the mock.
 */
import { Json, type ReadTableArgs, type ResultTable } from '@harness/core';
import { DRILL_FN, drillableSample, drilledRows } from '../src/components/widgets/test/drill.ts';
import { widgetRunOutput } from './mockBuild8.ts';

/** A gallery result as its run's output: drillable through the query when its family groups. */
export function galleryResult(family: string, table: ResultTable): Json {
  return Json.parse(drillableSample(family, table));
}

/** A quiet read the mock answers here: a drill's rows, or the notes widget's page or drill; undefined for any other fn. */
export function drillRead(input: ReadTableArgs): Json | undefined {
  if (input.fn === DRILL_FN) {
    const rows = drilledRows(Json.parse(input.args));
    return rows === undefined ? undefined : Json.parse(rows);
  }
  return widgetRunOutput(input.fn, Json.parse(input.args));
}
