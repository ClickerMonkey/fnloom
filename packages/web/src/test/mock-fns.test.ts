// @vitest-environment node
/**
 * Every fn the mock hub lets someone open loads in the fn modal: each fn its chats ran (run cards, the runs browser),
 * each fn node of its graph, its agents and invocations, is listed in its system's fns (where the admin fn store
 * finds it), and its facts and numbers answer.
 */
import { ChatCapabilities, FnRecord, QualifiedName, Run, Tokens, splitName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MOCK_ADMIN, mockHub } from '../../e2e/mockHub.ts';
import { SAMPLE_NODES } from '../graph/test/graph.ts';

const { app } = mockHub({ needsAdmin: false });
const RunsPage = z.object({ items: z.array(Run), cursor: z.string().optional() });

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) };
  return app.fetch(new Request(`http://hub/${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
}

async function signIn(): Promise<string> {
  return Tokens.parse(await (await post('signIn', { email: MOCK_ADMIN.email, password: MOCK_ADMIN.password })).json()).access;
}

/** Every fn the mock's pages can open the fn modal on. */
async function openable(token: string): Promise<string[]> {
  const runs: Run[] = [];
  for (let cursor: string | undefined, pages = 0; pages === 0 || (cursor !== undefined && pages < 20); pages++) {
    const page = RunsPage.parse(await (await post('runs', { query: { limit: 200, ...(cursor === undefined ? {} : { cursor }) } }, token)).json());
    runs.push(...page.items);
    cursor = page.cursor;
  }
  const caps = ChatCapabilities.parse(await (await post('capabilities', {}, token)).json());
  return [...new Set([
    ...runs.map((run) => run.fn),
    ...SAMPLE_NODES.filter((node) => node.kind === 'fn').map((node) => node.name),
    ...caps.agents.map((agent) => agent.fn),
    ...caps.invocations.map((invocation) => invocation.fn),
  ])].sort();
}

describe('the mock hub fns', () => {
  it('lists every fn its pages open in its system, so the fn modal loads each', async () => {
    const token = await signIn();
    const fns = await openable(token);
    expect(fns).toEqual(expect.arrayContaining(['database/shop.sample', 'fs/bash', 'claude/permit', 'hub/records_table']));
    const missing: string[] = [];
    for (const fn of fns) {
      const listed = await post('systemFns', { system: splitName(QualifiedName.parse(fn)).system }, token);
      const records = listed.ok ? z.array(FnRecord).parse(await listed.json()) : [];
      if (!records.some((record) => record.name === fn)) { missing.push(`${fn} (systemFns ${String(listed.status)})`); }
      for (const [path, body] of [['fnFacts', { fn }], ['fnMetrics', { fn, days: 7 }], ['fnMetricsDays', { fn, days: 7 }], ['runs', { query: { filters: [{ field: 'fn', op: 'is', value: fn }], limit: 8 } }]] as const) {
        const answer = await post(path, body, token);
        if (!answer.ok) { missing.push(`${fn} (${path} ${String(answer.status)})`); }
      }
    }
    expect(missing).toEqual([]);
  });

  it('answers a system it does not know with no fns, as the real hub does', async () => {
    const answer = await post('systemFns', { system: 'nowhere' }, await signIn());
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual([]);
  });
});
