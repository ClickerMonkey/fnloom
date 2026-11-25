/**
 * The agent tools' args: `@aeye/core` decodes a call through the tool's `@aeye/schema` args into the code shape before
 * the tool records it, so the hub gets args as code takes them: an optional a strict model wrote as `null` left out
 * (found by the 2026-11-21 scenario run: every `hub/fns_search` call from GPT-6 Luna was refused), a fn-name field read
 * back to the fn's qualified name, and args that don't fit told to the model in `@aeye/schema`'s words.
 */
import { planRequest, PromptSuspend, type Context } from '@aeye/core';
import { g } from '@harness/sdk';
import { modelFnNames, QualifiedName, RULE_ONLY_NAMES } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { bindable, fnSignature } from '../catalog/signature.ts';
import { modeTool } from '../contextor/modes.ts';
import { agentTool, PendingCalls } from './tools.ts';
import type { HubCallContext, HubCallMetadata } from './scope.ts';

const args = g.obj({ text: g.text(), limit: g.optional(g.num()), fn: g.optional(g.fnName()) });
const signature = fnSignature(QualifiedName.parse('shop/find'), args, g.text());
const names = modelFnNames({ index: RULE_ONLY_NAMES, mode: { type: 'tools' } });
const ctx: Context<HubCallContext, HubCallMetadata> = {};

/** The agent tool of `shop/find`, bound for a prompt in tools mode. */
function tool(calls = new PendingCalls()) {
  return agentTool(modeTool('shop__find', 'Find things.', bindable(signature.argsFor(names)), signature.argsJsonSchema), calls);
}

describe('agent tools', () => {
  it('get their args in the code shape: fn names qualified, as a strict model wrote them with null for what it left out', async () => {
    const made = tool();
    const plan = planRequest({ tools: [await made.definition(ctx)] }, { id: 'gpt-x', provider: 'openai', capabilities: ['chat', 'tools', 'toolsStrict'] });
    const decoded = await made.parse(ctx, JSON.stringify({ text: 'weather', limit: null, fn: 'fs__read' }), plan);
    expect(decoded).toEqual({ text: 'weather', fn: 'fs/read' });
  });

  it('record a call and suspend: it runs as a queued run', () => {
    const calls = new PendingCalls();
    expect(() => tool(calls).run({ text: 'weather' }, { ...ctx, toolCallId: 'call_1' })).toThrow(PromptSuspend);
    expect(calls.inOrder(['call_1'])).toEqual([{ toolCallId: 'call_1', name: 'shop__find', args: { text: 'weather' } }]);
  });

  it('tell args that don\'t fit in @aeye/schema\'s words, one line a problem', async () => {
    const made = tool();
    await expect(made.parse(ctx, JSON.stringify({ text: 3, extra: true }))).rejects.toThrow(/text/);
  });
});
