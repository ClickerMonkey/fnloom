import { describe, expect, it } from 'vitest';
import type { LogRecord } from '@ayepi/log';
import { parseHubSettings } from './env.ts';
import { makeLogger } from './log.ts';

describe('makeLogger', () => {
  it('keeps structured fields and masks secrets at any depth', () => {
    const base = parseHubSettings();
    const log = makeLogger({ ...base, logEnv: { ...base.logEnv, HARNESS_LOG_FILES: false, HARNESS_LOG_LEVEL: 'debug' } });
    const records: LogRecord[] = [];
    log.setTransports([{ name: 'memory', write: (record) => { records.push(record); } }]);
    log.info('auth.signed-in', { user: 'act_1', password: 'hunter22', nested: { apiKey: 'sk-1', refreshToken: 'r' } });
    const text = JSON.stringify(records);
    expect(text).toContain('auth.signed-in');
    expect(text).toContain('act_1');
    for (const secret of ['hunter22', 'sk-1', '"r"']) { expect(text).not.toContain(secret); }
  });
});
