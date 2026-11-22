/**
 * `get_query` and `edit_query` on the query authoring agent, over the real link runtime and SQLite, with the model
 * scripted through the fake hub: the tools open stage by stage (find, then the loads, then draft), a failed check is
 * fixed, the clean draft is saved and run, a saved query is reused with this request's args, an edit keeps the name
 * and makes version 2, and with nobody watching an unclear database is answered headless.
 */
import type { Json, LlmForward, LlmForwardChunk, OutcomeWire } from '@harness/core';
import { streamOf } from '@harness/sdk/server/testing';
import { replyChunks, toolCall as callTool } from '@harness/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { QueryAgentAnswer } from '../shared/shapes.ts';
import { serveDatabase, shopFile, type ServedDatabase } from './fixture.ts';
import { askNext } from './impl.ts';

/** The tools a forward offered, sorted. */
const offered = (forward: LlmForward | undefined): string[] => (forward?.request.tools ?? []).map((tool) => tool.name).sort();

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

const ref = (source: string, field: string) => ({ kind: 'field-ref', source, field });

/** "Orders with a status, biggest first, with the customer": the draft the scripted model writes. */
const DRAFT = {
  name: 'orders_by_status', title: 'Orders by status', description: 'Orders with a given status and their customer, biggest first.', sorters: ['total'],
  query: {
    kind: 'select',
    fields: [{ expr: ref('orders', 'id'), as: 'id' }, { expr: ref('orders', 'total'), as: 'total' }, { expr: ref('customers', 'name'), as: 'customer' }],
    from: { kind: 'type', type: 'orders' },
    joins: [{ on: { kind: 'relation', source: 'orders', field: 'customer', as: 'customers' }, joinType: 'inner' }],
    where: [{ kind: 'comparison', op: '=', left: ref('orders', 'status'), right: { kind: 'param', name: 'status' } }],
    order: [{ expr: ref('orders', 'total'), dir: 'desc' }],
  },
  args: { status: 'paid' },
};

describe('the query authoring fns', () => {
  let served: ServedDatabase | undefined;

  afterEach(async () => {
    await served?.stop();
    served = undefined;
  });

  /** Serve the shop with the model answering from a script (then plain text). */
  async function start(script: LlmForwardChunk[][]): Promise<ServedDatabase> {
    served = await serveDatabase({ dir: shopFile().dir });
    served.hub.onLlm = () => streamOf(script.shift() ?? replyChunks('Done.'));
    return served;
  }

  it('finds nothing, loads the tables, fixes a failed draft, saves it and runs it', async () => {
    const { hub } = await start([
      callTool('find_queries', { text: 'orders by status' }),
      callTool('load_tables', { names: ['orders', 'customers'] }),
      callTool('draft', { draft: { ...DRAFT, args: {} } }),
      callTool('draft', { draft: DRAFT }),
      callTool('save', {}),
    ]);
    const answer = QueryAgentAnswer.parse(done(await hub.run('database/get_query', { detailedDescription: 'Paid orders, biggest first, with the customer.' })));
    if ('ask' in answer) { throw new Error('expected a query'); }
    expect(answer.fn).toMatchObject({ name: 'database/main.orders_by_status', version: 1, how: 'created', call: 'database/main.orders_by_status({"status":"paid"})' });
    expect(answer.result).toMatchObject({ rowCount: 2, sample: [{ id: 1, total: 120.5, customer: 'Ada' }, { id: 3, total: 15, customer: 'Bo' }] });
    expect(hub.fns.kept.get('database/main.orders_by_status')?.saved).toMatchObject({ kind: 'database/query', examples: [{ args: { status: 'paid' } }] });
    // the forced workflow: find first, then the loads, then draft; save only after a clean draft
    expect(offered(hub.forwards[0])).toEqual(['find_queries']);
    expect(offered(hub.forwards[1])).toEqual(['find_queries', 'load_tables', 'use_saved']);
    // every table is loaded now, so load_tables is withdrawn and the syntax is offered
    expect(offered(hub.forwards[2])).toEqual(['draft', 'find_queries', 'query_syntax', 'use_saved']);
    expect(offered(hub.forwards[3])).not.toContain('save');
    expect(offered(hub.forwards[4])).toContain('save');
    // the missing param was a problem the model fixed; the clean draft showed its first rows
    expect(JSON.stringify(hub.forwards[3]?.request.messages)).toContain('status');
    expect(JSON.stringify(hub.forwards[4]?.request.messages)).toContain('Preview');
  });

  it('reuses a saved query with this request\'s args, and edits it into version 2', async () => {
    const { hub } = await start([
      callTool('find_queries', { text: 'orders by status' }), callTool('load_tables', { names: ['orders', 'customers'] }), callTool('draft', { draft: DRAFT }), callTool('save', {}), replyChunks('Saved.'),
      callTool('find_queries', { text: 'open orders' }), callTool('use_saved', { fn: 'database/main.orders_by_status', args: { status: 'open' } }), replyChunks('Reused.'),
      callTool('find_queries', { text: 'orders by status' }), callTool('load_query', { fn: 'database/main.orders_by_status' }),
      callTool('draft', { draft: { ...DRAFT, name: 'renamed' } }),
      callTool('draft', { draft: { ...DRAFT, description: 'Orders with a given status, newest first.', query: { ...DRAFT.query, order: [{ expr: ref('orders', 'placed'), dir: 'desc' }] } } }),
      callTool('save', {}),
    ]);
    done(await hub.run('database/get_query', { detailedDescription: 'Paid orders, biggest first.' }));
    const reused = QueryAgentAnswer.parse(done(await hub.run('database/get_query', { detailedDescription: 'Open orders, biggest first.' })));
    expect(reused).toMatchObject({ fn: { how: 'reused', version: 1 }, query: { params: { status: 'open' } }, result: { rowCount: 2 } });
    expect(hub.fns.kept.get('database/main.orders_by_status')?.version).toBe(1);

    const edited = QueryAgentAnswer.parse(done(await hub.run('database/edit_query', { name: 'database/main.orders_by_status', instructions: 'Newest first instead.' })));
    expect(edited).toMatchObject({ fn: { name: 'database/main.orders_by_status', how: 'edited', version: 2 }, result: { sample: [{ id: 1 }, { id: 3 }] } });
    expect(hub.fns.kept.get('database/main.orders_by_status')?.history).toHaveLength(1);
    expect(JSON.stringify(hub.forwards.at(-2)?.request.messages)).toContain('Keep the name');
  });

  it('says what to do when the database is unclear: ask with input/ask_choice, or headless, say so', () => {
    const ask = { ask: 'Which database: Shop or Billing?', databases: ['main', 'billing'] };
    expect(askNext(ask, ['Shop', 'Billing'], true)).toContain('input/ask_choice');
    expect(askNext(ask, ['Shop', 'Billing'], undefined)).toContain("not the chat's own");
  });
});
