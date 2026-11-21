import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, parseOptions } from './options.ts';

describe('the test MCP server options', () => {
  it('listens on this machine only unless --host says otherwise, as its test tokens are fixed', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(parseOptions([]).host).toBe('127.0.0.1');
    expect(parseOptions(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
  });
});
