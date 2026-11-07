import { createLogger, type LogRecord } from '@ayepi/log';
import { describe, expect, it, vi } from 'vitest';
import { LinkHost, loggedHost } from './host.ts';
import { errorFieldFilter } from './log.ts';

describe('the error field', () => {
  it('turns a string error field into the serialized shape, and leaves real errors alone', () => {
    const lines: string[] = [];
    const records: LogRecord[] = [];
    const log = createLogger({ level: 'debug', filter: errorFieldFilter, transports: [{ name: 'memory', write: (record, text) => { records.push(record); lines.push(text); } }] });
    log.warn('fs.watch.failed', { folder: '/x', error: 'no such folder' });
    log.error('fs.crashed', {}, new Error('boom'));
    expect(records[0]?.error).toEqual({ name: 'Error', message: 'no such folder' });
    expect(lines[0]).toContain('error=Error: no such folder');
    expect(records[1]?.error?.message).toBe('boom');
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
