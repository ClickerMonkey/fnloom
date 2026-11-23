/**
 * Hub events as systems hear them (`events.ts`): the `fns` event tells new fns from fns saved again (`changed`), and
 * the update that settles a run says whether it, or a run under it, told its person something (`notified`).
 */
import { FnDecl, noFnStats, QualifiedName, RunId, SystemName, type FnRecord, type SystemEvent } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { RecordingBus, memoryLog, settle } from '../testing.ts';
import { fnsEvent, SystemEventRelay } from './events.ts';

const q = (name: string) => QualifiedName.parse(name);

/** A fn record as the catalog reports a change: only its name is read. */
function record(name: string): FnRecord {
  return {
    name: q(name), system: SystemName.parse('a'), version: 'h', origin: 'runtime', available: true, paused: false, disabled: false, stats: noFnStats(), updatedAt: 1,
    decl: FnDecl.parse({
      name: name.split('/')[1], description: 'd', kind: 'native', args: { name: 'any' }, returns: { name: 'any' }, deps: [], handlers: {}, progress: { type: 'none' },
      operations: { cancel: true, pause: false, undo: false, background: false }, display: 'card', limits: {}, visibility: 'both', tags: [],
    }),
  };
}

/** A relay to one connected system that hears every event, recording what it is sent. */
function relay() {
  const bus = new RecordingBus();
  const heard: SystemEvent[] = [];
  const peer = { call: (_endpoint: 'event', event: SystemEvent) => { heard.push(event); return Promise.resolve(); } };
  const links = { connected: () => [{ system: SystemName.parse('timer'), peer }] };
  const catalog = { manifest: () => Promise.resolve({ events: ['fns', 'run'] }) };
  const stop = new SystemEventRelay({ bus, links, catalog, log: memoryLog().log });
  return { bus, heard, stop };
}

describe('the fns event', () => {
  it('lists new fns as added and fns saved again (or whose availability moved) as changed', () => {
    expect(fnsEvent({ added: [q('a/new'), q('a/again')], removed: [q('a/gone')], updated: [q('a/again')], fns: [record('a/new'), record('a/again'), record('a/moved')] })).toEqual({
      type: 'fns', added: ['a/new'], removed: ['a/gone'], changed: ['a/again', 'a/moved'],
    });
    expect(fnsEvent({ added: [], removed: [], fns: [] })).toEqual({ type: 'fns', added: [], removed: [], changed: [] });
  });

  it('is sent for a save that only changed a fn', async () => {
    const { bus, heard } = relay();
    bus.publish('catalog.changed', { added: [q('timer/weekly')], removed: [], updated: [q('timer/weekly')], fns: [] });
    await settle();
    expect(heard).toEqual([{ type: 'fns', added: [], removed: [], changed: ['timer/weekly'] }]);
  });
});

describe('the run event', () => {
  it('says on the settling update whether the run, or a run under it, notified its person', async () => {
    const { bus, heard } = relay();
    const top = RunId.parse('run_top');
    const quiet = RunId.parse('run_quiet');
    bus.publish('run.notified', { runs: [RunId.parse('run_child'), top] });
    bus.publish('run.update', { run: top, fn: q('timer/weekly'), update: { type: 'status', status: 'running' } });
    bus.publish('run.update', { run: top, fn: q('timer/weekly'), update: { type: 'status', status: 'done' } });
    bus.publish('run.update', { run: quiet, fn: q('timer/weekly'), update: { type: 'status', status: 'failed' } });
    await settle();
    expect(heard.map((event) => (event.type === 'run' ? [event.run, event.notified] : []))).toEqual([[top, undefined], [top, true], [quiet, false]]);
  });
});
