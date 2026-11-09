/**
 * The mock hub's build 5 samples: query results as the database system attaches them (`database/result`, a
 * `ResultTable`), one that a bar chart fits and one wide table, and a write waiting for approval with its preview (the
 * SQL, the rows it touches and a table type's change).
 */
import { RunId, type ApprovalPreview, type ResultTable } from '@harness/core';

/** The run of the write that waits for approval, which the inbox's approval notification points at. */
export const WAITING_WRITE = RunId.parse('run_orders_write');

/** Orders per city: a label column and a number column, which a bar chart fits. */
export const ORDERS_BY_CITY: ResultTable = {
  columns: [{ name: 'city', kind: 'text', nullable: false }, { name: 'orders', kind: 'integer', nullable: false }],
  rows: [['Oslo', 128], ['Lima', 96], ['Rome', 74], ['Kyoto', 51], ['Austin', 33], ['Nairobi', 12]],
  offset: 0, total: 6, truncated: false, sort: [{ column: 'orders', dir: 'desc' }],
};

/** The latest orders: a wide table, a page of a longer result. */
export const LATEST_ORDERS: ResultTable = {
  columns: [
    { name: 'id', kind: 'integer', nullable: false }, { name: 'customer', kind: 'text', nullable: false }, { name: 'email', kind: 'text', nullable: true },
    { name: 'total', kind: 'number', nullable: false }, { name: 'paid', kind: 'boolean', nullable: false }, { name: 'placed_at', kind: 'datetime', nullable: false },
    { name: 'notes', kind: 'json', nullable: true },
  ],
  rows: Array.from({ length: 40 }, (_, i) => [
    1040 - i, ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson'][i % 4] ?? 'Ada', i % 5 === 0 ? null : `buyer${i}@example.com`,
    Math.round((19.99 + i * 7.31) * 100) / 100, i % 3 !== 0, Date.UTC(2026, 10, 8, 12) - i * 3_600_000, i % 7 === 0 ? { gift: true } : null,
  ]),
  offset: 0, limit: 40, total: 312, truncated: true, sort: [{ column: 'placed_at', dir: 'desc' }],
};

/** What the waiting write would do. */
export const WRITE_PREVIEW: ApprovalPreview = {
  title: 'Mark 2 orders as refunded',
  irreversible: false,
  parts: [
    { type: 'text', text: 'Sets `status` to **refunded** on the two orders Grace Hopper asked about.' },
    { type: 'code', language: 'sql', code: "UPDATE orders\nSET status = 'refunded'\nWHERE id IN (1037, 1033);" },
    {
      type: 'table', title: 'Rows it changes',
      table: {
        columns: [{ name: 'id', kind: 'integer', nullable: false }, { name: 'customer', kind: 'text', nullable: false }, { name: 'status', kind: 'text', nullable: false }],
        rows: [[1037, 'Grace Hopper', 'paid'], [1033, 'Grace Hopper', 'paid']], offset: 0, total: 2, truncated: false, sort: [],
      },
    },
    {
      type: 'type-diff', name: 'shop.Orders',
      before: { name: 'obj', props: { id: { type: { name: 'num' } }, status: { type: { name: 'text' } } } },
      after: { name: 'obj', props: { id: { type: { name: 'num' } }, status: { type: { name: 'text' } }, refunded_at: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } },
      changes: ['Adds refunded_at (an optional date)'],
      breaks: [{ fn: 'shop.orders_export', why: 'selects every column by position' }],
    },
  ],
};
