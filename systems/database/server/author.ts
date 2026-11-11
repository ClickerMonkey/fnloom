/**
 * The enricher: a model refines one table's simple type (a description, and per column a closed set of values, a
 * format, a range and examples), read off the column's shape and a sample of its rows. A refused answer goes back
 * with its problems a few times at most. Queries are written by the query authoring agent (`authoring.ts`).
 */
import type { Llm } from '@harness/sdk';
import type { z } from 'zod';
import type { Rows } from './drivers/index.ts';
import type { ScannedTable } from './schema.ts';
import { TableEnrichment } from './types.ts';

/** The JSON object in a model's answer (fences and words around it dropped), checked by a schema. */
export function readAnswer<T>(answer: string, schema: z.ZodType<T>): T | { problem: string } {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end < start) { return { problem: 'Answer with one JSON object.' }; }
  let json: unknown;
  try {
    json = JSON.parse(answer.slice(start, end + 1));
  } catch (error) {
    return { problem: `The answer isn't valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : { problem: `The answer doesn't have the asked fields: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}` };
}

// ─── The enricher ────────────────────────────────────────────────────────────

/** Refines a table's type. */
export interface Enricher {
  enrich(table: ScannedTable, sample: Rows, distinct: Readonly<Record<string, readonly string[]>>, llm: Llm, model: string | undefined): Promise<TableEnrichment | { problems: string[] }>;
}

/** How the enricher is told to work. */
export const ENRICH_GUIDE = [
  'You refine the type of a database table, to the most specific the data supports. You get the table\'s columns, a sample of rows, and for some text columns every distinct value (when there are few).',
  'Answer with only this JSON object: { "description": one sentence on what a row is, "columns": { "<column>": { "description"?: what it holds, "values"?: [the closed set of values, only when the column clearly holds one: a status, a type, a category], "format"?: one of email, url, uuid, phone, iso-date, country-code, currency-code, "min"?: number, "max"?: number (only for clear bounds like a percentage or a rating), "examples"?: up to 3 typical values as text } } }.',
  'Leave out what you are not sure of. Never invent values a column doesn\'t show.',
].join('\n');

/** `Enricher` over the run's or the system's model calls. */
export class LlmEnricher implements Enricher {
  readonly #retries: number;

  constructor(options: { retries: number }) {
    this.#retries = options.retries;
  }

  async enrich(table: ScannedTable, sample: Rows, distinct: Readonly<Record<string, readonly string[]>>, llm: Llm, model: string | undefined): Promise<TableEnrichment | { problems: string[] }> {
    const columns = table.spec.columns.map((column) => `- ${column.name}: ${JSON.stringify(column.type)}${column.nullable ? ', nullable' : ''}${column.values === undefined ? '' : `, one of ${column.values.join(', ')}`}`);
    const sets = Object.entries(distinct).map(([column, values]) => `- ${column}: ${values.map((value) => JSON.stringify(value)).join(', ')}`);
    const task = [
      `Table ${table.spec.name} (${table.rows} rows). Columns:`, ...columns,
      'Sample rows:', JSON.stringify({ columns: sample.columns, rows: sample.rows }),
      ...(sets.length === 0 ? [] : ['Every distinct value of these columns:', ...sets]),
    ].join('\n');
    let prompt = task;
    let problems: string[] = [];
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const answer = await llm.text({ system: ENRICH_GUIDE, prompt, ...(model === undefined ? {} : { model: { model } }) });
      const read = readAnswer(answer, TableEnrichment);
      if (!('problem' in read)) {
        const names = new Set(table.spec.columns.map((column) => column.name));
        const unknown = Object.keys(read.columns).filter((name) => !names.has(name));
        if (unknown.length === 0) { return read; }
        problems = [`These are not columns of ${table.spec.name}: ${unknown.join(', ')}.`];
      } else {
        problems = [read.problem];
      }
      prompt = `${task}\n\nYour last answer was refused:\n${answer}\n\nFix: ${problems.join(' ')}`;
    }
    return { problems };
  }
}
