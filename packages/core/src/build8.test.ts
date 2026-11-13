import { describe, expect, it } from 'vitest';
import { VisualShape, actionLabel, confirmOf, declaredFit, flagsVerdict, hubNameOf, type ResultTable, type SensitivityFlag } from './index.ts';

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

  it('fits a declared shape by channel kinds, row range and wholeness', () => {
    const shape = VisualShape.parse({ channels: [{ name: 'label', label: 'Label', accepts: ['text'], required: true, many: false }, { name: 'value', label: 'Value', accepts: ['number', 'integer'], required: true, many: false }], rows: { min: 2, max: 3 }, whole: true });
    const table: ResultTable = { columns: [{ name: 'a', kind: 'text', nullable: false }, { name: 'b', kind: 'integer', nullable: false }], rows: [['x', 1], ['y', 2]], offset: 0, truncated: false, sort: [] };
    expect(declaredFit(shape, table)).toEqual({ fits: true });
    expect(declaredFit(shape, { ...table, truncated: true }).fits).toBe(false);
    expect(declaredFit(shape, { ...table, rows: [['x', 1]] }).fits).toBe(false);
    expect(declaredFit(shape, { ...table, columns: [{ name: 'a', kind: 'text', nullable: false }] }).why).toBe('No column fits Value (number, integer).');
  });
});
