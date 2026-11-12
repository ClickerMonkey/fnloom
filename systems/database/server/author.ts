/**
 * The enricher: a model refines one table's simple type (a description, and per column a closed set of values, a
 * format, a range and examples), read off the column's shape and a sample of its rows. The answer is structured
 * output (`llm.object`) of `EnrichmentAnswer`, so the schema is the one place its shape is written; columns the table
 * doesn't have are dropped. Queries are written by the query authoring agent (`authoring.ts`).
 */
import { ginAs, type Llm } from '@harness/sdk';
import type { Rows } from './drivers/index.ts';
import type { ScannedTable } from './schema.ts';
import { EnrichmentAnswer, enrichmentOf, type TableEnrichment } from './types.ts';

/** Refines a table's type. Throws when the model can't be asked or its answer doesn't fit. */
export interface Enricher {
  enrich(table: ScannedTable, sample: Rows, distinct: Readonly<Record<string, readonly string[]>>, llm: Llm, model: string | undefined): Promise<TableEnrichment>;
}

/** How the enricher is told to work; the answer's shape and what each field means come from `EnrichmentAnswer`. */
export const ENRICH_GUIDE = [
  'You refine the type of a database table, to the most specific the data supports. You get the table\'s columns, a sample of rows, and for some text columns every distinct value (when there are few).',
  'Leave out what you are not sure of. Never invent values a column doesn\'t show.',
  'Example: for a column status holding only "open", "paid" and "void", answer { "column": "status", "description": "Where the order is in its life.", "values": ["open", "paid", "void"] }; for a column email, { "column": "email", "format": "email" }.',
].join('\n');

/** The answer's gin type, read off the schema. */
const ANSWER = ginAs(EnrichmentAnswer);

/** `Enricher` over the run's or the system's model calls. */
export class LlmEnricher implements Enricher {
  async enrich(table: ScannedTable, sample: Rows, distinct: Readonly<Record<string, readonly string[]>>, llm: Llm, model: string | undefined): Promise<TableEnrichment> {
    const columns = table.spec.columns.map((column) => `- ${column.name}: ${JSON.stringify(column.type)}${column.nullable ? ', nullable' : ''}${column.values === undefined ? '' : `, one of ${column.values.join(', ')}`}`);
    const sets = Object.entries(distinct).map(([column, values]) => `- ${column}: ${values.map((value) => JSON.stringify(value)).join(', ')}`);
    const prompt = [
      `Table ${table.spec.name} (${String(table.rows)} rows). Columns:`, ...columns,
      'Sample rows:', JSON.stringify({ columns: sample.columns, rows: sample.rows }),
      ...(sets.length === 0 ? [] : ['Every distinct value of these columns:', ...sets]),
    ].join('\n');
    // the gin type carries records as any JSON, so the schema itself checks the answer
    const answer = EnrichmentAnswer.parse(await llm.object({ system: ENRICH_GUIDE, prompt, output: ANSWER, ...(model === undefined ? {} : { model: { model } }) }));
    return enrichmentOf(answer, new Set(table.spec.columns.map((column) => column.name)));
  }
}
