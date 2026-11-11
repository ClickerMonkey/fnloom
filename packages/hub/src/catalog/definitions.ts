/**
 * Named type definitions with every named type they reference, dependencies first (gin `typeClosure` over the stored
 * types), and the names the hub doesn't know. Systems ask for these over the link (`ctx.types`) and the browser over
 * the web API, so either can parse and check values of types it doesn't declare itself.
 */
import type { QualifiedName, TypeDefinitions, TypeRecord } from '@harness/core';
import type { Catalog } from './index.ts';

/**
 * The definitions of `names` and everything they need, dependencies first. A type `sees` turns away (one the asking
 * person may not see) reads as missing.
 */
export async function typeDefinitions(catalog: Pick<Catalog, 'typeClosure' | 'type'>, names: readonly QualifiedName[], sees: (record: TypeRecord) => boolean = () => true): Promise<TypeDefinitions> {
  const closure = await catalog.typeClosure(names);
  const records = await Promise.all(closure.order.map((name) => catalog.type(name)));
  const found = records.flatMap((record) => (record === undefined ? [] : [record]));
  const hidden = found.filter((record) => !sees(record)).map((record) => record.name);
  return { types: found.filter(sees), missing: [...closure.missing, ...hidden] };
}
