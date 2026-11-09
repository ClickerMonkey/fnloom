/**
 * The model-written parts of the system, each checked and sent back with its problems a few times at most:
 *
 * - **The query agent** writes (or edits) an `@aeye/query` query against the database's table types, with a fn name,
 *   a description and the columns callers may sort by; the engine checks it (`compileQuery`).
 * - **The enricher** refines one table's simple type: a description, and per column a closed set of values, a
 *   format, a range and examples, read off the column's shape and a sample of its rows.
 */
import { Json } from '@harness/core';
import type { Llm } from '@harness/sdk';
import { z } from 'zod';
import { compileQuery, type CompiledQuery } from './compile.ts';
import type { TableCatalog } from './catalog.ts';
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

// ─── The query agent ─────────────────────────────────────────────────────────

/** What the query agent answers with. */
export const WrittenQuery = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/).describe('A snake_case fn name for it.'),
  title: z.string().min(1),
  description: z.string().min(1),
  query: z.unknown(),
  sorters: z.array(z.string()).default([]),
  /** The values to run it with now, for its params. */
  args: z.record(z.string(), Json).default({}),
});
export type WrittenQuery = z.infer<typeof WrittenQuery>;

/** A checked query the agent wrote. */
export interface AuthoredQuery {
  readonly written: WrittenQuery;
  readonly compiled: CompiledQuery;
}

/** What the agent may do in a database. */
export interface AuthorRules {
  readonly writes: boolean;
}

/** Writes queries for descriptions, and edits them by instructions. */
export interface QueryAuthor {
  write(request: string, catalog: TableCatalog, rules: AuthorRules, llm: Llm): Promise<AuthoredQuery | { problems: string[] }>;
  edit(current: WrittenQuery, instructions: string, catalog: TableCatalog, rules: AuthorRules, llm: Llm): Promise<AuthoredQuery | { problems: string[] }>;
  /** The args a request gives a saved query's fn, by its signature. */
  argsFor(request: string, signature: string, llm: Llm): Promise<Record<string, Json>>;
}

/** How the query agent is told to write. */
export function queryGuide(catalog: TableCatalog, rules: AuthorRules): string {
  return [
    `You write queries for a ${catalog.dialectName} database in @aeye/query's JSON query language. Its schema and language:`,
    catalog.describe(),
    'Rules:',
    '- Use only the types and fields above. Reference a field as { "kind": "field-ref", "source": "<type>", "field": "<field>" }.',
    '- Join over a relation field: "joins": [{ "on": { "kind": "relation", "source": "orders", "field": "customer", "as": "customers" } }], then read the joined fields with source "customers".',
    '- Put every value the request leaves open (a name, a date, an amount) in a { "kind": "param", "name": "<name>" } so the query can be called again with other values; write fixed values as literals.',
    '- Give output fields clear names with "as". Do not add a "limit" for a list: callers page it. Only a fixed top-N ("the 5 largest") has its own limit.',
    rules.writes ? '- Inserts, updates and deletes are allowed; each waits for the person\'s approval before it runs.' : '- This database is read-only: only select queries (and set operations or CTEs over them).',
    'Answer with only this JSON object, no other words: { "name": snake_case fn name, "title": a short title, "description": one sentence on what it returns and its params, "query": the query JSON, "sorters": output field names a caller may sort by, "args": { "<param>": the value the request gives for it } }.',
  ].join('\n');
}

/** `QueryAuthor` over the run's own model calls. */
export class LlmQueryAuthor implements QueryAuthor {
  readonly #retries: number;

  constructor(options: { retries: number }) {
    this.#retries = options.retries;
  }

  write(request: string, catalog: TableCatalog, rules: AuthorRules, llm: Llm): Promise<AuthoredQuery | { problems: string[] }> {
    return this.#loop(`Write a query for this request:\n\n${request}`, catalog, rules, llm);
  }

  edit(current: WrittenQuery, instructions: string, catalog: TableCatalog, rules: AuthorRules, llm: Llm): Promise<AuthoredQuery | { problems: string[] }> {
    return this.#loop(`Change this saved query as asked, keeping its name unless the change makes it wrong:\n\n${JSON.stringify(current)}\n\nThe change:\n${instructions}`, catalog, rules, llm);
  }

  async argsFor(request: string, signature: string, llm: Llm): Promise<Record<string, Json>> {
    if (/\(\s*\)$/.test(signature)) { return {}; }
    const answer = await llm.text({
      system: 'You fill in the args of a fn call from a request. Answer with only the JSON object of args; leave out an arg the request gives no value for (and limit, offset and sort unless asked).',
      prompt: `The fn: ${signature}\n\nThe request: ${request}`,
    });
    const read = readAnswer(answer, z.record(z.string(), Json));
    return 'problem' in read ? {} : read;
  }

  async #loop(task: string, catalog: TableCatalog, rules: AuthorRules, llm: Llm): Promise<AuthoredQuery | { problems: string[] }> {
    const system = queryGuide(catalog, rules);
    let prompt = task;
    let problems: string[] = [];
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const answer = await llm.text({ system, prompt });
      const written = readAnswer(answer, WrittenQuery);
      let report = '';
      if ('problem' in written) {
        problems = [written.problem];
      } else {
        const compiled = compileQuery(catalog.engine, written.query);
        if ('query' in compiled) {
          if (!compiled.writes || rules.writes) { return { written, compiled }; }
          problems = ['This database is read-only: write a select query.'];
        } else {
          problems = compiled.problems;
          report = compiled.report;
        }
      }
      prompt = `${task}\n\nYour last answer was refused:\n${answer}\n\nFix these problems:\n- ${problems.join('\n- ')}${report === '' ? '' : `\n\n${report}`}`;
    }
    return { problems };
  }
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
