/**
 * Build 9 on the system side, against the in-memory hub: a proposal outside a run that waits for a named person, shows
 * in a chat and asks a question (approved with an answer, or declined, and heard through the `run` event), and how an
 * instance says people connect to it (sent again on every reconnect).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mintId, proposalKeyFor, type ApprovalPreview, type RunId, type SystemEvent } from '@harness/core';
import type { SystemCtx } from '../ctx.ts';
import { fn } from '../fn.ts';
import { g } from '../gin.ts';
import { system } from '../system.ts';
import { testHub, type TestSystem } from '../testing/hub.ts';
import { TEST_USER } from './testing.ts';

const PREVIEW: ApprovalPreview = { title: 'Claude asks which branch to use', parts: [], irreversible: false };
const CHAT = mintId('session');

const asker = system('asker', { description: 'Asks its owner questions, for tests.' }).with({
  fns: {
    answer: fn({ description: 'Hand an answer back.', args: g.obj({ question: g.text(), reply: g.optional(g.text()) }), returns: g.text() }),
  },
});

type Contract = typeof asker extends { defs: infer C } ? C : never;

let kit: TestSystem<'asker', Contract> | undefined;
afterEach(async () => {
  await kit?.stop();
  kit = undefined;
});

/** Serve the asker; resolves with its system context once started, and the run events it heard. */
async function start(): Promise<{ ctx: SystemCtx; heard: Array<Extract<SystemEvent, { type: 'run' }>> }> {
  let ctx: SystemCtx | undefined;
  let said = false;
  const heard: Array<Extract<SystemEvent, { type: 'run' }>> = [];
  kit = await testHub(asker, {
    fns: { answer: { async run(args, run) { return run.done(`${args.question}: ${args.reply ?? 'no reply'}`); } } },
    lifecycle: {
      async started(started) {
        ctx = started;
        // said once: the host says it again on every reconnect
        if (said) { return; }
        said = true;
        await started.instanceConnect({ title: 'Sign in to Linear', flow: { flow: 'oauth' } });
      },
    },
    events: { run(event) { heard.push(event); return Promise.resolve(); } },
  });
  if (ctx === undefined) { throw new Error('the asker never started'); }
  return { ctx, heard };
}

/** A run of the asker the test user started, for a `for` proposal's key to name (the hub checks they own it). */
async function ownedRun(): Promise<RunId> {
  const hub = kit?.hub;
  if (hub === undefined) { throw new Error('not started'); }
  const id = mintId('run');
  await hub.run('asker/answer', { question: 'Start' }, { run: hub.runInfo('asker/answer', { id }) });
  return id;
}

describe('proposals that wait for a person and ask a question', () => {
  it('sends for, chat and ask, and runs the approved fn with the answer at args[into]', async () => {
    const { ctx, heard } = await start();
    const key = proposalKeyFor(await ownedRun(), 'request-1');
    const proposed = await ctx.propose('answer', { question: 'Which branch?' }, {
      preview: PREVIEW, key, for: TEST_USER.id, chat: CHAT, ask: { type: { name: 'text' }, into: 'reply' },
    });
    const hub = kit?.hub;
    expect(hub?.proposals).toEqual([expect.objectContaining({ fn: 'answer', approver: 'person', for: TEST_USER.id, chat: CHAT, ask: { type: { name: 'text' }, into: 'reply' } })]);
    await expect(hub?.approveProposal(proposed.approval)).rejects.toThrow(/approve it with an answer/);
    await expect(hub?.approveProposal(proposed.approval, { answer: 7 })).rejects.toThrow(/doesn't fit reply/);
    const outcome = await kit?.approve(key, 'main');
    expect(outcome).toMatchObject({ status: 'done', result: 'Which branch?: main' });
    expect(heard).toEqual([expect.objectContaining({ run: proposed.run, fn: 'asker/answer', update: { type: 'status', status: 'done' } })]);
    await expect(hub?.approveProposal(proposed.approval, { answer: 'again' })).rejects.toThrow(/settled already/);
  });

  it('is heard cancelled with the reason when declined, and the same key then proposes afresh', async () => {
    const { ctx, heard } = await start();
    const key = proposalKeyFor(await ownedRun(), 'request-2');
    const first = await ctx.propose('answer', { question: 'Delete it?' }, { preview: PREVIEW, key, for: TEST_USER.id });
    await kit?.decline(first.run, 'not today');
    const update = heard[0]?.update;
    expect(update?.type === 'status' ? update.text?.one : undefined).toBe('Declined by Tess Tester: not today');
    expect(update).toMatchObject({ type: 'status', status: 'cancelled' });
    const second = await ctx.propose('answer', { question: 'Delete it?' }, { preview: PREVIEW, key, for: TEST_USER.id });
    expect(second.run).not.toBe(first.run);
  });

  it('refuses a person approver outside a run without for', async () => {
    const { ctx } = await start();
    await expect(ctx.propose('answer', { question: 'x' }, { preview: PREVIEW, approver: 'person' })).rejects.toThrow(/name them in 'for'/);
  });

  it('refuses for without a key, and a key that names nothing the person owns', async () => {
    const { ctx } = await start();
    await expect(ctx.propose('answer', { question: 'x' }, { preview: PREVIEW, for: TEST_USER.id })).rejects.toThrow(/needs a 'key'/);
    await expect(ctx.propose('answer', { question: 'x' }, { preview: PREVIEW, key: 'request-3', for: TEST_USER.id })).rejects.toThrow(/session or run of theirs/);
    const strangers = proposalKeyFor(mintId('run'), 'request-3');
    await expect(ctx.propose('answer', { question: 'x' }, { preview: PREVIEW, key: strangers, for: TEST_USER.id })).rejects.toThrow(/session or run of theirs/);
  });
});

describe('how people connect to an instance', () => {
  it('is sent at start and again after a reconnect', async () => {
    await start();
    const hub = kit?.hub;
    expect(hub?.instanceConnect).toEqual({ title: 'Sign in to Linear', flow: { flow: 'oauth' }, share: false });
    hub?.drop(5);
    await hub?.whenConnected();
    await expect.poll(() => hub?.instanceConnects.length).toBe(2);
    await kit?.running.instanceConnect({ title: 'Sign in to Linear' });
    expect(hub?.instanceConnect).toEqual({ title: 'Sign in to Linear', share: false });
  });
});
