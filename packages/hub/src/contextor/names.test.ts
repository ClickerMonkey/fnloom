/**
 * The one fn name at the hub's three boundaries: prompt text and tools out, results out, calls in (plan
 * `injected-context-2026-11-22`, section 1).
 */
import { FN_NAME_DESCRIPTION, FnNameIndex, Json, modelFnName, mintId, QualifiedName } from '@harness/core';
import { fn, g, hub } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { openScope } from '../access/index.ts';
import { replyText } from '../execution/wire.ts';
import { contextorEnv } from './env.ts';
import type { ContextorDeps, FnView, Selection } from './index.ts';
import { LENIENT } from '@aeye/schema';
import { bindable, fnSignature } from '../catalog/signature.ts';
import { modeNames, modeTool, StaticChatMode, ToolsChatMode } from './modes.ts';
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
    // core decodes a call through the tool's schema, bound with the prompt's names: its fn-name fields come back qualified
    const tool = rendered.tools.find((t) => t.name === 'tools__examples_of');
    const decoded = tool?.schema.bind().render(LENIENT).parse({ fn: 'database__main__expenses_create', note: 'fs__x stays' });
    expect(decoded?.ok).toBe(true);
    const args = Json.parse(decoded?.ok === true ? decoded.value : null);
    expect(await mode.interpret({ type: 'tool', id: 'c3', name: 'tools__examples_of', args }, rendered, SCOPE))
      .toEqual({ type: 'run', fn: EXAMPLES, args: { fn: SAVED, note: 'fs__x stays' } });
    // the tool's JSON schema says what a fn-name field holds
    expect(JSON.stringify(tool?.spec.parameters)).toContain(FN_NAME_DESCRIPTION);
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

  it('in static mode, decode `run` with the args of a fn the prompt shows, and take any other fn\'s args as written', async () => {
    const { deps, registry, view, r } = await rig();
    const mode = new StaticChatMode({ type: 'static', protocol: 'native', placement: 'system-end', loadDetail: 'signature' }, deps);
    const names = modeNames('static', registry);
    const rendered = await mode.render(selected([await view(EXAMPLES)]), { estimator: await r.tokens.forModel('small'), protocol: 'native', names });
    expect(rendered.decoded?.has(EXAMPLES)).toBe(true);
    const run = rendered.tools.find((tool) => tool.name === 'run')?.schema.bind().render(LENIENT);
    // a shown fn's args are checked and read back by core: its fn-name field comes back qualified
    const shown = run?.parse({ fn: 'tools__examples_of', args: { fn: 'fs__Entry__reveal', note: 'n' } });
    expect(shown).toMatchObject({ ok: true, value: { fn: EXAMPLES, args: { fn: METHOD, note: 'n' } } });
    expect(run?.parse({ fn: 'tools__examples_of', args: { fn: 3 } }).ok).toBe(false);
    if (shown?.ok !== true) return;
    expect(await mode.interpret({ type: 'tool', id: 'c1', name: 'run', args: Json.parse(shown.value) }, rendered, SCOPE)).toEqual({ type: 'run', fn: EXAMPLES, args: { fn: METHOD, note: 'n' } });
    // another fn's args come as written (any JSON object), read back and checked by the hub
    expect(run?.parse({ fn: 'fs__Entry__reveal', args: { path: 'a' } })).toMatchObject({ ok: true, value: { fn: METHOD, args: { path: 'a' } } });
    // a fn that takes nothing may be run without args
    expect(run?.parse({ fn: 'fs__Entry__reveal' })).toMatchObject({ ok: true, value: { fn: METHOD } });
    // and checked by the hub with the fn's own check, in @aeye/schema's words
    expect(await mode.interpret({ type: 'tool', id: 'c2', name: 'run', args: { fn: METHOD } }, rendered, SCOPE)).toMatchObject({ type: 'invalid', fn: METHOD, invalid: { source: 'schema', problems: [{ path: 'path' }] } });
  });
});

describe('prompt text and tools out', () => {
  it('spells every fn the region, the tools and the tail name as the model calls it in each mode', async () => {
    const { registry } = await rig();
    const index = FnNameIndex.of([METHOD, hub.fns.fns_search.name, hub.fns.ctx_load.name]);
    const tools = modeNames('tools', { index, types: registry.types });
    const statics = modeNames('static', { index, types: registry.types });
    // the registry is asked once per prompt, before anything is spelled
    await tools.learn(['Find with hub/fns_search, then call fs/Entry.reveal.']);
    await statics.learn(['Find with hub/fns_search, load with hub/ctx_load, then fs/Entry.reveal.']);
    expect(tools.text('Find with hub/fns_search, then call fs/Entry.reveal.')).toBe('Find with hub__fns_search, then call fs__Entry__reveal.');
    expect(statics.text('Find with hub/fns_search, load with hub/ctx_load, then fs/Entry.reveal.')).toBe('Find with find, load with load, then fs__Entry__reveal.');
    const tool = modeTool('x', 'Use fs/Entry.reveal.', bindable(fnSignature(q('x/z'), g.obj({ a: g.field(g.text(), { docs: 'A name, like fs/Entry.reveal.' }) }), g.text()).argsFor()), { type: 'object', properties: { a: { type: 'string', description: 'A name, like fs/Entry.reveal.', pattern: 'fs/Entry.reveal' } } });
    const out = await spoken({ tools: [tool], systemEnd: '', tail: 'Then fs/Entry.reveal.', protocol: 'native', fns: new Map(), fleet: new Set(), names: tools });
    expect(out.tools[0]?.description).toBe('Use fs__Entry__reveal.');
    expect(out.tools[0]?.spec.description).toBe('Use fs__Entry__reveal.');
    expect(out.tail).toBe('Then fs__Entry__reveal.');
    // a field's own words in the tool's schema too, never its pattern
    expect(out.tools[0]?.spec.parameters).toMatchObject({ properties: { a: { description: 'A name, like fs__Entry__reveal.', pattern: 'fs/Entry.reveal' } } });
  });

  it('describes a fn-name field in a tool\'s schema only where its author said nothing', () => {
    const signature = fnSignature(q('x/y'), g.obj({ a: g.fnName(), b: g.field(g.fnName(), { docs: 'mine' }) }), g.text());
    // a fn-name field is the named type `FnName`, which carries the words; a field's own docs are kept on it
    expect(signature.argsJsonSchema).toMatchObject({ properties: { a: { $ref: '#/$defs/FnName' }, b: { description: 'mine' } }, $defs: { FnName: { type: 'string', description: FN_NAME_DESCRIPTION } } });
  });
});

describe('results out', () => {
  it('writes a result\'s fn-name fields as model names, and every text the result holds through text', async () => {
    const { registry, r } = await rig();
    const names = modeNames('tools', registry);
    const returns = (await r.catalog.fn(EXAMPLES))?.decl.returns;
    const result = { fn: SAVED, text: 'Call fs/Entry.reveal next.' };
    await names.learn([result, 'Done with fs/Entry.reveal.']);
    const reply = replyText(result, { rows: 5, watched: true }, (value) => names.value(value, returns));
    expect(JSON.parse(reply)).toEqual({ fn: 'database__main__expenses_create', text: 'Call fs__Entry__reveal next.' });
    // a plain text result is spelled by the reply's text pass
    expect(names.text(replyText('Done with fs/Entry.reveal.', { rows: 5, watched: true }))).toBe('Done with fs__Entry__reveal.');
  });
});
