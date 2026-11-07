/**
 * Named type definitions with every named type they reference, dependencies first (gin `typeClosure` over the stored
 * types), and the names the hub doesn't know. Systems ask for these over the link (`ctx.types`) and the browser over
 * the web API, so either can parse and check values of types it doesn't declare itself.
 */
import type { QualifiedName, TypeDefinitions } from '@harness/core';
import type { Catalog } from './index.ts';

/** The definitions of `names` and everything they need, dependencies first. */
export async function typeDefinitions(catalog: Pick<Catalog, 'typeClosure' | 'type'>, names: readonly QualifiedName[]): Promise<TypeDefinitions> {
  const closure = await catalog.typeClosure(names);
  const records = await Promise.all(closure.order.map((name) => catalog.type(name)));
  return { types: records.flatMap((record) => (record === undefined ? [] : [record])), missing: closure.missing };
}
