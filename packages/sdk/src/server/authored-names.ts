/**
 * The build's check of names in a contract's model-facing text (plan `injected-context-2026-11-22`, section 1): the
 * context folder's broken-link check, widened to descriptions, instructions, examples' notes, context bodies and
 * summaries, hooks' `explains` and the system's `about`. The hub renders each `fn:` ref and each bare name of a known
 * fn as the name the model calls it by, and each `context:` ref as its key (`ModelFnNames.text`), so a name that
 * resolves to nothing is a stale or misspelt sentence: the build warns, naming where it is and the nearest names.
 * Only names of systems the build knows every name of are checked (the system's own and the hub's), so a path
 * (`src/index.ts`) or another system's name is left alone.
 */
import { didYouMean } from '@aeye/gin';
import { qualify, unresolvedNamesIn, type AuthoredNames, type Manifest } from '@harness/core';

/** One piece of model-facing text, with where it is (`fns.add.description`). */
export interface AuthoredText {
  readonly where: string;
  readonly text: string;
}

/** The payload's instructions of an agent fn (`hub/llm`), when it has them. */
function instructionsOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('instructions' in payload)) return undefined;
  const instructions: unknown = payload.instructions;
  return typeof instructions === 'string' ? instructions : undefined;
}

/** Every piece of text in a manifest the model reads. */
export function authoredTexts(manifest: Manifest): AuthoredText[] {
  const out: AuthoredText[] = [];
  const add = (where: string, text: string | undefined): void => { if (text !== undefined && text !== '') out.push({ where, text }); };
  add('description', manifest.description);
  add('about', manifest.about);
  for (const decl of manifest.fns) {
    add(`fns.${decl.name}.description`, decl.description);
    add(`fns.${decl.name}.instructions`, decl.instructions);
    add(`fns.${decl.name}.payload.instructions`, instructionsOf(decl.payload));
    (decl.examples ?? []).forEach((example, at) => { add(`fns.${decl.name}.examples[${at}].note`, example.note); });
  }
  for (const decl of manifest.context) {
    add(`context.${decl.name}.description`, decl.description);
    add(`context.${decl.name}.summary`, decl.summary);
    add(`context.${decl.name}.content`, decl.content);
  }
  for (const decl of manifest.hooks) {
    add(`hooks.${decl.name}.description`, decl.description);
    add(`hooks.${decl.name}.explains`, decl.explains);
  }
  for (const decl of manifest.kinds) add(`kinds.${decl.name}.description`, decl.description);
  return out;
}

/** The names a manifest itself declares, qualified (`types` holds its kinds too). */
export function declaredNames(manifest: Manifest): { fns: string[]; context: string[]; types: string[] } {
  return {
    fns: manifest.fns.map((decl) => qualify(manifest.name, decl.name)),
    context: manifest.context.map((decl) => qualify(manifest.name, decl.name)),
    types: [...manifest.types, ...manifest.kinds].map((decl) => qualify(manifest.name, decl.name)),
  };
}

/**
 * Warnings for the names in a manifest's model-facing text that resolve to nothing `known` holds, one line each:
 * `fns.add.description: fn:notes/ad names no fn — did you mean notes/add?`. A ref that names nothing always warns; a
 * bare name only when it is near a name the build knows (a misspelling): a text may name fns that are only examples
 * (`code/price_with_tax`, a fn a person might make).
 */
export function authoredNameWarnings(manifest: Manifest, known: AuthoredNames): string[] {
  const warnings: string[] = [];
  const all = [...known.fns, ...known.context, ...known.types];
  for (const { where, text } of authoredTexts(manifest)) {
    for (const found of unresolvedNamesIn(text, known)) {
      const what = found.ref === 'fn' ? 'names no fn' : found.ref === 'context' ? 'names no context item' : 'names no fn, context item or type';
      const written = found.ref === undefined ? found.name : `${found.ref}:${found.name}`;
      const near = didYouMean(found.name, found.ref === 'fn' ? [...known.fns] : found.ref === 'context' ? [...known.context] : all, { max: 2 });
      if (found.ref === undefined && near === '') continue;
      warnings.push(`${where}: ${written} ${what}${near}`);
    }
  }
  return warnings;
}
