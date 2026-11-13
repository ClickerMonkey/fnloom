/**
 * Visuals a system contributes to a registry: `client()` takes only declared contributions with a shape, and the client
 * runtime lists the ones a result may use in load order, leaving out a vetoed one and one whose veto throws.
 */
import { mintId, type ResultTable } from '@harness/core';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { client, type VisualView } from './client.ts';
import { ClientRuntime } from './client-runtime.ts';
import { system } from './system.ts';
import { channel, resultFacts, visual } from './widgets.ts';

const REGISTRY = 'hub/visuals';
const WaffleView = (view: VisualView) => h('div', `${view.style}: ${String(view.table.rows.length)}`);
const BrokenView = () => h('div');
const shape = { channels: [channel('value', 'Value', ['integer'])], rows: { min: 1 }, whole: false };

const charts = system('charts', {
  description: 'Charts.',
  contributes: [visual({ name: 'waffle', label: 'Waffle', icon: 'grid', shape }), visual({ name: 'dial', label: 'Dial', shape })],
});
const broken = system('broken', { description: 'Broken.', contributes: [visual({ name: 'boom', label: 'Boom', shape }), { registry: REGISTRY, name: 'bare', label: 'Bare' }] });

const one: ResultTable = { columns: [{ name: 'n', kind: 'integer', nullable: false }], rows: [[42]], offset: 0, truncated: false, sort: [] };
const many: ResultTable = { ...one, rows: [[1], [2]] };

function runtime(): ClientRuntime {
  const r = new ClientRuntime({
    online: () => true,
    act: () => Promise.resolve(mintId('delivery')),
    submit: () => Promise.resolve(mintId('delivery')),
    invoke: () => Promise.resolve(mintId('run')),
    follow: () => new Promise(() => undefined),
  });
  r.register(client(charts, {
    visuals: { [REGISTRY]: { waffle: { component: WaffleView }, dial: { veto: (table) => (table.rows.length > 1 ? 'A dial shows one value.' : undefined), component: WaffleView } } },
  }));
  r.register(client(broken, { visuals: { [REGISTRY]: { boom: { veto: () => { throw new Error('boom'); }, component: BrokenView } } } }));
  return r;
}

describe('visual registries', () => {
  it('lists the visuals a result may use, without the vetoed ones or a veto that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = runtime();
    expect(r.visuals(REGISTRY, one, resultFacts(one)).map((v) => `${v.system}/${v.name}`)).toEqual(['charts/waffle', 'charts/dial']);
    expect(r.visuals(REGISTRY, many, resultFacts(many)).map((v) => v.name)).toEqual(['waffle']);
    const [first] = r.visuals(REGISTRY, one, resultFacts(one));
    expect(first).toMatchObject({ label: 'Waffle', icon: 'grid', shape: { whole: false } });
    expect(first?.client.online).toBe(true);
    expect(r.visuals('other/registry', one, resultFacts(one))).toEqual([]);
    expect(warn).toHaveBeenCalledWith('client.visual.veto-failed', expect.objectContaining({ system: 'broken', name: 'boom' }));
    warn.mockRestore();
  });

  it('refuses a visual the contract does not contribute, or one without a shape', () => {
    expect(() => client(charts, { visuals: { [REGISTRY]: { pie: { component: BrokenView } } } })).toThrow(/not in the contract's contributes/);
    expect(() => client(broken, { visuals: { [REGISTRY]: { bare: { component: BrokenView } } } })).toThrow(/needs a declared shape/);
  });
});
