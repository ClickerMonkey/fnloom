/**
 * The module's own wiring: what `start` subscribes (settled runs to fn numbers and to the agent's report-back, a
 * system's reconnection to sending its runs again) and drops on `stop`, the chat delegates it is built with, and the
 * boot factory around it.
 */
import { fn, g } from '@harness/sdk';
import { ActorId, MessageId, QualifiedName, RunId, SessionId, SystemName, TurnId, type ChatMessage } from '@harness/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fake, fakeServices, rig as apiRig } from '../api/testing/rig.ts';
import type { ModuleContext } from '../boot/index.ts';
import { HUB_SYSTEM } from '../catalog/availability.ts';
import { chatPorts, executionModule, type ExecutionModule } from './create.ts';
import { ALICE, executionRig, settle, until, type ExecutionRig } from './testing.ts';

const read = fn({ description: 'Read a file.', args: g.obj({ path: g.text() }), returns: g.text(), tags: ['read'] });

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

async function started(): Promise<ExecutionRig> {
  const r = await executionRig();
  rig = r;
  await r.store.table('fns').put(r.catalog.add('fs', 'read', read));
  await r.module.start();
  return r;
}

describe('starting the execution module', () => {
  it('sends a system its queued runs when it connects, and counts each settled run in its fn’s numbers', async () => {
    const r = await started();
    const resend = vi.spyOn(r.module.runs, 'resend');
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start({
      fn: 'fs/read', args: { path: 'a' }, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
    });
    await until(async () => (await r.module.runs.get(run))?.status === 'queued' && r.records.some((rec) => rec.msg === 'run.system-gone'), 'the run to wait');
    const fs = r.connect('fs');
    // a status other than connected sends nothing
    r.bus.publish('system.status', { system: fs.name, status: 'disconnected' });
    await settle(10);
    expect(resend).not.toHaveBeenCalled();
    r.bus.publish('system.status', { system: fs.name, status: 'connected' });
    expect(await settled).toMatchObject({ status: 'done' });
    expect(resend).toHaveBeenCalledWith(fs.name);
    await until(() => r.bus.of('fn.stats').length === 1, 'the run to be counted');
    expect((await r.store.table('fns').get('fs/read'))?.stats).toMatchObject({ outcomes: { done: 1, failed: 0 } });
  });

  it('hands every settled run to the agent loop to report back, and logs a report that fails', async () => {
    const r = await started();
    r.connect('fs');
    const reportBack = vi.spyOn(r.module.agents, 'reportBack').mockRejectedValueOnce(new Error('transcript gone'));
    const turn = await r.turn();
    const { run, settled } = await r.module.runs.start({
      fn: 'fs/read', args: { path: 'b' }, turn: turn.id, key: 'k', actor: ALICE, caller: ALICE, priority: 'interactive', background: false, handlers: [],
    });
    const outcome = await settled;
    await until(() => reportBack.mock.calls.length === 1, 'the report-back');
    expect(reportBack.mock.calls[0]?.[0]).toMatchObject({ id: run });
    expect(reportBack.mock.calls[0]?.[1]).toEqual(outcome);
    await until(() => r.records.some((rec) => rec.msg === 'agent.report-back-failed'), 'the failure to be logged');
  });

  it('sends the hub’s own unsettled runs again on start, and drops its subscriptions on stop', async () => {
    const r = await executionRig();
    rig = r;
    const resend = vi.spyOn(r.module.runs, 'resend');
    await r.module.start();
    expect(resend).toHaveBeenCalledWith(HUB_SYSTEM);
    await r.module.stop();
    resend.mockClear();
    r.bus.publish('system.status', { system: SystemName.parse('fs'), status: 'connected' });
    await settle(10);
    expect(resend).not.toHaveBeenCalled();
    expect(r.records.map((rec) => rec.msg)).toEqual(expect.arrayContaining(['execution.started', 'execution.stopped']));
    rig = undefined;
  });
});

describe('chatPorts', () => {
  it('hands each call to the chat service method of the same name, looking chat up on every call', async () => {
    const calls: Array<readonly [string, readonly unknown[]]> = [];
    const message: ChatMessage = {
      id: MessageId.parse('msg_1'), session: SessionId.parse('ses_1'), turn: TurnId.parse('trn_1'), author: ActorId.parse('act_a'), role: 'assistant', parts: [], runs: [],
      status: 'done', replyAll: false, answerers: [], createdAt: 1,
    };
    const turn = TurnId.parse('trn_1');
    const agent = ActorId.parse('act_agent');
    const hub = {
      chat: fakeServices({
        chat: {
          sessions: { active: (...args) => { calls.push(['sessions.active', args]); return Promise.resolve(true); } },
          turns: {
            begin: (...args) => { calls.push(['turns.begin', args]); return Promise.resolve(message); },
            stream: (...args) => { calls.push(['turns.stream', args]); },
            finish: (...args) => { calls.push(['turns.finish', args]); return Promise.resolve(message); },
            settle: (...args) => { calls.push(['turns.settle', args]); return Promise.resolve(); },
            track: (...args) => { calls.push(['turns.track', args]); return Promise.resolve(); },
            suggested: (...args) => { calls.push(['turns.suggested', args]); return Promise.resolve(); },
            followUp: (...args) => { calls.push(['turns.followUp', args]); return Promise.resolve(turn); },
          },
          enrich: { render: (...args) => { calls.push(['enrich.render', args]); return 'rendered'; } },
          approvers: { approvers: (...args) => { calls.push(['approvers.approvers', args]); return Promise.resolve([agent]); } },
        },
      }).chat,
    };
    const ports = chatPorts(hub);
    const runs = [{ run: RunId.parse('run_1'), fn: QualifiedName.parse('fs/read') }];
    await expect(ports.presence.active(message.session)).resolves.toBe(true);
    await expect(ports.turns.begin({ turn, author: agent })).resolves.toBe(message);
    ports.turns.stream(message.id, { text: 'hi' });
    await expect(ports.turns.finish(message.id, [], 'failed')).resolves.toBe(message);
    await ports.turns.settle(turn, 'done');
    await ports.turns.track(message.id, runs);
    await expect(ports.turns.followUp({ turn, agent })).resolves.toBe(turn);
    expect(ports.enrich.render(message)).toBe('rendered');
    await expect(ports.approvers.approvers({ by: 'turn-user' }, agent)).resolves.toEqual([agent]);
    expect(calls).toEqual([
      ['sessions.active', [message.session]],
      ['turns.begin', [{ turn, author: agent }]],
      ['turns.stream', [message.id, { text: 'hi' }]],
      ['turns.finish', [message.id, [], 'failed']],
      ['turns.settle', [turn, 'done']],
      ['turns.track', [message.id, runs]],
      ['turns.followUp', [{ turn, agent }]],
      ['enrich.render', [message]],
      ['approvers.approvers', [{ by: 'turn-user' }, agent]],
    ]);
  });
});

describe('executionModule', () => {
  it('builds the module over the hub, lets other modules add hub fns, serves the link endpoints and starts and stops with work', async () => {
    const r = await apiRig();
    const given: ExecutionModule[] = [];
    const context: ModuleContext = { hub: r.hub, hubActor: ActorId.parse('act_hub'), peers: fake('peers'), systemTokens: fake('systemTokens') };
    const build = executionModule({ llm: () => ({ providers: {}, models: [] }), hubFns: (module) => { given.push(module); } })(context);
    expect(given).toEqual([build.services]);
    expect(build.linkPlugins).toHaveLength(1);
    await build.hooks?.work?.up?.();
    expect(r.records.map((rec) => rec.msg)).toContain('execution.started');
    await build.hooks?.work?.pre?.();
    expect(r.records.map((rec) => rec.msg)).toContain('execution.stopped');
  });
});
