/**
 * Live: the static toolset with the graph contextor on a free OpenRouter model with native tools, so the mode is not
 * Ollama-specific. The model is asked something only a fn can answer; it runs the fn by name through `run`, and the
 * run is of that fn, not a wrapper. A rate-limited or unavailable model is skipped with a note. Run with
 * `npm run test:live`.
 */
import { openScope } from '../access/index.ts';
import { agent, fn, g, hub } from '@harness/sdk';
import { liveModels } from '@harness/sdk/server/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { modelEnv } from '../boot/env.ts';
import { openRouterProviders } from '../execution/providers.ts';
import { AGENT, ALICE, executionRig, SESSION, testSettings, type ExecutionRig } from '../execution/testing.ts';
import { replyText } from '../execution/wire.ts';
import { createContextor } from './create.ts';
import { contextorEnv } from './env.ts';
import { registerContextorFns } from './fns.ts';
import { FixedSearch, sessionLoader } from './testing.ts';
import { CatalogFnViews } from './views.ts';

const SECRET = 'amber-otter-17';
const small = agent({
  description: 'Answers with the static toolset.', args: g.obj({}), returns: g.text(), tools: [], maxIterations: 5,
  instructions: 'You can learn what is in a vault only by running vault/open. Answer with just the secret word.',
  mode: { type: 'static' }, contextor: { type: 'graph' },
});

let rig: ExecutionRig | undefined;
afterEach(async () => { await rig?.module.stop(); rig = undefined; });

describe('the static toolset on a free OpenRouter model (live)', () => {
  const key = modelEnv.get('OPENROUTER_API_KEY');
  it.skipIf(key === undefined)('runs the fn the model names through run', { timeout: 600_000 }, async () => {
    const tried: string[] = [];
    for (const model of liveModels()) {
      const search = new FixedSearch();
      search.hits = [{ kind: 'fn', key: 'vault/open', rank: 1, similarity: 1, text: 'Open the vault.' }];
      const r = await executionRig({ settings: testSettings({ HARNESS_TURN_COST: 0.05 }, {}, model), llm: { providers: openRouterProviders(key) }, search });
      rig = r;
      r.catalog.add('vault', 'open', fn({ description: 'Open the vault and read the secret word inside it.', args: g.obj({ vault: g.text() }), returns: g.text(), tags: ['read'] }));
      r.catalog.add('tools', 'small', small);
      for (const name of ['fns_search', 'inspect', 'load', 'unload'] as const) r.catalog.add('hub', name, hub.defs.fns[name]);
      const contextor = createContextor({
        store: r.store, catalog: r.catalog, search, settings: contextorEnv.parse(), modelSettings: { HARNESS_DEFAULT_MODEL: model }, models: () => r.module.llm.models(),
        log: r.log, clock: () => r.time.now, probes: () => undefined,
      });
      registerContextorFns(r.module.hubFns, {
        store: () => r.store, catalog: () => r.catalog, search: () => search, sessions: () => sessionLoader(r.store), contextor: () => contextor, views: () => new CatalogFnViews(r.catalog), mcpScope: () => Promise.resolve(undefined), access: (actor) => Promise.resolve(openScope(actor)),
      });
      const opened: string[] = [];
      r.connect('vault').behaviour.run = (request) => { opened.push(JSON.stringify(request.args)); return Promise.resolve({ status: 'done', result: `The secret word is ${SECRET}.` }); };
      await r.module.start();
      await r.session({ agent: 'tools/small' });
      const turn = await r.turn({ session: SESSION, text: 'What is the secret word in the blue vault?' });
      const { run } = await r.module.agents.start({
        kind: 'hub/llm', fn: 'tools/small', args: {}, turn: turn.id, session: SESSION, key: 'answer', actor: ALICE, caller: AGENT, priority: 'interactive', background: false, handlers: [],
      });
      const settled = await r.module.runs.wait(run);
      if (settled.status === 'failed' && /429|rate|unavailable|provider|endpoint/i.test(settled.error.message)) {
        tried.push(`${model}: ${settled.error.message}`);
        await r.module.stop();
        rig = undefined;
        continue;
      }
      expect(settled, settled.status === 'failed' ? settled.error.message : '').toMatchObject({ status: 'done' });
      expect(opened.length).toBeGreaterThanOrEqual(1);
      expect(settled.status === 'done' ? replyText(settled.result, { rows: 5, watched: true }) : '').toContain(SECRET);
      const children = (await r.store.table('runs').find({ where: { parent: run }, limit: 10 })).items;
      expect(children.map((c) => c.fn)).toContain('vault/open');
      const [first] = (await r.store.table('llmInteractions').find({ where: { run }, limit: 10 })).items;
      expect(first?.request.tools?.map((t) => t.name)).toEqual(['find', 'find_ctx', 'inspect', 'load', 'unload', 'run']);
      console.info('live.static.answered', { model, children: children.map((c) => c.fn) });
      return;
    }
    console.warn('live.static.unavailable', { tried });
  });
});
