/**
 * What the model reads when a fn returns rows. The rows go to the person (an attachment with a `ResultTable`, drawn
 * as a table or another visual); the model gets a result block: what the person sees and that it need not repeat
 * it, the columns, how many rows there are, whether there are more and the exact call for the next page, the sort,
 * the first rows up to a token budget, and the fn to call again. Zod first; `ResultBlockType` is its gin form for a
 * fn's `returns`. `resultBlock` (in `@harness/sdk/server`) builds one from a `ResultTable`.
 */
import { Json, ResultColumn, ResultSort } from '@harness/core';
import { z } from 'zod';
import { ginAs } from './zod-gin.ts';

/** A result column as the model reads it. */
export const ResultColumnInfo = ResultColumn.pick({ name: true, kind: true, nullable: true });
export type ResultColumnInfo = z.infer<typeof ResultColumnInfo>;

/** A fn and how to call it again. */
export const ResultFn = z.object({
  name: z.string().describe('The fn\'s qualified name (`database/main.overdue_invoices`).'),
  signature: z.string().describe('Its args in one line, to call it again.'),
});
export type ResultFn = z.infer<typeof ResultFn>;

/** How to read the next rows. */
export const NextPage = z.object({
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  call: z.string().describe('The exact call that reads the next page.'),
});
export type NextPage = z.infer<typeof NextPage>;

/** The result block: everything the model needs to talk about rows the person is shown. */
export const ResultBlock = z.object({
  shown: z.string().describe('What the person sees, and what to do about it.'),
  columns: z.array(ResultColumnInfo),
  rowCount: z.number().int().min(0).describe('The rows in this page.'),
  total: z.number().int().min(0).optional().describe('Every matching row, when counted.'),
  truncated: z.boolean().describe('More rows exist past this page.'),
  nextPage: NextPage.optional(),
  sort: z.array(ResultSort),
  sample: z.array(z.record(z.string(), Json)).describe('The first rows, as objects, up to a budget.'),
  sampleNote: z.string().optional().describe('When the sample is shorter than the page, or cells were cut: how much of it is here.'),
  fn: ResultFn,
});
export type ResultBlock = z.infer<typeof ResultBlock>;

/** The result block as a gin type, for a fn's `returns`. */
export const ResultBlockType = ginAs(ResultBlock);
