/**
 * Build 7 on the real stack, API-level, with the projects/owners sample (the `work` database): a table's generated
 * fns are listed by group and made idempotently, then run; `get_query` with the free model writes and saves a query
 * fn over the sample; `get_input` draws a form; and the graph endpoint answers a system's nodes and edges, its
 * references into other systems greyed, and narrows them by filters; and `harness test` runs a system's own tests on
 * the SDK test kit. (Installed-then-live and refusals are in `install.e2e.test.ts`.)
 */
import { fileURLToPath } from 'node:url';
import { nodeIo, runCli } from '@harness/cli';
import { QualifiedName, SystemName, SystemTestReport, type Json, type SessionId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SignedIn } from '../scripts/hub-client.ts';
import { TableFnsGenerated, TableFnsList } from '../systems/database/shared/shapes.ts';
import { admin, invoke, settings, settle } from './kit.ts';

const TURN = settings.HARNESS_E2E_TURN_TIMEOUT;
/** An authoring agent on the free model takes several slow turns. */
const AUTHORING = TURN * 2;
const AVAILABLE = QualifiedName.parse('database/table_fns_available');
const GENERATE = QualifiedName.parse('database/table_fns_generate');

let me: SignedIn;
let session: SessionId;

/** A run's result, failing the test when it didn't finish. */
async function result(fn: QualifiedName, args: Json, timeout?: number): Promise<Json> {
  const run = await invoke(me, session, fn, args, timeout);
  if (run.outcome?.status !== 'done') { throw new Error(`${fn} ended ${run.status}: ${JSON.stringify(run.outcome)}`); }
  return run.outcome.result;
}

beforeAll(async () => {
  me = await admin();
  await settle(me);
  session = (await me.hub.call('createSession', { title: 'e2e build 7' })).id;
});

afterAll(() => { me.close(); });

describe('generated table fns', () => {
  it('lists CRUD and relation-derived fns for projects and owners, and makes them idempotently', async () => {
    const projects = TableFnsList.parse(await result(AVAILABLE, { table: 'projects', database: 'work' }));
    const names = projects.groups.flatMap((group) => group.fns.map((fn) => fn.name));
    expect(names).toEqual(expect.arrayContaining(['create', 'update', 'remove', 'selectPage']));
    expect(projects.groups[0]?.group).toBe('crud');
    const owners = TableFnsList.parse(await result(AVAILABLE, { table: 'owners', database: 'work' }));
    expect(owners.groups.flatMap((group) => group.fns.map((fn) => fn.name))).toContain('projectCount');

    const first = TableFnsGenerated.parse(await result(GENERATE, { table: 'projects', database: 'work', names: ['selectPage', 'create'] }));
    expect(first.fns.map((fn) => fn.status)).toEqual(['created', 'created']);
    const again = TableFnsGenerated.parse(await result(GENERATE, { table: 'projects', database: 'work', names: ['selectPage', 'create'] }));
    expect(again.fns.map((fn) => fn.status)).toEqual(['unchanged', 'unchanged']);
    const listed = TableFnsList.parse(await result(AVAILABLE, { table: 'projects', database: 'work' }));
    expect(listed.groups.flatMap((group) => group.fns).find((fn) => fn.name === 'selectPage')).toMatchObject({ state: 'current', version: 1 });

    const page = await result(QualifiedName.parse('database/work.projects_selectPage'), {});
    expect(page).toMatchObject({ total: 3 });
  }, TURN);
});

describe('authoring with the free model', () => {
  it('get_query writes and saves a query fn over the projects sample', async () => {
    const answer = await result(QualifiedName.parse('database/get_query'), {
      detailedDescription: 'In the Projects database: every owner with how many projects they have and the total value of those projects, most valuable first. No filters.',
    }, AUTHORING);
    expect(answer).toMatchObject({ database: { instance: 'work' }, fn: { how: 'created' } });
    expect(JSON.stringify(answer)).toMatch(/database\/work\./);
  }, AUTHORING + 10_000);

  it('get_input draws a form for what is described', async () => {
    const answer = await result(QualifiedName.parse('input/get_input'), {
      detailedDescription: 'A new project: its code (short text, required), its name (text, required), its owner (one of Ada or Bo), its value (a number from 0 to 100000) and its start date.',
    }, AUTHORING);
    expect(JSON.stringify(answer)).toMatch(/owner/i);
  }, AUTHORING + 10_000);
});

describe('harness test', () => {
  it('runs a system folder’s tests on the SDK test kit and reports them as JSON', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const lines: string[] = [];
    const io = nodeIo(root, {});
    const code = await runCli(['test', 'systems/template', '--json'], { ...io, out: { line: (text) => { lines.push(text); }, warn: () => undefined } });
    const report = SystemTestReport.parse(JSON.parse(lines.at(-1) ?? 'null'));
    expect({ code, system: report.system, failed: report.failed }).toEqual({ code: 0, system: 'template', failed: 0 });
    expect(report.passed).toBeGreaterThan(0);
  }, TURN);
});

describe('the graph', () => {
  it('answers a system’s nodes and edges, greys what it references elsewhere, and filters', async () => {
    const database = SystemName.parse('database');
    const page = await me.hub.call('graph', { systems: [database] });
    expect(page.nodes.some((node) => node.id === 'fn:database/get_query' && !node.external)).toBe(true);
    expect(page.nodes.filter((node) => node.external).every((node) => node.system !== database)).toBe(true);
    expect(page.edges.length).toBeGreaterThan(0);
    const ids = new Set(page.nodes.map((node) => node.id));
    expect(page.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true);

    const fnsOnly = await me.hub.call('graph', { systems: [database], nodeKinds: ['fn'], external: false });
    expect(fnsOnly.nodes.length).toBeGreaterThan(0);
    expect(fnsOnly.nodes.every((node) => node.kind === 'fn' && !node.external)).toBe(true);
    const focused = await me.hub.call('graph', { focus: { node: 'fn:database/get_query', hops: 1 } });
    expect(focused.nodes.some((node) => node.id === 'fn:database/get_query')).toBe(true);
  });
});
