/**
 * The one fn name at the hub's three boundaries: prompt text and tools out, results out, calls in (plan
 * `injected-context-2026-11-22`, section 1).
 */
import { FN_NAME_DESCRIPTION, FnNameIndex, modelFnName, mintId, QualifiedName, type Json } from '@harness/core';
import { fn, g, hub } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { openScope } from '../access/index.ts';
import { replyText } from '../execution/wire.ts';
import { contextorEnv } from './env.ts';
import type { ContextorDeps, FnView, Selection } from './index.ts';
import { modeNames, modeTool, StaticChatMode, ToolsChatMode, withFnNameDocs } from './modes.ts';
import { z } from 'zod';
import { spoken } from './planner.ts';
import { contextorRig } from './testing.ts';

const q = (name: string) => QualifiedName.parse(name);
const METHOD = q('fs/Entry.reveal');
const SAVED = q('database/main.expenses_create');
const LONG = q('database/household_budget.monthly_grocery_spending_by_store_and_category_since_2024');
const EXAMPLES = q('tools/examples_of');
const SCOPE = { session: undefined, access: openScope(mintId('actor')) };

/** A rig with a method, a saved fn, a long fn, and a fn whose args name a fn (`g.fnName()`). */
async function rig() {
  const r = await contextorRig();
  r.catalog.addFn(METHOD);
  r.catalog.addFn(SAVED);
  r.catalog.addFn(LONG);
  r.catalog.addFn(EXAMPLES, fn({ description: 'Examples of a fn.', args: g.obj({ fn: g.fnName(), note: g.text() }), returns: g.obj({ fn: g.fnName(), text: g.text() }) }));
  const deps: ContextorDeps = {
    catalog: r.catalog, dynamic: r.dynamic, search: r.search, views: r.views, graph: r.graph, instances: { connected: () => [] }, settings: contextorEnv.parse(), log: r.log,
    clock: () => r.time.now, access: (actor) => Promise.resolve(openScope(actor)),
  };
  const registry = await r.catalog.modelNames();
  const view = async (name: QualifiedName): Promise<FnView> => { const found = await r.views.view(name); if (found === undefined) throw new Error(`no view ${name}`); return found; };
  return { r, deps, registry, view };
}

/** A selection of these fns at signature. */
function selected(views: readonly FnView[]): Selection {
  const pool = { asked: 0, got: 0 };
  return {
    context: [], fns: views.map((view) => ({ view, detail: 'signature', activation: 1 })), linear: [], earlier: [],
    report: {
      contextor: 'plain', mode: 'tools', context: [], fns: [], linear: 0, earlier: [],
      budget: { window: 0, output: 0, reasoning: 0, margin: 0, fixed: 0, pools: { history: pool, context: pool, fns: pool }, estimate: 0, cut: [] },
    },
  };
}

describe('calls in', () => {
  it('in tools mode, name each tool by its model name and run the fn a call of it names, its fn-name args read back', async () => {
    const { deps, registry, view, r } = await rig();
    const mode = new ToolsChatMode(deps);
    const names = modeNames('tools', registry);
    const rendered = await mode.render(selected([await view(METHOD), await view(LONG), await view(EXAMPLES)]), { estimator: await r.tokens.forModel('small'), protocol: 'native', names });
    expect(rendered.tools.map((tool) => tool.name)).toEqual(['fs__Entry__reveal', modelFnName(LONG), 'tools__examples_of']);
    expect(await mode.interpret({ type: 'tool', id: 'c1', name: 'fs__Entry__reveal', args: { path: 'a' } }, rendered, SCOPE)).toEqual({ type: 'run', fn: METHOD, args: { path: 'a' } });
    expect(await mode.interpret({ type: 'tool', id: 'c2', name: modelFnName(LONG), args: { path: 'a' } }, rendered, SCOPE)).toMatchObject({ type: 'run', fn: LONG });
    expect(await mode.interpret({ type: 'tool', id: 'c3', name: 'tools__examples_of', args: { fn: 'database__main__expenses_create', note: 'fs__x stays' } }, rendered, SCOPE))
      .toEqual({ type: 'run', fn: EXAMPLES, args: { fn: SAVED, note: 'fs__x stays' } });
    // the tool's JSON schema says what a fn-name field holds
    const tool = rendered.tools.find((t) => t.name === 'tools__examples_of');
    expect(tool?.spec.parameters).toMatchObject({ properties: { fn: { description: FN_NAME_DESCRIPTION } } });
  });

  it('in static mode, run the fn `run` names by its model name (a cut one through the registry), a qualified one tolerated', async () => {
    const { deps, registry, r } = await rig();
    const mode = new StaticChatMode({ type: 'static', protocol: 'native', placement: 'system-end', loadDetail: 'signature' }, deps);
    const names = modeNames('static', registry);
    const rendered = await mode.render(selected([]), { estimator: await r.tokens.forModel('small'), protocol: 'native', names });
    const run = (args: Json) => mode.interpret({ type: 'tool', id: 'c1', name: 'run', args }, rendered, SCOPE);
    expect(await run({ fn: 'database__main__expenses_create', args: { path: 'a' } })).toEqual({ type: 'run', fn: SAVED, args: { path: 'a' } });
    expect(await run({ fn: modelFnName(LONG), args: { path: 'a' } })).toEqual({ type: 'run', fn: LONG, args: { path: 'a' } });
    expect(await run({ fn: 'fs/Entry.reveal', args: { path: 'a' } })).toEqual({ type: 'run', fn: METHOD, args: { path: 'a' } });
    expect(await run({ fn: 'tools__examples_of', args: { fn: 'fs__Entry__reveal', note: 'n' } })).toEqual({ type: 'run', fn: EXAMPLES, args: { fn: METHOD, note: 'n' } });
    // the text protocol's blocks too
    expect(await mode.interpret({ type: 'block', id: 'b1', fn: 'fs__Entry__reveal', json: '{"path":"a"}' }, rendered, SCOPE)).toEqual({ type: 'run', fn: METHOD, args: { path: 'a' } });
    // static tools are their hub fns
    expect(await mode.interpret({ type: 'tool', id: 'c2', name: 'find', args: { text: 'x' } }, rendered, SCOPE)).toMatchObject({ type: 'run', fn: hub.fns.fns_search.name });
  });
});

describe('prompt text and tools out', () => {
  it('spells every fn the region, the tools and the tail name as the model calls it in each mode', async () => {
    const { registry } = await rig();
    const index = FnNameIndex.of([METHOD, hub.fns.fns_search.name, hub.fns.ctx_load.name]);
    const tools = modeNames('tools', { index, types: registry.types });
    const statics = modeNames('static', { index, types: registry.types });
    expect(tools.text('Find with hub/fns_search, then call fs/Entry.reveal.')).toBe('Find with hub__fns_search, then call fs__Entry__reveal.');
    expect(statics.text('Find with hub/fns_search, load with hub/ctx_load, then fs/Entry.reveal.')).toBe('Find with find, load with load, then fs__Entry__reveal.');
    const tool = modeTool('x', 'Use fs/Entry.reveal.', z.object({}), {});
    const out = spoken({ tools: [tool], systemEnd: '', tail: 'Then fs/Entry.reveal.', protocol: 'native', fns: new Map(), fleet: new Set(), names: tools });
    expect(out.tools[0]?.description).toBe('Use fs__Entry__reveal.');
    expect(out.tools[0]?.spec.description).toBe('Use fs__Entry__reveal.');
    expect(out.tail).toBe('Then fs__Entry__reveal.');
  });

  it('describes a fn-name field in a JSON schema only where its author said nothing', () => {
    const pattern = { type: 'string', pattern: '^[a-z]\\S*$' };
    expect(withFnNameDocs({ properties: { a: pattern, b: { ...pattern, description: 'mine' } } })).toEqual({ properties: { a: { ...pattern, description: FN_NAME_DESCRIPTION }, b: { ...pattern, description: 'mine' } } });
  });
});

describe('results out', () => {
  it('writes a result\'s fn-name fields as model names, and every text the result holds through text', async () => {
    const { registry, r } = await rig();
    const names = modeNames('tools', registry);
    const returns = (await r.catalog.fn(EXAMPLES))?.decl.returns;
    const result = { fn: SAVED, text: 'Call fs/Entry.reveal next.' };
    const reply = replyText(result, { rows: 5, watched: true }, (value) => names.value(value, returns));
    expect(JSON.parse(reply)).toEqual({ fn: 'database__main__expenses_create', text: 'Call fs__Entry__reveal next.' });
    // a plain text result is spelled by the reply's text pass
    expect(names.text(replyText('Done with fs/Entry.reveal.', { rows: 5, watched: true }))).toBe('Done with fs__Entry__reveal.');
  });
});
