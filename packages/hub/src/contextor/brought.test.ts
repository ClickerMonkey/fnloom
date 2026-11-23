/**
 * `withImports`: the names with what each imports, depth-first and each once, read a level of imports at a time.
 */
import { contextOff, QualifiedName, type ContextRecord } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { TestCatalog } from '../execution/testing.ts';
import { withImports } from './brought.ts';

const q = (name: string): QualifiedName => QualifiedName.parse(name);

/** The walk as it was before the levels were read at once: one record after another, depth-first. */
async function oneByOne(catalog: { context(name: QualifiedName): Promise<ContextRecord | undefined> }, names: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = async (name: string): Promise<void> => {
    if (seen.has(name)) return;
    seen.add(name);
    const parsed = QualifiedName.safeParse(name);
    const record = parsed.success ? await catalog.context(parsed.data) : undefined;
    if (record !== undefined && contextOff(record)) return;
    out.push(name);
    for (const imported of record?.decl.imports ?? []) await visit(imported);
  };
  for (const name of names) await visit(name);
  return out;
}

describe('withImports', () => {
  it('gives the depth-first order a one-by-one walk gives, with cycles cut, unknown names kept and off items left out', async () => {
    const test = new TestCatalog();
    const imports: Record<string, string[]> = {
      a: ['b', 'c', 'gone'], b: ['d', 'a'], c: ['d', 'e'], d: ['f'], e: ['off'], f: [], off: ['only-off'], 'only-off': [], g: ['c', 'b'],
    };
    for (const [local, list] of Object.entries(imports)) {
      test.contexts.set(q(`fs/${local}`), local);
      test.contextDecls.set(q(`fs/${local}`), { imports: list.map((to) => q(`fs/${to}`)) });
    }
    let running = 0;
    let most = 0;
    const catalog = {
      context: async (name: QualifiedName): Promise<ContextRecord | undefined> => {
        running += 1;
        most = Math.max(most, running);
        // later names answer first, so a level's reads finish out of order
        await new Promise((resolve) => setTimeout(resolve, 10 - name.length));
        running -= 1;
        const record = await test.context(name);
        return record !== undefined && name === 'fs/off' ? { ...record, disabled: true } : record;
      },
    };
    const names = ['fs/a', 'not a name', 'fs/g', 'fs/a'];
    const walked = await withImports(catalog, names);
    expect(walked).toEqual(await oneByOne(catalog, names));
    expect(walked).toEqual(['fs/a', 'fs/b', 'fs/d', 'fs/f', 'fs/c', 'fs/e', 'fs/gone', 'not a name', 'fs/g']);
    // a level's records were read side by side
    expect(most).toBeGreaterThan(1);
  });
});
