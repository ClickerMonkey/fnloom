/**
 * Builds 6 and 7 on the real stack, API-level: installing a system from the chat's fs. The suite writes the small
 * `greet` system (`greet-system.ts`) into `systems/greet` and calls `fs/install_system`: an admin approves the card
 * and the system connects, but offers nothing until the admin goes live after review; then its fn runs, and what it
 * did not declare (an effect past its fn's mode, a hub call past its grants) is refused and logged. What it adds while
 * running (a fn, a type, a context entry) is stored and listed as added while running, with a version, and waits as a
 * pending review until approved; the context entry holds a hub model's answer made outside any run (`hubAi`). A code
 * change installs again with the change on the card and waits for approval too; a context folder with a broken link
 * fails the build; `ctx_load` brings what a context imports and the fns it brings; `fns_search` filters and pages.
 * The folder is removed after.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSettled, QualifiedName, SystemName, type Approval, type Json, type Run, type SessionId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { ROOT } from '../scripts/stack.ts';
import { greetFiles, type GreetOptions } from './greet-system.ts';
import { admin, clientInfo, invoke, settings, settle } from './kit.ts';
import { approvePending, goLive } from './review.ts';

const FOLDER = join(ROOT, 'systems', 'greet');
const TURN = settings.HARNESS_E2E_TURN_TIMEOUT;
const INSTALL = QualifiedName.parse('fs/install_system');
const GREET = SystemName.parse('greet');

let me: SignedIn;
let session: SessionId;

/** Write the system's files, replacing what an earlier step wrote. */
function write(options: GreetOptions): void {
  rmSync(FOLDER, { recursive: true, force: true });
  for (const [path, text] of Object.entries(greetFiles(options))) {
    mkdirSync(dirname(join(FOLDER, path)), { recursive: true });
    writeFileSync(join(FOLDER, path), text);
  }
}

/** Start a fn and wait until it settles or waits for approval. */
async function started(fn: QualifiedName, args: Json): Promise<Run> {
  const { run } = await me.hub.call('invoke', { session, fn, args, client: clientInfo() });
  return waitFor(`${fn} to settle or wait`, async () => {
    const got = await me.hub.call('run', { run });
    return isSettled(got.status) || got.status === 'awaiting-approval' ? got : undefined;
  }, { timeout: TURN, every: 500 });
}

/** Approve a waiting install and wait for it to settle; the approval (with its card) and the settled run. */
async function approved(run: Run): Promise<{ approval: Approval; run: Run }> {
  const [approval] = await me.hub.call('approvals', { runs: [run.id] });
  if (approval === undefined) throw new Error(`run ${run.id} has no approval`);
  await me.hub.call('approve', { approval: approval.id, approve: true, remember: 'once' });
  const settled = await waitFor(`run ${run.id} to settle`, async () => {
    const got = await me.hub.call('run', { run: run.id });
    return isSettled(got.status) ? got : undefined;
  }, { timeout: TURN, every: 500 });
  return { approval, run: settled };
}

/** The text of a card's parts. */
function cardText(approval: Approval): string {
  return (approval.preview?.parts ?? []).map((part) => ('text' in part ? part.text : '')).join('\n');
}

/** A list's rows for one system, as JSON objects. */
async function rowsOf(list: 'fns' | 'types' | 'contexts'): Promise<Array<Record<string, unknown>>> {
  const page = await me.hub.call('query', { list, query: { filters: [{ field: 'system', op: 'is', value: 'greet' }], limit: 20 } });
  return page.items.flatMap((row) => (typeof row === 'object' && row !== null && !Array.isArray(row) ? [row] : []));
}

beforeAll(async () => {
  me = await admin();
  await settle(me);
  session = (await me.hub.call('createSession', { title: 'e2e install' })).id;
});

afterAll(async () => {
  rmSync(FOLDER, { recursive: true, force: true });
  if ((await me.hub.call('systems')).some((s) => s.name === 'greet' && s.status === 'connected')) {
    await invoke(me, session, QualifiedName.parse('fs/stop_system'), { system: 'greet' }).catch(() => undefined);
  }
  me.close();
}, TURN);

describe('installing from the chat', () => {
  it('waits for an admin, connects, and its fn runs', async () => {
    write({ version: '0.1.0', word: 'Hello' });
    const waiting = await started(INSTALL, { path: 'systems/greet' });
    expect(waiting.status).toBe('awaiting-approval');
    const { approval, run } = await approved(waiting);
    expect(approval.preview?.subject).toMatchObject({ kind: 'system-install', system: 'greet', version: '0.1.0' });
    expect(run.status, JSON.stringify(run.outcome)).toBe('done');
    expect(run.outcome).toMatchObject({ status: 'done', result: { system: 'greet', status: 'connected' } });
    // installed, not live: nothing is offered until an admin reviews it and goes live
    expect((await me.hub.call('system', { system: GREET })).stage).toBe('installed');
    const search = await invoke(me, session, QualifiedName.parse('hub/fns_search'), { systems: ['greet'] });
    expect(JSON.stringify(search.outcome)).not.toContain('greet/hello');
    const early = await invoke(me, session, QualifiedName.parse('greet/hello'), { name: 'Ana' }).then((got) => got.status, () => 'refused');
    expect(early).not.toBe('done');
    const review = await goLive(me, GREET);
    expect(review.facts.map((fact) => fact.fn)).toContain('greet/hello');
    expect((await me.hub.call('system', { system: GREET })).stage).toBe('live');
    const hello = await invoke(me, session, QualifiedName.parse('greet/hello'), { name: 'Ana' });
    expect(hello.outcome).toMatchObject({ status: 'done', result: 'Hello, Ana!' });
  }, TURN * 2);

  it('refuses and logs an undeclared effect and an undeclared hub call', async () => {
    // peek is declared read and proposes its write fn; recall reads a resource without the resources grant
    const peek = await invoke(me, session, QualifiedName.parse('greet/peek'), {});
    const recall = await invoke(me, session, QualifiedName.parse('greet/recall'), {});
    expect([peek.status, recall.status]).toEqual(['failed', 'failed']);
    const refusals = await me.hub.call('refusals', { system: GREET });
    expect(refusals.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'mode', attempt: 'greet/wipe', fn: 'greet/peek' }),
      expect.objectContaining({ rule: 'capability', attempt: 'resource' }),
    ]));
    expect((await me.hub.call('systemReview', { system: GREET })).refusals.total).toBeGreaterThanOrEqual(2);
  }, TURN);

  it('stores what it added while running, each with a version', async () => {
    const added = await waitFor('greet/note', async () => ((await rowsOf('contexts')).some((row) => row['name'] === 'greet/note') ? true : undefined), { timeout: 60_000, every: 1_000 });
    expect(added).toBe(true);
    const fns = await rowsOf('fns');
    expect(fns.find((row) => row['name'] === 'greet/shout')).toMatchObject({ origin: 'runtime' });
    expect(fns.find((row) => row['name'] === 'greet/hello')).toMatchObject({ origin: 'contract' });
    const Added = z.object({ declaredBy: z.literal('runtime'), version: z.string().min(1) });
    expect(Added.safeParse((await rowsOf('types')).find((row) => row['name'] === 'greet/Greeting')).success).toBe(true);
    const note = (await rowsOf('contexts')).find((row) => row['name'] === 'greet/note');
    expect(Added.safeParse(note).success).toBe(true);
    // a hub model wrote it, outside any run
    const decl = note?.['decl'];
    const content = typeof decl === 'object' && decl !== null && 'content' in decl ? decl.content : undefined;
    expect(content).not.toBe('No model answered.');
    // what it added at runtime, outside the reviewed contract, waits for approval
    const pending = await approvePending(me, GREET);
    expect(pending.pending?.changes.map((change) => change.name)).toContain('greet/note');
    expect((await invoke(me, session, QualifiedName.parse('greet/shout'), { text: 'hi' })).outcome).toMatchObject({ status: 'done', result: 'HI' });
  }, TURN);

  it('installs a code change again, with the change on the card', async () => {
    write({ version: '0.2.0', word: 'Hi' });
    const { approval, run } = await approved(await started(INSTALL, { path: 'systems/greet' }));
    expect(approval.preview?.title).toContain('0.1.0 → 0.2.0');
    expect(cardText(approval)).toContain('Changes from the running version');
    expect(run.outcome).toMatchObject({ status: 'done', result: { version: '0.2.0' } });
    expect((await approvePending(me, GREET)).pending?.version).toBe('0.2.0');
    expect((await invoke(me, session, QualifiedName.parse('greet/hello'), { name: 'Bo' })).outcome).toMatchObject({ status: 'done', result: 'Hi, Bo!' });
  }, TURN * 2);

  it('refuses a context folder with a broken link before anyone is asked', async () => {
    write({ version: '0.3.0', word: 'Hey', context: '---\nkey: guide\ndescription: Greet guide.\nsummary: How to greet.\n---\nUse fn:greet/missing to greet.\n' });
    const run = await started(INSTALL, { path: 'systems/greet' });
    expect(run.status).toBe('invalid-input');
    expect(JSON.stringify(run.outcome)).toMatch(/context\/guide\.md:\d+:\d+ broken-link .*greet\/missing/);
  }, TURN);
});

describe('context and search', () => {
  it('ctx_load brings the context an item imports and the fns they bring', async () => {
    const run = await invoke(me, session, QualifiedName.parse('hub/ctx_load'), { context: ['fs/system-authoring'] });
    expect(run.outcome).toMatchObject({ status: 'done', result: { loaded: ['fs/system-authoring', 'fs/authoring'], refused: [] } });
    const { fns } = z.object({ fns: z.array(z.string()) }).parse(run.outcome?.status === 'done' ? run.outcome.result : undefined);
    expect(fns).toContain('fs/write');
    expect(fns).toContain('fs/install_system');
  }, TURN);

  it('fns_search finds fns only, filters by system and mode, and pages', async () => {
    const query = { systems: ['fs'], modes: ['read'], limit: 3 };
    const first = await invoke(me, session, QualifiedName.parse('hub/fns_search'), query);
    const second = await invoke(me, session, QualifiedName.parse('hub/fns_search'), { ...query, offset: 3 });
    const Page = z.object({ items: z.array(z.object({ name: z.string() })), next: z.number().optional() });
    const page = (run: Run) => Page.parse(run.outcome?.status === 'done' ? run.outcome.result : undefined);
    expect(page(first).next).toBe(3);
    const names = [...page(first).items, ...page(second).items].map((item) => item.name);
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6);
    expect(names.every((name) => name.startsWith('fs/'))).toBe(true);
  }, TURN);
});
