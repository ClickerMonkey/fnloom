/**
 * The check of a system's context folder (the build's, and the test kit's `contextFolder`). On top of what the SDK's
 * reader checks in each file (the header against `ContextFileHeader`, a missing summary, duplicate keys), it follows
 * every link: the header's `fns`, `suggestFns`, `inject.requires`, `imports`, `choices`, `links`, `parent` and `next`,
 * each exact agent name in `inject.into` (a pattern, holding `*`, may hit no agent yet), and `[text](context:key)` /
 * `fn:name` references in the body, against the names the system knows (its own contract and context, and the hub's
 * catalog or the systems it requires), and refuses a context that loads itself through `imports`. An anchor link in
 * the body (`[text](#anchor)`, or `context:key#anchor` to another file of the folder) must name an anchor that file
 * has: an `<a id>` or a heading. Every problem has a file, line and column.
 */
import { didYouMean } from '@aeye/gin';
import { CONTEXT_BODY_REFERENCE, isAgentPattern, qualify, type ContextFileProblem } from '@harness/core';
import { contextProblem, positionOf, readContextFolder, type ContextFile } from './context-files.ts';

/** The names a context folder may link to. */
export interface KnownNames {
  /** The system the folder belongs to: its keys are qualified with it. */
  readonly system: string;
  /** Fns it may link to, qualified (its own and others'). */
  readonly fns: ReadonlySet<string>;
  /** Context it may link to besides its own files, qualified (its contract's and others'). */
  readonly context: ReadonlySet<string>;
  /**
   * The agents (`hub/llm` fns) an `inject.into` may name exactly. Absent, any fn it may link to is taken; the hub
   * refuses one that is no agent when the system declares it.
   */
  readonly agents?: ReadonlySet<string>;
}

/** A checked folder: its files, and every problem in it. */
export interface CheckedContext {
  readonly files: readonly ContextFile[];
  readonly problems: readonly ContextFileProblem[];
}

/** One link a file makes, with the header key it is under (`undefined` for the body) and what it must name. */
interface FileLink {
  readonly to: string;
  readonly kind: 'fn' | 'context' | 'agent';
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
    ...fns('requires', header.inject?.requires ?? []),
    ...(header.inject?.into ?? []).filter((target) => !isAgentPattern(target)).map((to): FileLink => ({ to, kind: 'agent', key: 'into' })),
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
  for (const { line, number } of bodyLines(file)) {
    for (const match of line.matchAll(new RegExp(CONTEXT_BODY_REFERENCE.source, 'g'))) {
      const [, kind, to] = match;
      if ((kind === 'fn' || kind === 'context') && to !== undefined) { found.push({ to, kind, key: undefined, line: number, column: match.index + 1 }); }
    }
  }
  return found;
}

/** A file's body lines outside fenced code blocks, each with its 1-based line number in the file. */
function bodyLines(file: ContextFile): Array<{ line: string; number: number }> {
  const kept: Array<{ line: string; number: number }> = [];
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
    if (fence === undefined) { kept.push({ line, number: index + 1 }); }
  }
  return kept;
}

/** An explicit anchor: `<a id="x"></a>` (or `name`). */
const ANCHOR = /<a\s+(?:id|name)="([^"]+)"/g;
/** A markdown heading line. */
const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
/** An in-page anchor link, `[text](#anchor)`. */
const PAGE_ANCHOR = /\]\(#([^)\s]+)\)/g;
/** A context link with an anchor, `context:key#anchor`. */
const CONTEXT_ANCHOR = /\bcontext:([a-z][a-z0-9-]*\/[A-Za-z0-9_.-]*[A-Za-z0-9_])#([A-Za-z0-9_-]+)/g;

/** A heading's anchor, the way markdown renderers make one: lower case, punctuation dropped, spaces as dashes. */
export function headingAnchor(heading: string): string {
  return heading.replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}

/** The anchors a file has: its `<a id>`s and its headings'. */
function anchorsOf(file: ContextFile): Set<string> {
  const anchors = new Set<string>();
  for (const { line } of bodyLines(file)) {
    for (const match of line.matchAll(ANCHOR)) { if (match[1] !== undefined) { anchors.add(match[1]); } }
    const heading = HEADING.exec(line)?.[1];
    if (heading !== undefined) { anchors.add(headingAnchor(heading)); }
  }
  return anchors;
}

/** Anchor links in a file's body that name no anchor of their file: in-page ones, and ones into the folder's own files. */
function anchorProblems(file: ContextFile, own: ReadonlyMap<string, ContextFile>, anchors: (file: ContextFile) => ReadonlySet<string>): ContextFileProblem[] {
  const problems: ContextFileProblem[] = [];
  for (const { line, number } of bodyLines(file)) {
    for (const match of line.matchAll(PAGE_ANCHOR)) {
      const anchor = match[1];
      if (anchor !== undefined && !anchors(file).has(anchor)) {
        problems.push(contextProblem(file.file, number, match.index + 1, 'broken-link', `the body links to #${anchor}, which this file has no anchor or heading for${didYouMean(anchor, [...anchors(file)], { max: 2 })}`));
      }
    }
    for (const match of line.matchAll(CONTEXT_ANCHOR)) {
      const [, key, anchor] = match;
      const target = key === undefined ? undefined : own.get(key);
      if (target !== undefined && anchor !== undefined && !anchors(target).has(anchor)) {
        problems.push(contextProblem(file.file, number, match.index + 1, 'broken-link', `the body links to context:${key ?? ''}#${anchor}, which that file has no anchor or heading for${didYouMean(anchor, [...anchors(target)], { max: 2 })}`));
      }
    }
  }
  return problems;
}

/**
 * Every fn and context a context folder links to (header and body, not fenced code), each name once, so a build can ask
 * a hub's catalog about exactly those names instead of loading the catalog.
 */
export async function contextFolderLinks(dir: string): Promise<{ fns: string[]; context: string[] }> {
  const read = await readContextFolder(dir);
  const links = read.files.flatMap((file) => [...headerLinks(file), ...bodyLinks(file)]);
  const named = (...kinds: Array<FileLink['kind']>) => [...new Set(links.filter((link) => kinds.includes(link.kind)).map((link) => link.to))];
  return { fns: named('fn', 'agent'), context: named('context') };
}

/**
 * Check a system's context folder (`dir`, usually `<system>/context`): the SDK reader's checks, then every link and
 * every `imports` cycle. `label` names files in problems (default `context`).
 */
export async function checkContextFolder(dir: string, known: KnownNames, label?: string): Promise<CheckedContext> {
  const read = await readContextFolder(dir, label);
  const problems: ContextFileProblem[] = [...read.problems];
  const own = new Map(read.files.map((file) => [qualify(known.system, file.header.key), file]));
  const names = { fn: known.fns, context: new Set([...known.context, ...own.keys()]), agent: known.agents ?? known.fns };
  const anchorCache = new Map<ContextFile, Set<string>>();
  const anchors = (file: ContextFile): Set<string> => {
    const found = anchorCache.get(file) ?? anchorsOf(file);
    anchorCache.set(file, found);
    return found;
  };
  for (const file of read.files) {
    const links = [
      ...headerLinks(file).map((link) => ({ ...link, ...positionOf(file.source, link.to, link.key === undefined ? 1 : positionOf(file.source, `${link.key}:`).line) })),
      ...bodyLinks(file),
    ];
    for (const link of links) {
      if (names[link.kind].has(link.to)) { continue; }
      if (link.kind === 'agent') {
        problems.push(contextProblem(file.file, link.line, link.column, 'broken-link', `inject.into names ${link.to}, which is not an agent: name a hub/llm fn, or a pattern with *${didYouMean(link.to, [...names.agent], { max: 2 })}`));
        continue;
      }
      const where = link.key === undefined ? 'the body' : link.key;
      problems.push(contextProblem(file.file, link.line, link.column, 'broken-link', `${where} links to ${link.kind} ${link.to}, which doesn't exist${didYouMean(link.to, [...names[link.kind]], { max: 2 })}`));
    }
    problems.push(...anchorProblems(file, own, anchors));
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
