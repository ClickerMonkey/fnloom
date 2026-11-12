/** The enricher asks for structured output of `EnrichmentAnswer` and keeps only the table's own columns. */
import type { GinType, Llm } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { ENRICH_GUIDE, LlmEnricher } from './author.ts';
import { ScannedTable } from './schema.ts';

const table = ScannedTable.parse({
  spec: { name: 'orders', columns: [{ name: 'id', type: { kind: 'integer' }, nullable: false }, { name: 'status', type: { kind: 'text' }, nullable: false }], primaryKey: ['id'], foreignKeys: [], unique: [] },
  rows: 3,
});

/** A model whose structured answer is `answer`, remembering what it was asked. */
function answering(answer: unknown): { llm: Llm; asked: Array<{ system?: string; prompt: string; output: GinType }> } {
  const asked: Array<{ system?: string; prompt: string; output: GinType }> = [];
  const unused = () => Promise.reject(new Error('unused'));
  const llm: Llm = {
    text: unused,
    object: <T>(input: { prompt: string; output: GinType<T>; system?: string }): Promise<T> => {
      asked.push(input);
      return Promise.resolve(input.output.parse(answer).toLogical());
    },
    stream: () => { throw new Error('unused'); },
    embed: () => Promise.resolve([]),
    image: unused,
    transcribe: unused,
    speak: unused,
  };
  return { llm, asked };
}

describe('LlmEnricher', () => {
  it('asks for the answer as structured output and keys it by column, dropping columns the table does not have', async () => {
    const { llm, asked } = answering({
      description: 'An order in the shop.',
      columns: [{ column: 'status', values: ['open', 'paid'] }, { column: 'colour', description: 'Made up.' }],
    });
    const enriched = await new LlmEnricher().enrich(table, { columns: ['id', 'status'], rows: [[1, 'open'], [2, 'paid']] }, { status: ['open', 'paid'] }, llm, undefined);
    expect(enriched).toEqual({ description: 'An order in the shop.', columns: { status: { values: ['open', 'paid'] } } });
    expect(asked[0]?.system).toBe(ENRICH_GUIDE);
    expect(asked[0]?.prompt).toContain('Every distinct value of these columns:\n- status: "open", "paid"');
  });

  it('throws an answer that does not fit, so the instance enriches the table in a later run', async () => {
    const { llm } = answering({ columns: [] });
    await expect(new LlmEnricher().enrich(table, { columns: [], rows: [] }, {}, llm, undefined)).rejects.toThrow();
  });
});
