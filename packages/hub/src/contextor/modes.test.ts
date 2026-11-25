import { LENIENT, profileFor, type ModelLike } from '@aeye/schema';
import { fn, g } from '@harness/sdk';
import { InstanceName, Json, JsonObject, mintId, QualifiedName, SystemName } from '@harness/core';
import { openScope } from '../access/index.ts';
import { describe, expect, it } from 'vitest';
import { contextorEnv } from './env.ts';
import type { ContextorDeps, FnView, RenderedIteration, Selection } from './index.ts';
import { fleetArgs, fnModeTool, machinesOf, modeNames, ownArgs, runTool, StaticChatMode, ToolsChatMode } from './modes.ts';
import { contextorRig } from './testing.ts';

const READ = QualifiedName.parse('fs/read');
const LAPTOP = InstanceName.parse('laptop');
const DESK = InstanceName.parse('desk');

/** A catalog with fs/read, its view, and instances where fs has the given machines connected. */
async function rig(machines: readonly InstanceName[]) {
  const r = await contextorRig();
  r.catalog.addFn(READ);
  const view = await r.views.view(READ);
  if (view === undefined) throw new Error('no view');
  const asked: SystemName[] = [];
  const instances: ContextorDeps['instances'] = { connected: (system) => { asked.push(system); return system === SystemName.parse('fs') ? machines : []; } };
  const deps: ContextorDeps = { catalog: r.catalog, dynamic: r.dynamic, search: r.search, views: r.views, graph: r.graph, instances, settings: contextorEnv.parse(), log: r.log, clock: () => r.time.now, access: (actor) => Promise.resolve(openScope(actor)) };
  return { view, instances, asked, deps };
}

/** A selection of one fn at signature. */
function selected(view: FnView): Selection {
  const pool = { asked: 0, got: 0 };
  return {
    context: [], fns: [{ view, detail: 'signature', activation: 1 }], linear: [], earlier: [],
    report: {
      contextor: 'plain', mode: 'tools', context: [], fns: [], linear: 0, earlier: [],
      budget: { window: 0, output: 0, reasoning: 0, margin: 0, fixed: 0, pools: { history: pool, context: pool, fns: pool }, estimate: 0, cut: [] },
    },
  };
}

describe('fleet choices in the chat modes', () => {
  it('give a fn an `on` choice only when its system has several machines connected', async () => {
    const one = await rig([LAPTOP]);
    expect(machinesOf(one.view, one.instances)).toEqual([]);
    expect(one.asked).toEqual(['fs']);
    const two = await rig([LAPTOP, DESK]);
    expect(machinesOf(two.view, two.instances)).toEqual([LAPTOP, DESK]);
    const plain = fnModeTool(two.view);
    const fleet = fnModeTool(two.view, [LAPTOP, DESK]);
    expect(plain?.spec.parameters).not.toHaveProperty(['properties', 'on']);
    expect(fleet?.spec.parameters).toMatchObject({ properties: { path: { type: 'string' }, on: { type: 'string', enum: ['laptop', 'desk'] } } });
    // the model may leave it out; when given it must be one of them
    expect(fleet?.schema.bind().render(LENIENT).parse({ path: 'a' }).ok).toBe(true);
    expect(fleet?.schema.bind().render(LENIENT).parse({ path: 'a', on: 'attic' }).ok).toBe(false);
  });

  it('take `on` out of the args before the fn sees them, and refuse an `on` that is no instance name', () => {
    expect(fleetArgs({ path: 'a', on: 'laptop' })).toEqual({ args: { path: 'a' }, on: LAPTOP });
    expect(fleetArgs({ path: 'a' })).toEqual({ args: { path: 'a' } });
    expect(fleetArgs('text')).toEqual({ args: 'text' });
    expect(fleetArgs({ path: 'a', on: 3 })).toEqual({ problem: { path: 'on', message: 'on must name one of the machines the tool lists' } });
  });

  it('in tools mode, plan a run on the machine the model named, and keep a fn of its own `on` arg as it is', async () => {
    const two = await rig([LAPTOP, DESK]);
    const mode = new ToolsChatMode(two.deps);
    const rendered = await mode.render(selected(two.view));
    expect([...rendered.fleet]).toEqual(['fs__read']);
    const scope = { session: undefined, access: openScope(mintId('actor')) };
    const call = (args: Json) => mode.interpret({ type: 'tool', id: 'c1', name: 'fs__read', args }, rendered, scope);
    expect(await call({ path: 'a', on: 'desk' })).toEqual({ type: 'run', fn: READ, args: { path: 'a' }, on: DESK });
    expect(await call({ path: 'a' })).toEqual({ type: 'run', fn: READ, args: { path: 'a' } });
    expect(await call({ path: 'a', on: 7 })).toMatchObject({ type: 'invalid', fn: READ, invalid: { source: 'validation' }, args: { path: 'a', on: 7 } });
    const solo: RenderedIteration = { ...rendered, fleet: new Set() };
    expect(await mode.interpret({ type: 'tool', id: 'c2', name: 'fs__read', args: { path: 'a', on: 'desk' } }, solo, scope)).toEqual({ type: 'run', fn: READ, args: { path: 'a', on: 'desk' } });
  });

  it('in tools mode, answer a call of a held fn not in the tools with what blocks it, not "no tool" (regression: "You there?")', async () => {
    const r = await contextorRig();
    r.catalog.addFn(READ);
    const held = { unavailable: 'held' as const, detail: 'database/create_table changed and waits for an admin to approve it' };
    r.catalog.addFn(QualifiedName.parse('database/create_table'), undefined, { available: held });
    const deps: Pick<ContextorDeps, 'instances' | 'views'> = { views: r.views, instances: { connected: () => [] } };
    const mode = new ToolsChatMode(deps);
    const view = await r.views.view(READ);
    if (view === undefined) throw new Error('no view');
    const rendered = await mode.render(selected(view));
    const scope = { session: undefined, access: openScope(mintId('actor')) };
    const said = (name: string) => mode.interpret({ type: 'tool', id: 'c1', name, args: {} }, rendered, scope);
    const reply = "database/create_table can't be used now: database/create_table changed and waits for an admin to approve it. Don't call it again; tell the person what blocks it.";
    // by its tool name, and by the qualified name weak models send
    expect(await said('database__create_table')).toMatchObject({ type: 'invalid', fn: 'database/create_table', reply });
    expect(await said('database/create_table')).toMatchObject({ type: 'invalid', fn: 'database/create_table', reply });
    // the refusal keeps the hub's block, so the run it is kept as tells the chat what holds it
    expect(await said('database__create_table')).toMatchObject({ invalid: { blocked: { code: 'held', reason: held.detail, system: 'database' } } });
    // a usable fn that just isn't loaded, and a name that is no fn, stay "no tool"
    expect(await said('fs__write')).toMatchObject({ type: 'invalid', reply: 'There is no tool named fs__write.' });
    expect(await said('nonsense')).toMatchObject({ type: 'invalid', reply: 'There is no tool named nonsense.' });
  });

  it('in static mode, pass run’s `on` to the run of the fn it names', async () => {
    const two = await rig([LAPTOP, DESK]);
    const mode = new StaticChatMode({ type: 'static', protocol: 'native', placement: 'system-end', loadDetail: 'signature' }, two.deps);
    const rendered: RenderedIteration = { tools: [], systemEnd: '', tail: undefined, protocol: 'native', fns: new Map(), fleet: new Set(), names: modeNames('static') };
    const plan = await mode.interpret({ type: 'tool', id: 'c1', name: 'run', args: { fn: 'fs/read', args: { path: 'a' }, on: 'laptop' } }, rendered, { session: undefined, access: openScope(mintId('actor')) });
    expect(plan).toEqual({ type: 'run', fn: READ, args: { path: 'a' }, on: LAPTOP });
  });
});

describe('static run of a fn the prompt doesn\'t decode', () => {
  const PICK = QualifiedName.parse('fs/pick');
  const OPENAI = { id: 'openai/gpt-5.1', provider: 'openrouter', capabilities: ['chat', 'tools', 'toolsStrict', 'structured', 'json'] } as const;
  const LLAMA = { id: 'meta-llama/llama-3.3-70b-instruct', provider: 'openrouter', capabilities: ['chat', 'tools', 'json'] } as const;

  /** A rig with fs/read and fs/pick (a fn-name field), static mode, and `run` as the prompt sends it (neither fn decoded). */
  async function staticRig() {
    const { deps } = await rig([]);
    const catalog = deps.catalog as Awaited<ReturnType<typeof contextorRig>>['catalog'];
    catalog.addFn(PICK, fn({ description: 'Picks a fn.', args: g.obj({ target: g.fnName(), path: g.text() }), returns: g.text() }));
    const mode = new StaticChatMode({ type: 'static', protocol: 'native', placement: 'system-end', loadDetail: 'signature' }, deps);
    const names = modeNames('static', await catalog.modelNames());
    const rendered: RenderedIteration = { tools: [], systemEnd: '', tail: undefined, protocol: 'native', fns: new Map(), fleet: new Set(), names, decoded: new Set(ownArgs().keys()) };
    const run = runTool(false, names);
    const scope = { session: undefined, access: openScope(mintId('actor')) };
    /** A `run` call as the model sends it on this model's dialect, decoded as core decodes it, then interpreted. */
    const sent = async (model: ModelLike, wire: Record<string, unknown>) => {
      const entry = profileFor(model).request([{ kind: 'tool', name: 'run', schema: run.schema.bind() }]).get('run');
      const decoded = entry.parse(wire, { inPlace: false, repair: false });
      if (!decoded.ok) throw new Error(decoded.message);
      return mode.interpret({ type: 'tool', id: 'c1', name: 'run', args: Json.parse(decoded.value) }, rendered, scope);
    };
    return { mode, run, sent, rendered, scope };
  }

  it('takes the args as one string of JSON text where records are pairs, a plain open object elsewhere', async () => {
    const { run } = await staticRig();
    const argsOf = (model: ModelLike): unknown => JsonObject.parse(JsonObject.parse(profileFor(model).request([{ kind: 'tool', name: 'run', schema: run.schema.bind() }]).get('run').rendered.jsonSchema['properties'])['args']);
    // (nullable: an absent args is `null` on OpenAI strict, and runs with none)
    expect(argsOf(OPENAI)).toMatchObject({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(JSON.stringify(argsOf(OPENAI))).toContain('written as a string of JSON text');
    expect(argsOf(LLAMA)).toMatchObject({ type: 'object' });
    expect(JSON.stringify(argsOf(LLAMA))).not.toContain('JSON text');
  });

  it('reads JSON-text args back, checks them against the fn\'s own args, and reads its fn-name fields from model names', async () => {
    const { sent } = await staticRig();
    expect(await sent(OPENAI, { fn: 'fs__pick', args: '{"target":"fs__read","path":"a"}', on: null })).toEqual({ type: 'run', fn: PICK, args: { target: READ, path: 'a' } });
    // the open object of a lenient dialect reads the same way
    expect(await sent(LLAMA, { fn: 'fs__pick', args: { target: 'fs__read', path: 'a' } })).toEqual({ type: 'run', fn: PICK, args: { target: READ, path: 'a' } });
  });

  it('answers JSON text that doesn\'t parse, and args that don\'t fit, as the model\'s slip (invalid input), never an error', async () => {
    const { sent } = await staticRig();
    const broken = await sent(OPENAI, { fn: 'fs__read', args: '{"path": "a"', on: null });
    expect(broken).toMatchObject({ type: 'invalid', fn: READ, invalid: { source: 'json', problems: [{ path: 'args' }], raw: '{"path": "a"' } });
    expect(broken.type === 'invalid' ? broken.reply : '').toMatch(/^The args of that fs\/read run are not JSON \(/);
    const wrong = await sent(OPENAI, { fn: 'fs__read', args: '{"path": 3}', on: null });
    expect(wrong).toMatchObject({ type: 'invalid', fn: READ, invalid: { source: 'schema' }, args: { path: 3 } });
    expect(wrong.type === 'invalid' ? wrong.reply : '').toContain('The args don\'t fit fs/read');
    // JSON text of something other than an object is checked as it reads: not an object
    expect(await sent(OPENAI, { fn: 'fs__read', args: '[1]', on: null })).toMatchObject({ type: 'invalid', fn: READ, invalid: { source: 'schema' } });
  });
});
