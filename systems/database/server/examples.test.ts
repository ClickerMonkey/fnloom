/**
 * What the query authoring agent is shown must be what it may send: the worked example in its instructions parses
 * against the typed query schema its `draft` tool is sent over the loaded tables (`@aeye/query`'s `buildSchemas`), and
 * the instance's own check finds it clean, so a model that copies it is never refused for the example's own shape.
 */
import { buildSchemas } from '@aeye/query';
import { QueryPayload } from '../shared/shapes.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_DRAFT, EXAMPLE_INSERT_DRAFT, EXAMPLE_RANGE_DRAFT } from './authoring.ts';
import { serveDatabase, shopFile, type ServedDatabase } from './fixture.ts';

describe('the query example the agent is shown', () => {
  let served: ServedDatabase | undefined;
  afterEach(async () => { await served?.stop(); served = undefined; });

  it('fits the draft tool schema over the tables it loads and checks clean', async () => {
    served = await serveDatabase({ dir: shopFile().dir });
    const here = served.server.current();
    if (here === undefined) throw new Error('no instance');
    const types = here.catalog.engine.registry.typeList().filter((type) => ['orders', 'customers'].includes(type.name));
    const { Query } = buildSchemas(here.catalog.engine, { types });
    expect(Query.safeParse(EXAMPLE_DRAFT.query).success).toBe(true);
    // the instance compiles it, as its check does before anyone runs it
    const compiled = here.compile(QueryPayload.parse({ instance: here.instance, description: EXAMPLE_DRAFT.description, query: EXAMPLE_DRAFT.query, sorters: EXAMPLE_DRAFT.sorters, list: true }));
    expect('query' in compiled ? [] : compiled.problems).toEqual([]);
  });

  it.each([
    { name: 'the insert', draft: EXAMPLE_INSERT_DRAFT, tables: ['customers'], list: false },
    { name: 'the date window', draft: EXAMPLE_RANGE_DRAFT, tables: ['orders'], list: true },
  ])('$name fits the draft tool schema and checks clean', async ({ draft, tables, list }) => {
    served = await serveDatabase({ dir: shopFile().dir });
    const here = served.server.current();
    if (here === undefined) throw new Error('no instance');
    const types = here.catalog.engine.registry.typeList().filter((type) => tables.includes(type.name));
    const { Query } = buildSchemas(here.catalog.engine, { types });
    const parsed = Query.safeParse(draft.query);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    const compiled = here.compile(QueryPayload.parse({ instance: here.instance, description: draft.description, query: draft.query, sorters: draft.sorters, list }));
    expect('query' in compiled ? [] : compiled.problems).toEqual([]);
  });
});
