import { describe, expect, it } from 'vitest';
import { ApprovalPreview, ConfigPath, FnRouting, mintId, ProposeRun, ResultTable } from './index.ts';

describe('build 5 contracts', () => {
  const preview = ApprovalPreview.parse({ title: 'Insert 1 row into orders', parts: [{ type: 'code', language: 'sql', code: 'insert into orders (id) values (?)' }], irreversible: false });

  it('lets a run proposed outside a run wait only for an admin', () => {
    const base = { fn: 'shop.apply_schema', args: {}, key: 'k1', preview };
    expect(ProposeRun.safeParse({ ...base, approver: 'admins' }).success).toBe(true);
    expect(ProposeRun.safeParse({ ...base, approver: 'person' }).success).toBe(false);
    expect(ProposeRun.safeParse({ ...base, approver: 'person', parent: mintId('run') }).success).toBe(true);
  });

  it('reads result tables, routing and config paths', () => {
    const table = { columns: [{ name: 'total', kind: 'number', nullable: false }], rows: [[3]], offset: 0, truncated: false, sort: [] };
    expect(ResultTable.parse(table).rows).toEqual([[3]]);
    expect(FnRouting.parse({ to: 'any' })).toEqual({ to: 'any' });
    expect(ConfigPath.safeParse('connection.password').success).toBe(true);
    expect(ConfigPath.safeParse('connection..password').success).toBe(false);
  });
});
