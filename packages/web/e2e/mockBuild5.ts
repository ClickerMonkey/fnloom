/**
 * The mock hub's build 5 samples: query results as the database system attaches them (`database/result`, a
 * `ResultTable`), one that a bar chart fits and one wide table, and a write waiting for approval with its preview (the
 * SQL, the rows it touches and a table type's change).
 */
import {
  AutoClassifier, fnLabel, FnExampleId, QualifiedName, RunId, type ActorId, type ApprovalPreview, type AutoClassifierView, type ClientLogBatch, type ClientLogReceipt, type FnExamplesPage,
  type FnExamplesQuery, type FnFacts, type FnSearchPage, type FnSearchQuery, type ResultTable,
} from '@harness/core';

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

/**
 * The mock hub's fn views (build 5 feedback): any fn found by its name, its facts (a read for `read`-like names, a
 * write otherwise; free for the fs system), a dozen examples to page through, the auto classifier setting, and the
 * browser's log batches counted.
 */
export class MockFns {
  #classifier: AutoClassifierView = { value: AutoClassifier.parse({}) };
  #logged = 0;

  /** The fn a search by its local name in its system finds. */
  search(query: FnSearchQuery): FnSearchPage {
    const system = query.systems?.[0];
    if (system === undefined || query.text === undefined) { return { items: [] }; }
    const name = QualifiedName.parse(`${system}/${query.text}`);
    const facts = this.facts(name);
    return {
      items: [{
        item: 'fn', name, system, description: `${fnLabel(name)}: the mock hub's stand-in description of what it does and when to use it.`, kind: facts.kind,
        mode: facts.mode, signature: `${query.text}(path: text, offset?: num, limit?: num) → { text: text, lines: num }`, available: true,
      }],
    };
  }

  facts(fn: QualifiedName): FnFacts {
    const reads = /read|list|get|search|glob|grep/.test(fn);
    const free = fn.startsWith('fs/');
    return {
      fn, kind: 'native', mode: reads ? 'read' : 'write', reads: ['fs/Entry'], writes: reads ? [] : ['fs/Entry'], uses: [fn, QualifiedName.parse('fs/read_file')], free,
      cost: free ? { min: 0, typical: 0, max: 0, basis: 'free', runs: 128 } : { min: 0.0004, typical: 0.0021, max: 0.012, basis: 'history', runs: 128 },
      times: { runs: 128, typical: 640, slow: 4_200, longest: 21_000 }, longRunning: false,
    };
  }

  examples(query: FnExamplesQuery): FnExamplesPage {
    const all = Array.from({ length: 12 }, (_, i) => ({
      id: FnExampleId.parse(`fex_mock_${i}`), args: { path: ['README.md', 'src/app.ts', 'docs/guide.md'][i % 3] ?? 'README.md', ...(i % 2 === 1 ? { offset: i * 20, limit: 40 } : {}) },
      ...(i === 0 ? { note: 'The whole file.', result: { text: '# Harness\n…', lines: 120 } } : i === 1 ? { note: 'A window of a long file.' } : {}),
    }));
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 10;
    const next = offset + limit < all.length ? offset + limit : undefined;
    return { fn: query.fn, items: all.slice(offset, offset + limit), total: all.length, ...(next === undefined ? {} : { next }) };
  }

  classifier(): AutoClassifierView {
    return this.#classifier;
  }

  setClassifier(value: AutoClassifier, by: ActorId): AutoClassifierView {
    this.#classifier = { value, setBy: by, updatedAt: Date.now() };
    return this.#classifier;
  }

  log(batch: ClientLogBatch): ClientLogReceipt {
    this.#logged += batch.entries.length;
    return { uri: 'hub://logs/browser/act_admin-1.jsonl', written: this.#logged };
  }
}
