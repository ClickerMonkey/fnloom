import { describe, expect, it } from 'vitest';
import { actionLabel, confirmOf, flagsVerdict, hubNameOf, type SensitivityFlag } from './index.ts';

const flag = (over: Partial<SensitivityFlag>): SensitivityFlag => ({ path: '.env', kind: 'env', rule: 'env-files', access: 'read', action: 'ask', why: 'Env files hold keys.', certain: true, ...over });

describe('build 8 contracts', () => {
  it('refuses on any refusal, asks on any write or asked read, else passes', () => {
    expect(flagsVerdict([])).toEqual({ effect: 'pass' });
    expect(flagsVerdict([flag({ action: 'allow' })])).toEqual({ effect: 'pass' });
    expect(flagsVerdict([flag({ access: 'write', action: 'allow' })]).effect).toBe('ask');
    expect(flagsVerdict([flag({}), flag({ action: 'refuse', path: 'id_rsa' })])).toEqual({ effect: 'refuse', reason: 'Reads id_rsa (env: Env files hold keys.)' });
    expect(flagsVerdict([flag({ certain: false })])).toEqual({ effect: 'ask', reason: 'May read .env (env: Env files hold keys.)' });
  });

  it('takes the hub name from the setting, then the env, then the default', () => {
    expect(hubNameOf(' Home Base ', 'Env')).toEqual({ name: 'Home Base', source: 'setting' });
    expect(hubNameOf(undefined, 'Env')).toEqual({ name: 'Env', source: 'env' });
    expect(hubNameOf('', '')).toEqual({ name: 'Harness', source: 'default' });
  });

  it('confirms anything above a read and labels actions from names', () => {
    expect(confirmOf('read', undefined)).toBe(false);
    expect(confirmOf('read', true)).toBe(true);
    expect(confirmOf('write', undefined)).toBe(true);
    expect(actionLabel('todo/Task.mark_done')).toBe('Mark done');
    expect(actionLabel('fs/Entry.reveal')).toBe('Reveal');
  });
});
