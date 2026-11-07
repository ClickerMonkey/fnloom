import { createLogger, type LogRecord } from '@ayepi/log';
import { describe, expect, it } from 'vitest';
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
