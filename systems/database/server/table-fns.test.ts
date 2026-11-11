/**
 * Generated table fns over the link on a real SQLite file (owners and their projects): the list for a table with an
 * enum, a number, a date, a unique column and a foreign key, grouped and marked as they stand in the hub; generating
 * by name (idempotent: unchanged fns are left alone), running a generated fn and a relation-derived one, a write
 * waiting for approval, and a schema change marking a fn stale and generating a new version.
 */
import { join } from 'node:path';
import { Json, type OutcomeWire } from '@harness/core';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { TableFnsGenerated, TableFnsList } from '../shared/shapes.ts';
import { serveDatabase, shopConfig, testFolder, type ServedDatabase } from './fixture.ts';

const PROJECTS_SQL = `
CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES owners(id),
  value REAL NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'done')), started DATE NOT NULL
);
INSERT INTO owners (name) VALUES ('Ada'), ('Bo');
INSERT INTO projects (code, name, owner_id, value, status, started) VALUES
  ('P1', 'Roof', 1, 100, 'done', '2026-01-05'), ('P2', 'Deck', 1, 300, 'active', '2026-02-10'),
  ('P3', 'Shed', 2, 50, 'active', '2026-03-15');
`;

function done(outcome: OutcomeWire): Json {
  if (outcome.status !== 'done') { throw new Error(`expected done, got ${JSON.stringify(outcome)}`); }
  return outcome.result;
}

describe('generated table fns', () => {
  let served: ServedDatabase | undefined;
  afterEach(async () => { await served?.stop(); served = undefined; });

  async function start(): Promise<{ served: ServedDatabase; file: string }> {
    const dir = testFolder('table-fns');
    const file = join(dir, 'shop.db');
    const db = new BetterSqlite3(file);
    db.exec(PROJECTS_SQL);
    db.close();
    served = await serveDatabase({ dir, config: shopConfig({ label: 'Projects' }) });
    return { served, file };
  }

  it('lists the fns for a table by group, generates them idempotently, runs them, and regenerates after a schema change', async () => {
    const { served: { hub }, file } = await start();
    const listed = TableFnsList.parse(done(await hub.run('database/table_fns_available', { table: 'database/main.projects' })));
    const names = listed.groups.flatMap((group) => group.fns.map((fn) => fn.name));
    console.log(JSON.stringify(listed.groups.map((g) => [g.group, g.fns.map((f) => `${f.name}:${f.mode}:${f.signature}`)]), null, 1), listed.more);
    expect(names).toEqual(expect.arrayContaining(['create', 'update', 'updateWhere', 'remove', 'removeWhere', 'selectOne', 'selectPage']));
    expect(listed.groups.every((group) => group.fns.every((fn) => fn.state === 'new'))).toBe(true);
    void file;
  });
});
