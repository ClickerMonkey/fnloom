import type { LogLine } from '@harness/core';
import { describe, expect, it, vi } from 'vitest';
import { LinkHost, loggedHost } from './host.ts';
import { systemLogger } from './log.ts';

describe('the error field', () => {
  it('sends a string error field and a real error to the hub as their message', () => {
    const lines: LogLine[] = [];
    const log = systemLogger({ level: 'debug', json: false, console: 'none', sink: (line) => { lines.push(line); } });
    log.warn('fs.watch.failed', { folder: '/x', error: 'no such folder' });
    log.error('fs.crashed', {}, new Error('boom'));
    expect(lines[0]).toEqual({ level: 'warn', key: 'fs.watch.failed', fields: { folder: '/x', error: 'no such folder' } });
    expect(lines[1]?.fields['error']).toBe('boom');
  });
});

describe('loggedHost', () => {
  it('gives a process log before serve: structured lines with the system name, secrets masked', () => {
    const lines: unknown[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(line); });
    try {
      const { host, log } = loggedHost('notes');
      log.info('notes.ready', { token: 'hunter2', count: 1 });
      expect(host).toBeInstanceOf(LinkHost);
      const line = String(lines[0]);
      expect(line).toContain('notes.ready');
      expect(line).toContain('system=notes');
      expect(line).toContain('count=1');
      expect(line).not.toContain('hunter2');
    } finally {
      spy.mockRestore();
    }
  });
});
