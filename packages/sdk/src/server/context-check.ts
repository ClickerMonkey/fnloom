/**
 * The check of a system's context folder (the build's, and the test kit's `contextFolder`). On top of what the SDK's reader checks in each file (the header
 * against `ContextFileHeader`, a missing summary, duplicate keys), it follows every link: the header's `fns`,
 * `suggestFns`, `alwaysFor`, `imports`, `choices`, `links`, `parent` and `next`, and `[text](context:key)` / `fn:name`
 * references in the body, against the names the system knows (its own contract and context, and the hub's catalog or
 * the systems it requires), and refuses a context that loads itself through `imports`. Every problem has a file, line
 * and column.
 */
import { didYouMean } from '@aeye/gin';
import { CONTEXT_BODY_REFERENCE, qualify, type ContextFileProblem } from '@harness/core';
import { contextProblem, positionOf, readContextFolder, type ContextFile } from './context-files.ts';

/** The names a context folder may link to. */
export interface KnownNames {
  /** The system the folder belongs to: its keys are qualified with it. */
  readonly system: string;
  /** Fns it may link to, qualified (its own and others'). */
  readonly fns: ReadonlySet<string>;
  /** Context it may link to besides its own files, qualified (its contract's and others'). */
  readonly context: ReadonlySet<string>;
}

/** A checked folder: its files, and every problem in it. */
export interface CheckedContext {
  readonly files: readonly ContextFile[];
  readonly problems: readonly ContextFileProblem[];
}

/** One link a file makes, with the header key it is under (`undefined` for the body) and what it must name. */
interface FileLink {
  readonly to: string;
  readonly kind: 'fn' | 'context';
  readonly key: string | undefined;
}

/** Every link a file's header makes. */
function headerLinks(file: ContextFile): FileLink[] {
  const header = file.header;
  const fns = (key: string, names: readonly string[]): FileLink[] => names.map((to) => ({ to, kind: 'fn', key }));
  const context = (key: string, names: readonly string[]): FileLink[] => names.map((to) => ({ to, kind: 'context', key }));
  return [
    ...fns('fns', header.fns),
    ...fns('suggestFns', header.suggestFns),
    ...fns('alwaysFor', header.alwaysFor),
    ...context('imports', header.imports),
    ...context('choices', (header.choices ?? []).map((choice) => choice.to)),
    ...context('parent', header.parent === undefined ? [] : [header.parent]),
    ...context('next', header.next === undefined ? [] : [header.next]),
    ...(header.links ?? []).flatMap((link): FileLink[] => link.to.kind === 'fn' || link.to.kind === 'context' ? [{ to: link.to.name, kind: link.to.kind, key: 'links' }] : []),
  ];
}

/** A fence line of a fenced code block (three or more backticks or tildes, up to three spaces in). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Every `context:` / `fn:` reference in a file's body, with its 1-based line and column in the file. References in
 * fenced code blocks are examples (another system's file shown as text), so they are not links and aren't checked.
 */
function bodyLinks(file: ContextFile): Array<FileLink & { line: number; column: number }> {
  const found: Array<FileLink & { line: number; column: number }> = [];
  const lines = file.source.split(/\r?\n/);
  let fence: string | undefined;
  for (let index = file.bodyLine - 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const marker = FENCE.exec(line)?.[1];
    if (marker !== undefined) {
      // a fence closes with the same character, at least as long as the one that opened it
      if (fence === undefined) { fence = marker; } else if (marker[0] === fence[0] && marker.length >= fence.length) { fence = undefined; }
      continue;
    }
    if (fence !== undefined) { continue; }
    for (const match of line.matchAll(new RegExp(CONTEXT_BODY_REFERENCE.source, 'g'))) {
      const [, kind, to] = match;
      if ((kind === 'fn' || kind === 'context') && to !== undefined) { found.push({ to, kind, key: undefined, line: index + 1, column: match.index + 1 }); }
    }
  }
  return found;
}

/**
 * Every fn and context a context folder links to (header and body, not fenced code), each name once, so a build can ask
 * a hub's catalog about exactly those names instead of loading the catalog.
 */
export async function contextFolderLinks(dir: string): Promise<{ fns: string[]; context: string[] }> {
  const read = await readContextFolder(dir);
  const links = read.files.flatMap((file) => [...headerLinks(file), ...bodyLinks(file)]);
  const named = (kind: FileLink['kind']) => [...new Set(links.filter((link) => link.kind === kind).map((link) => link.to))];
  return { fns: named('fn'), context: named('context') };
}

/**
 * Check a system's context folder (`dir`, usually `<system>/context`): the SDK reader's checks, then every link and
 * every `imports` cycle. `label` names files in problems (default `context`).
 */
export async function checkContextFolder(dir: string, known: KnownNames, label?: string): Promise<CheckedContext> {
  const read = await readContextFolder(dir, label);
  const problems: ContextFileProblem[] = [...read.problems];
  const own = new Map(read.files.map((file) => [qualify(known.system, file.header.key), file]));
  const names = { fn: known.fns, context: new Set([...known.context, ...own.keys()]) };
  for (const file of read.files) {
    const links = [
      ...headerLinks(file).map((link) => ({ ...link, ...positionOf(file.source, link.to, link.key === undefined ? 1 : positionOf(file.source, `${link.key}:`).line) })),
      ...bodyLinks(file),
    ];
    for (const link of links) {
      if (names[link.kind].has(link.to)) { continue; }
      const where = link.key === undefined ? 'the body' : link.key;
      problems.push(contextProblem(file.file, link.line, link.column, 'broken-link', `${where} links to ${link.kind} ${link.to}, which doesn't exist${didYouMean(link.to, [...names[link.kind]], { max: 2 })}`));
    }
  }
  problems.push(...importCycles(own));
  return { files: read.files, problems };
}

/** One problem per context that loads itself through `imports`, at its first import on the cycle. */
function importCycles(own: ReadonlyMap<string, ContextFile>): ContextFileProblem[] {
  const problems: ContextFileProblem[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (name: string): void => {
    const file = own.get(name);
    if (file === undefined || state.get(name) === 'done') { return; }
    state.set(name, 'visiting');
    stack.push(name);
    for (const next of file.header.imports) {
      if (state.get(next) === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const at = positionOf(file.source, next, positionOf(file.source, 'imports:').line);
        problems.push(contextProblem(file.file, at.line, at.column, 'cycle', `imports load in a cycle: ${cycle.join(' → ')}`));
      } else {
        visit(next);
      }
    }
    stack.pop();
    state.set(name, 'done');
  };
  for (const name of own.keys()) { visit(name); }
  return problems;
}
