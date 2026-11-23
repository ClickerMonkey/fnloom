/**
 * What a context item brings with it, every time it is loaded: the context it imports (recursively, cycles cut) and
 * the fns it and they bring (`ContextDecl.fns`). The plain, suggest and graph contextors and `hub/ctx_load` all go
 * through here, so a context's work always has its fns and its linked context, however it got into the prompt.
 */
import { contextOff, mapConcurrent, QualifiedName, type ContextChoice, type ContextRecord } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';

/** A context item's choice with the token size of the item it leads to (absent when that item is gone). */
export interface SizedChoice extends ContextChoice {
  readonly tokens?: number;
}

/**
 * The names with the context each imports after it, depth-first, each once; cycles are cut and unknown names kept as
 * given (the caller decides what to do with them). A switched-off item (`contextOff`) is left out, and so is what
 * only it imports. The records are read a level of imports at a time, each level's at once; the order is worked out
 * after, as a depth-first walk would give it.
 */
export async function withImports(catalog: Pick<Catalog, 'context'>, names: readonly string[]): Promise<string[]> {
  const records = new Map<string, ContextRecord | undefined>();
  for (let level = [...new Set(names)]; level.length > 0;) {
    const found = await mapConcurrent(level, (name) => {
      const parsed = QualifiedName.safeParse(name);
      return parsed.success ? catalog.context(parsed.data) : undefined;
    });
    level.forEach((name, index) => records.set(name, found[index]));
    // an off item's imports are not followed: what only it imports is left out
    level = [...new Set(found.flatMap((record) => (record === undefined || contextOff(record) ? [] : record.decl.imports ?? [])))].filter((name) => !records.has(name));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const record = records.get(name);
    if (record !== undefined && contextOff(record)) return;
    out.push(name);
    for (const imported of record?.decl.imports ?? []) visit(imported);
  };
  for (const name of names) visit(name);
  return out;
}

/** The fns context records bring, in their order, each once. */
export function broughtFns(records: ReadonlyArray<Pick<ContextRecord, 'decl'>>): QualifiedName[] {
  return [...new Set(records.flatMap((record) => record.decl.fns))];
}

/** Which context record brought each fn (the first that names it), for reports and suggestions (`broughtBy`). */
export function broughtBy(records: ReadonlyArray<Pick<ContextRecord, 'name' | 'decl'>>): ReadonlyMap<QualifiedName, QualifiedName> {
  const by = new Map<QualifiedName, QualifiedName>();
  for (const record of records) for (const fn of record.decl.fns) if (!by.has(fn)) by.set(fn, record.name);
  return by;
}

/** A context item's choices, each with the token size of the item it leads to as the model would read it in full. */
export async function sizedChoices(catalog: Pick<Catalog, 'context'>, record: Pick<ContextRecord, 'decl'>, tokens: (text: string) => number): Promise<SizedChoice[]> {
  return Promise.all((record.decl.choices ?? []).map(async (choice): Promise<SizedChoice> => {
    const to = await catalog.context(choice.to);
    if (to === undefined) return choice;
    return { ...choice, tokens: tokens(to.decl.content ?? to.decl.summary ?? to.decl.description) };
  }));
}
