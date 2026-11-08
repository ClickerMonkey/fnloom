import { InstanceName, QualifiedName, SystemName, type Json } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { contextorEnv } from './env.ts';
import type { ContextorDeps, FnView, RenderedIteration, Selection } from './index.ts';
import { fleetArgs, fnModeTool, machinesOf, StaticChatMode, ToolsChatMode } from './modes.ts';
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
  const deps: ContextorDeps = { catalog: r.catalog, search: r.search, views: r.views, graph: r.graph, instances, settings: contextorEnv.parse(), log: r.log, clock: () => r.time.now };
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
    expect(fleet?.schema.safeParse({ path: 'a' }).success).toBe(true);
    expect(fleet?.schema.safeParse({ path: 'a', on: 'attic' }).success).toBe(false);
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
    const call = (args: Json) => mode.interpret({ type: 'tool', id: 'c1', name: 'fs__read', args }, rendered);
    expect(await call({ path: 'a', on: 'desk' })).toEqual({ type: 'run', fn: READ, args: { path: 'a' }, on: DESK });
    expect(await call({ path: 'a' })).toEqual({ type: 'run', fn: READ, args: { path: 'a' } });
    expect(await call({ path: 'a', on: 7 })).toMatchObject({ type: 'invalid', fn: READ, invalid: { source: 'validation' }, args: { path: 'a', on: 7 } });
    const solo: RenderedIteration = { ...rendered, fleet: new Set() };
    expect(await mode.interpret({ type: 'tool', id: 'c2', name: 'fs__read', args: { path: 'a', on: 'desk' } }, solo)).toEqual({ type: 'run', fn: READ, args: { path: 'a', on: 'desk' } });
  });

  it('in static mode, pass run’s `on` to the run of the fn it names', async () => {
    const two = await rig([LAPTOP, DESK]);
    const mode = new StaticChatMode({ type: 'static', protocol: 'native', placement: 'system-end', loadDetail: 'signature' }, two.deps);
    const rendered: RenderedIteration = { tools: [], systemEnd: '', tail: undefined, protocol: 'native', fns: new Map(), fleet: new Set() };
    const plan = await mode.interpret({ type: 'tool', id: 'c1', name: 'run', args: { fn: 'fs/read', args: { path: 'a' }, on: 'laptop' } }, rendered, { session: undefined });
    expect(plan).toEqual({ type: 'run', fn: READ, args: { path: 'a' }, on: LAPTOP });
  });
});
