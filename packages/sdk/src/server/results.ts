/**
 * Building the model's result block (`ResultBlock`) from the rows the person is shown (`ResultTable`). The sample is
 * the first rows that fit a token budget (an estimate: four characters a token), with long text cut; the rest stays
 * with the person, and the block says so, with the exact call for the next page when there are more rows. With nobody
 * watching (`RunInfo.watched` not true: a nested agent, an MCP call, a background run) the rows are kept with the run
 * but shown to no one, so the block is worded headless and the model answers from the sample.
 */
import type { Json, ResultTable } from '@harness/core';
import type { NextPage, ResultBlock, ResultFn } from '../results.ts';
import { sdkEnv } from './env.ts';

/** What `resultBlock` needs besides the rows. */
export interface ResultBlockOptions {
  /** The fn that read the rows, and its signature, to call it again. */
  readonly fn: ResultFn;
  /** The args it was called with; the next page's call is these with the next `offset` and `limit`. */
  readonly args?: Readonly<Record<string, Json>>;
  /** What the person sees the rows as (default `a table`), for the sentence the model reads. */
  readonly visual?: string;
  /** The sample's token budget. Default: `HARNESS_RESULT_SAMPLE_TOKENS`. */
  readonly budget?: number;
  /** The most characters of one text cell in the sample. Default: `HARNESS_RESULT_CELL_CHARS`. */
  readonly cellChars?: number;
  /** Whether a person is watching the run (`RunInfo.watched === true`), so the rows are shown to them. Default true. */
  readonly watched?: boolean;
}

/** The result block for rows read: shown to the person when someone is watching, else worded headless. */
export function resultBlock(table: ResultTable, options: ResultBlockOptions): ResultBlock {
  const block = shownBlock(table, options);
  if (options.watched ?? true) { return block; }
  const { sampleNote: _shownNote, ...rest } = block;
  const counted = block.total !== undefined && block.total > block.rowCount ? ` (of ${block.total})` : '';
  const more = block.nextPage === undefined ? '' : ` There are more rows: ${block.nextPage.call} reads the next ${block.nextPage.limit}.`;
  const shown = block.rowCount === 0
    ? 'No rows matched. Nobody is watching this run, so say so in your answer.'
    : `${block.rowCount === 1 ? 'One row was' : `${block.rowCount} rows${counted} were`} read. Nobody is watching this run, so no one sees them: answer from the sample.${more}`;
  return block.sample.length < block.rowCount
    ? { ...rest, shown, sampleNote: `The sample holds the first ${block.sample.length} of the ${block.rowCount} rows read.` }
    : { ...rest, shown };
}

/** The result block for rows shown to the person. */
function shownBlock(table: ResultTable, options: ResultBlockOptions): ResultBlock {
  const tunables = options.budget === undefined || options.cellChars === undefined ? sdkEnv.parse() : undefined;
  const budget = options.budget ?? tunables?.HARNESS_RESULT_SAMPLE_TOKENS ?? 0;
  const cellChars = options.cellChars ?? tunables?.HARNESS_RESULT_CELL_CHARS ?? 0;
  const rowCount = table.rows.length;
  const { sample, cut } = sampleOf(table, budget, cellChars);
  const nextPage = nextPageOf(table, options);
  const block: ResultBlock = {
    shown: shownSentence(rowCount, table.total, options.visual ?? 'a table', nextPage),
    columns: table.columns.map((c) => ({ name: c.name, kind: c.kind, nullable: c.nullable })),
    rowCount,
    truncated: table.truncated,
    sort: table.sort.map((s) => ({ ...s })),
    sample,
    fn: { ...options.fn },
  };
  if (table.total !== undefined) { block.total = table.total; }
  if (nextPage !== undefined) { block.nextPage = nextPage; }
  const note = sampleNote(sample.length, rowCount, cut, cellChars);
  if (note !== undefined) { block.sampleNote = note; }
  return block;
}

/** What the person sees, in one or two plain sentences. */
function shownSentence(rows: number, total: number | undefined, visual: string, next: NextPage | undefined): string {
  if (rows === 0) { return 'No rows matched. The person sees an empty result; say so plainly.'; }
  const counted = total !== undefined && total > rows ? ` (of ${total})` : '';
  const these = rows === 1 ? `This row is shown` : `These ${rows} rows${counted} are shown`;
  const more = next === undefined ? '' : ` There are more rows: ${next.call} reads the next ${next.limit}.`;
  return `${these} to the person as ${visual}; they can switch to another view. Don't repeat them; summarize or point out what matters.${more}`;
}

/** The first rows, as objects, that fit the budget; text cells cut to `cellChars`. */
function sampleOf(table: ResultTable, budget: number, cellChars: number): { sample: Record<string, Json>[]; cut: boolean } {
  const sample: Record<string, Json>[] = [];
  let cut = false;
  let spent = 0;
  for (const row of table.rows) {
    const record: Record<string, Json> = {};
    let rowCut = false;
    table.columns.forEach((column, i) => {
      const cell = row[i] ?? null;
      if (typeof cell === 'string' && cell.length > cellChars) {
        record[column.name] = `${cell.slice(0, cellChars)}…`;
        rowCut = true;
      } else {
        record[column.name] = cell;
      }
    });
    const tokens = Math.ceil(JSON.stringify(record).length / 4);
    if (spent + tokens > budget) { break; }
    spent += tokens;
    cut ||= rowCut;
    sample.push(record);
  }
  return { sample, cut };
}

/** The next page, when the table says there are more rows and was read with a limit. */
function nextPageOf(table: ResultTable, options: ResultBlockOptions): NextPage | undefined {
  if (!table.truncated || table.limit === undefined) { return undefined; }
  const offset = table.offset + table.rows.length;
  const args = { ...options.args, offset, limit: table.limit };
  return { offset, limit: table.limit, call: `${options.fn.name}(${JSON.stringify(args)})` };
}

/** Says how much of the page the sample holds, when it isn't all of it as it is. */
function sampleNote(sampled: number, rows: number, cut: boolean, cellChars: number): string | undefined {
  const parts: string[] = [];
  if (sampled < rows) { parts.push(sampled === 0 ? 'No rows fit the sample; the person has them all.' : `The first ${sampled} of ${rows} rows; the person has them all.`); }
  if (cut) { parts.push(`Text longer than ${cellChars} characters is cut.`); }
  return parts.length === 0 ? undefined : parts.join(' ');
}
