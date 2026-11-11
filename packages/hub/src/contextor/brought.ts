/**
 * What a context item brings with it, every time it is loaded: the context it imports (recursively, cycles cut) and
 * the fns it and they bring (`ContextDecl.fns`). The plain, suggest and graph contextors and `hub/load_context` all go
 * through here, so a context's work always has its fns and its linked context, however it got into the prompt.
 */
import { QualifiedName, type ContextChoice, type ContextRecord } from '@harness/core';
import type { Catalog } from '../catalog/index.ts';

/** A context item's choice with the token size of the item it leads to (absent when that item is gone). */
export interface SizedChoice extends ContextChoice {
  readonly tokens?: number;
}

/**
 * The names with the context each imports after it, depth-first, each once; cycles are cut and unknown names kept as
 * given (the caller decides what to do with them).
 */
export async function withImports(catalog: Pick<Catalog, 'context'>, names: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = async (name: string): Promise<void> => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
    const parsed = QualifiedName.safeParse(name);
    const record = parsed.success ? await catalog.context(parsed.data) : undefined;
    for (const imported of record?.decl.imports ?? []) await visit(imported);
  };
  for (const name of names) await visit(name);
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
