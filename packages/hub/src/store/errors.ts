/** The store's one error type: every refusal carries a code, so callers branch on the code, not the message. */

/** Why the store refused. */
export type StoreErrorCode =
  /** `insert` of a key that already exists. */
  | 'exists'
  /** `update` of a key that doesn't exist. */
  | 'missing'
  /** A row (or a patched row) that its table's schema refuses. */
  | 'invalid-row'
  /** An `update` patch that would change the row's key. */
  | 'key-change'
  /** A filter or order on a column that is not a scalar column of the table. */
  | 'bad-query'
  /** A cursor this store did not issue for this query. */
  | 'bad-cursor'
  /** A migration that can't be applied without losing data. */
  | 'migration'
  /** A vector operation on an embedder the store wasn't opened with. */
  | 'unknown-embedder'
  /** A vector whose length isn't the embedder's dimensions, or holds a value that isn't finite. */
  | 'bad-vector'
  /** Something only the whole store can do (`close`), asked of a transaction's store. */
  | 'in-transaction';

/** A refusal from the store. */
export class StoreError extends Error {
  override readonly name = 'StoreError';

  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
