/**
 * Full-text search on SQLite FTS5. A docs table maps each indexed item (kind + key) to a rowid; the FTS table holds
 * its text under that rowid, tokenized with Porter stemming over Unicode words (diacritics folded). Searches match
 * any of the query's words and rank by BM25.
 */
import { IndexedKind } from '@harness/core';
import { sql } from 'kysely';
import { z } from 'zod';
import { type AuxDb, TEXT_FTS, TextDoc, createAuxTable, createTextFts } from './auxTables.ts';
import type { Scope } from './db.ts';
import type { TextIndex } from './index.ts';

/** The id of a doc, as read back. */
const DocId = TextDoc.pick({ id: true });
const Hit = z.object({ kind: IndexedKind, key: z.string(), rank: z.number() });

/** Create the text tables. */
export async function createTextTables(scope: Scope): Promise<void> {
  await createAuxTable(scope.db, '_text_docs');
  await createTextFts(scope.db);
}

/** The words of a query, each quoted so FTS5 reads it as a plain term, joined with `OR`. Empty when there are none. */
export function matchExpression(text: string): string {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words.map((word) => word.toLowerCase()))].map((word) => `"${word}"`).join(' OR ');
}

/** The FTS5 text index, in a scope. */
export class SqliteTextIndex implements TextIndex {
  readonly #scope: Scope;

  constructor(scope: Scope) {
    this.#scope = scope;
  }

  async upsert(entries: ReadonlyArray<{ kind: IndexedKind; key: string; text: string }>): Promise<void> {
    if (entries.length === 0) return;
    await this.#scope.atomic(async ({ db }) => {
      for (const { kind, key, text } of entries) {
        const found = await db.selectFrom('_text_docs').select('id').where('kind', '=', kind).where('key', '=', key).executeTakeFirst();
        const id = found === undefined
          ? DocId.parse(await db.insertInto('_text_docs').values({ kind, key }).returning('id').executeTakeFirstOrThrow()).id
          : DocId.parse(found).id;
        await db.deleteFrom(TEXT_FTS).where('rowid', '=', id).execute();
        await db.insertInto(TEXT_FTS).values({ rowid: id, text }).execute();
      }
    });
  }

  async remove(kind: IndexedKind, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.#scope.atomic(async ({ db }) => {
      const rows = await db.selectFrom('_text_docs').select('id').where('kind', '=', kind).where('key', 'in', [...keys]).execute();
      const ids = rows.map((row) => DocId.parse(row).id);
      if (ids.length === 0) return;
      await db.deleteFrom(TEXT_FTS).where('rowid', 'in', ids).execute();
      await db.deleteFrom('_text_docs').where('id', 'in', ids).execute();
    });
  }

  async search(query: { text: string; kinds: readonly IndexedKind[]; limit: number }): Promise<Array<{ kind: IndexedKind; key: string; score: number }>> {
    const match = matchExpression(query.text);
    if (match === '' || query.kinds.length === 0 || query.limit < 1) return [];
    const result = await sql`
      select d.kind as kind, d.key as key, bm25(${sql.table(TEXT_FTS)}) as rank
      from ${sql.table(TEXT_FTS)} join ${sql.table('_text_docs' satisfies keyof AuxDb)} d on d.id = ${sql.table(TEXT_FTS)}.rowid
      where ${sql.table(TEXT_FTS)} match ${match} and d.kind in (${sql.join([...query.kinds])})
      order by rank limit ${Math.floor(query.limit)}`.execute(this.#scope.db);
    // BM25 is lower for better matches; flip it so higher is better
    return result.rows.map((row) => {
      const hit = Hit.parse(row);
      return { kind: hit.kind, key: hit.key, score: -hit.rank };
    });
  }
}
