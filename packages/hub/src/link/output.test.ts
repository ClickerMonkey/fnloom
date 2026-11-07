import { SystemName } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '../bus/memory.ts';
import { MemorySystemOutput, renderLogLine } from './output.ts';

const FS = SystemName.parse('fs');

describe('a system\'s output', () => {
  it('renders a structured line as one line of text', () => {
    expect(renderLogLine({ level: 'warn', key: 'fs.watch.failed', fields: { folder: '/x', tries: 2 } })).toBe('warn fs.watch.failed folder=/x, tries=2');
    expect(renderLogLine({ level: 'info', key: 'fs.ready', fields: {} })).toBe('info fs.ready');
  });

  it('keeps the newest lines up to its cap, files warnings as stderr, and publishes each', async () => {
    const bus = new MemoryEventBus(() => undefined);
    const published: string[] = [];
    bus.subscribe('system.output', ({ line }) => { published.push(line.text); });
    let now = 0;
    const output = new MemorySystemOutput({ bus, clock: () => ++now, max: 2 });
    output.logged(FS, { level: 'info', key: 'a', fields: {} });
    output.logged(FS, { level: 'error', key: 'b', fields: {} });
    output.note(FS, 'restarted');
    expect(output.tail(FS, 10)).toEqual([{ at: 2, stream: 'stderr', text: 'error b' }, { at: 3, stream: 'hub', text: 'restarted' }]);
    expect(output.tail(FS, 1)).toEqual([{ at: 3, stream: 'hub', text: 'restarted' }]);
    expect(output.tail(SystemName.parse('shop'), 5)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published).toEqual(['info a', 'error b', 'restarted']);
  });

  it('notes status changes while started', async () => {
    const bus = new MemoryEventBus(() => undefined);
    const output = new MemorySystemOutput({ bus, clock: () => 7 });
    const stop = output.start();
    bus.publish('system.status', { system: FS, status: 'connected' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
    bus.publish('system.status', { system: FS, status: 'disconnected' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(output.tail(FS, 5)).toEqual([{ at: 7, stream: 'hub', text: 'status connected' }]);
  });
});
