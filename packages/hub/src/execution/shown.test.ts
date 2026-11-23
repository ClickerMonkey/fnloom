/**
 * The agent loop and shown resources: a done `hub/resource_send` call adds a `<shown>` reference after the call's
 * replies, and every call's conversation goes through the media service for the model it is sent to (`chat/shown.ts`),
 * as the run's person. The kept transcript holds only the reference.
 */
import { agent, fn, g, hub } from '@harness/sdk';
import type { LlmMessage } from '@harness/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { Asking } from '../resources/index.ts';
import { AGENT_KIND } from './index.ts';
import { ALICE, AGENT, calls, executionRig, says, SESSION, type ExecutionRig } from './testing.ts';

const looker = agent({ description: 'Looks at things.', args: g.obj({}), returns: g.text(), instructions: 'Look when asked.', tools: [hub.fns.resource_send], maxIterations: 4 });

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

describe('an agent shown a resource', () => {
  it('keeps a <shown> reference after the call and sends each call the conversation as its model takes it', async () => {
    const expanded: Array<{ model: string; who: Asking; shown: number }> = [];
    rig = await executionRig({
      media: {
        expand: (messages: readonly LlmMessage[], model: string, who: Asking) => {
          const isShown = (m: LlmMessage): boolean => typeof m.content === 'string' && m.content.startsWith('<shown ');
          expanded.push({ model, who, shown: messages.filter(isShown).length });
          return Promise.resolve(messages.map((m) => (isShown(m) ? { ...m, content: [{ type: 'text' as const, content: m.content as string }, { type: 'text' as const, content: '<image id="file://main/chart.png">BLOCK</image>' }] } : m)));
        },
      },
    });
    const r = rig;
    r.catalog.add('hub', 'resource_send', fn({ description: 'Show a resource.', args: hub.fns.resource_send.args, returns: hub.fns.resource_send.returns, tags: ['read'] }));
    r.catalog.add('tools', 'looker', looker);
    r.module.hubFns.register(hub.fns.resource_send, () => Promise.resolve({ parts: [{ type: 'text', chars: 40, name: 'chart.png' }] }));
    await r.module.start();
    await r.session({ agent: 'tools/looker' });
    const turn = await r.turn({ session: SESSION, text: 'What does chart.png show?' });
    r.provider.script(calls([['hub__resource_send', { uri: 'file://main/chart.png' }]]), says('A rising line.'));

    const { run } = await r.module.agents.start({
      kind: AGENT_KIND, fn: 'tools/looker', args: {}, turn: turn.id, key: 'answer', actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [], session: SESSION,
    });
    expect(await r.module.runs.wait(run)).toEqual({ status: 'done', result: 'A rising line.' });

    const transcript = (await r.store.table('sessions').get(SESSION))?.transcript ?? [];
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    // kept as the reference only: no block, no bytes
    expect(transcript[3]?.content).toBe('<shown uri="file://main/chart.png">The resource you asked to see with hub/resource_send.</shown>');
    // both calls went through media, for the model they were sent to, as the person, charged to the run
    expect(expanded.map((e) => e.shown)).toEqual([0, 1]);
    expect(expanded[1]).toMatchObject({ model: 'test-model', who: { actor: ALICE, run, session: SESSION } });
    // the model read the expanded message, after the tool's reply
    expect(JSON.stringify(r.provider.requests[1]?.messages)).toContain('BLOCK');
    expect(JSON.stringify(r.provider.requests[0]?.messages)).not.toContain('BLOCK');
  });
});
