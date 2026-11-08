/** Dynamic context: asked of its system as the person, kept a while, and shown whole when a message commands it. */
import { agent, g } from '@harness/sdk';
import { IDS, mintId, QualifiedName, type SystemName, type ContextRecord, type Session, type Turn, type UserInfo } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { ALICE, ALICE_INFO, OPEN_LIMITS } from '../execution/testing.ts';
import { memoryLog } from '../testing.ts';
import { LinkDynamicContext, type DynamicContextDeps } from './dynamic.ts';
import { contextorEnv } from './env.ts';
import { contextorRig, contextRecord } from './testing.ts';

const SESSION = mintId('session', () => 'dyn');
const GUIDE = QualifiedName.parse('fs/system-authoring');

/** One call the fake system answered. */
interface Asked {
  readonly system: SystemName;
  readonly name: string;
  readonly args: Readonly<Record<string, string>>;
  readonly user: UserInfo;
  readonly session: string | undefined;
}

/** A dynamic context service over a fake system that writes `text(name, args)`, or fails while `failing` is set. */
function rig(options: { connected?: boolean } = {}) {
  const asked: Asked[] = [];
  const looked: string[] = [];
  const time = { now: 1_000 };
  const state = { failing: false, connected: options.connected ?? true };
  const { log, records } = memoryLog();
  const settings = contextorEnv.parse();
  const deps: DynamicContextDeps = {
    write: (system, body) => {
      if (!state.connected) return undefined;
      asked.push({ system, name: body.name, args: body.args, user: body.user, session: body.session });
      if (state.failing) return Promise.reject(new Error('system busy'));
      return Promise.resolve({ text: `${body.name} for ${body.user.name} ${JSON.stringify(body.args)}` });
    },
    person: (actor) => { looked.push(actor); return Promise.resolve(ALICE_INFO); },
    settings, log, clock: () => time.now,
  };
  return { dynamic: new LinkDynamicContext(deps), asked, looked, time, state, records, settings };
}

const dynamicGuide = (): ContextRecord => contextRecord(GUIDE, { description: 'How to write a system.', command: { name: 'new-system', args: [] } });

describe('dynamic context', () => {
  it('leaves context that declares its content alone, and asks nothing', async () => {
    const r = rig();
    const record = contextRecord(QualifiedName.parse('fs/notes'), { content: 'Fixed text.' });
    await expect(r.dynamic.resolve(record, { session: SESSION, actor: ALICE, user: ALICE_INFO })).resolves.toBe(record);
    expect(r.asked).toEqual([]);
  });

  it('asks the owning system as the person with the command\'s args, and keeps the text', async () => {
    const r = rig();
    const resolved = await r.dynamic.resolve(dynamicGuide(), { session: SESSION, actor: ALICE, user: ALICE_INFO, args: { name: 'notes' } });
    expect(resolved.decl.content).toBe('system-authoring for Alice {"name":"notes"}');
    expect(r.asked).toEqual([{ system: 'fs', name: 'system-authoring', args: { name: 'notes' }, user: ALICE_INFO, session: SESSION }]);
    // a later load without args reuses the command's, from what was kept
    const again = await r.dynamic.resolve(dynamicGuide(), { session: SESSION, actor: ALICE });
    expect(again.decl.content).toBe(resolved.decl.content);
    expect(r.asked).toHaveLength(1);
    expect(r.looked).toEqual([]);
  });

  it('asks again with other args, after the kept text expires, and per session', async () => {
    const r = rig();
    await r.dynamic.resolve(dynamicGuide(), { session: SESSION, actor: ALICE, user: ALICE_INFO, args: { name: 'a' } });
    await r.dynamic.resolve(dynamicGuide(), { session: SESSION, actor: ALICE, user: ALICE_INFO, args: { name: 'b' } });
    r.time.now += r.settings.HARNESS_DYNAMIC_CONTEXT_TTL;
    await r.dynamic.resolve(dynamicGuide(), { session: SESSION, actor: ALICE, user: ALICE_INFO });
    await r.dynamic.resolve(dynamicGuide(), { session: mintId('session', () => 'other'), actor: ALICE, user: ALICE_INFO });
    expect(r.asked.map((a) => [a.args, a.session])).toEqual([[{ name: 'a' }, SESSION], [{ name: 'b' }, SESSION], [{ name: 'b' }, SESSION], [{}, 'ses_other']]);
  });

  it('looks the person up when the ask does not carry them (a web read, a preview)', async () => {
    const r = rig();
    const resolved = await r.dynamic.resolve(dynamicGuide(), { session: undefined, actor: ALICE });
    expect(resolved.decl.content).toContain('for Alice');
    expect(r.looked).toEqual([ALICE]);
    expect(r.asked[0]?.session).toBeUndefined();
  });

  it('keeps the last text when the system fails, and the summary when it never answered', async () => {
    const r = rig();
    const first = await r.dynamic.resolve(dynamicGuide(), { session: SESSION, actor: ALICE, user: ALICE_INFO });
    r.time.now += r.settings.HARNESS_DYNAMIC_CONTEXT_TTL;
    r.state.failing = true;
    expect((await r.dynamic.resolve(dynamicGuide(), { session: SESSION, actor: ALICE, user: ALICE_INFO })).decl.content).toBe(first.decl.content);
    const fresh = rig();
    fresh.state.failing = true;
    expect((await fresh.dynamic.resolve(dynamicGuide(), { session: SESSION, actor: ALICE, user: ALICE_INFO })).decl.content).toBeUndefined();
    expect(fresh.records.map((record) => record.msg)).toContain('context.dynamic.failed');
  });

  it('leaves the record alone when its system is not connected', async () => {
    const r = rig({ connected: false });
    expect((await r.dynamic.resolve(dynamicGuide(), { session: SESSION, actor: ALICE, user: ALICE_INFO })).decl.content).toBeUndefined();
    expect(r.asked).toEqual([]);
    expect(r.records.map((record) => record.msg)).toContain('context.dynamic.unavailable');
  });
});

describe('dynamic context in a prompt', () => {
  const chat = agent({ description: 'Chat.', args: g.obj({}), returns: g.text(), instructions: 'Be brief.', tools: [] });
  const graph = agent({ description: 'Small.', args: g.obj({}), returns: g.text(), instructions: 'Be brief.', tools: [], mode: { type: 'static' }, contextor: { type: 'graph' } });

  /** A planner whose session commands the guide in the current message (or only loaded it earlier). */
  async function planning(fn: typeof chat, commanded: boolean) {
    const sys = rig();
    const r = await contextorRig({ dynamic: sys.dynamic, models: [{ id: 'small', provider: 'openrouter', name: 'small', contextWindow: 16_384, capabilities: ['chat', 'tools'] }] });
    const agentRecord = r.catalog.addFn('hub/chat', fn);
    r.catalog.addContext(dynamicGuide());
    const session: Session = await r.store.table('sessions').insert({
      id: SESSION, title: 'T', owner: ALICE, agent: 'hub/chat', participants: [], systems: 'all', tools: [], context: [GUIDE], status: 'idle', transcript: [],
      createdAt: 0, updatedAt: 0, archived: false,
    });
    const message = IDS.message.parse('msg_dyn');
    await r.store.table('messages').insert({
      id: message, session: SESSION, turn: IDS.turn.parse('trn_dyn'), author: ALICE, role: 'user', runs: [], status: 'done', replyAll: false, answerers: [], createdAt: 0,
      parts: commanded ? [{ type: 'command', context: GUIDE, args: { name: 'notes' } }, { type: 'text', text: 'make me a notes system' }] : [{ type: 'text', text: 'make me a notes system' }],
    });
    const turn: Turn = {
      id: IDS.turn.parse('trn_dyn'), actor: ALICE, user: ALICE_INFO, time: { now: 0, timeZone: 'UTC', local: '' }, status: 'running', limits: OPEN_LIMITS, cost: 0,
      errors: 'feed-back', createdAt: 0, session: SESSION, message,
    };
    const planned = await r.planner.plan({ session, turn, agent: agentRecord, model: 'small', instructions: 'Be brief.', transcript: [{ role: 'user', content: '/new-system notes\nmake me a notes system' }] });
    return { planned, sys };
  }

  it('puts the text the system wrote for a commanded item in the plain contextor\'s prompt', async () => {
    const { planned, sys } = await planning(chat, true);
    expect(planned.context).toContain('system-authoring for Alice {"name":"notes"}');
    expect(planned.report.context).toEqual([{ name: GUIDE, detail: 'full', activation: 1 }]);
    expect(sys.asked).toEqual([{ system: 'fs', name: 'system-authoring', args: { name: 'notes' }, user: ALICE_INFO, session: SESSION }]);
  });

  it('shows a loaded dynamic item whole in the graph contextor', async () => {
    const { planned, sys } = await planning(graph, false);
    expect(planned.context).toContain('system-authoring for Alice {}');
    expect(planned.report.context.find((c) => c.name === GUIDE)?.detail).toBe('full');
    expect(sys.asked).toHaveLength(1);
  });
});
