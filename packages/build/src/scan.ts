/**
 * The scan of a built server bundle, for whoever approves running it: a report, not a guarantee. It reads the bundle
 * with the TypeScript parser and lists the Node built-ins it imports (the risky ones as concerns), imports and requires
 * whose target isn't a literal, `eval` and `new Function`, and the literal URLs and hosts it holds, each with its line,
 * plus the bundle's size.
 */
import { builtinModules } from 'node:module';
import ts from 'typescript';
import type { ScanConcern, ScanConcernKind, ScanReport } from '@harness/core';

/** Built-ins that reach past the process's own data: processes, the network, other threads, code from text, the disk. */
export const RISKY_BUILTINS = ['child_process', 'cluster', 'dgram', 'dns', 'fs', 'http', 'http2', 'https', 'net', 'tls', 'vm', 'worker_threads'] as const;

// The report's shapes are core's (build 7), so the install card and the review page read them too.
export { SCAN_CONCERNS, ScanConcern, ScanConcernKind, ScanReport } from '@harness/core';

const BUILTINS: ReadonlySet<string> = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const RISKY: ReadonlySet<string> = new Set(RISKY_BUILTINS);
const URL_PATTERN = /\bhttps?:\/\/[^\s'"`<>()\\]+/g;
/** The most characters of a line of concern kept in the report. */
const CODE_CHARS = 160;

/** A module name as a built-in (`node:fs/promises` → `fs/promises`), when it is one. */
function builtinOf(specifier: string): string | undefined {
  const name = specifier.replace(/^node:/, '');
  return BUILTINS.has(name) || BUILTINS.has(name.split('/')[0] ?? '') ? name : undefined;
}

/** Scan a bundle's code. */
export function scanBundle(code: string): ScanReport {
  const source = ts.createSourceFile('bundle.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lines = code.split(/\r?\n/);
  const builtins = new Set<string>();
  const urls = new Set<string>();
  const concerns: ScanConcern[] = [];
  const concern = (node: ts.Node, kind: ScanConcernKind, detail: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    concerns.push({ kind, line, detail, code: (lines[line - 1] ?? '').trim().slice(0, CODE_CHARS) });
  };
  const moduleUse = (node: ts.Node, specifier: string): void => {
    const builtin = builtinOf(specifier);
    if (builtin === undefined) { return; }
    builtins.add(builtin);
    if (RISKY.has(builtin.split('/')[0] ?? '')) { concern(node, 'builtin', builtin); }
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      moduleUse(node, node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const literal = first !== undefined && ts.isStringLiteralLike(first) ? first.text : undefined;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (literal === undefined) { concern(node, 'dynamic-import', 'import() of a computed name'); } else { moduleUse(node, literal); }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        if (literal === undefined) { concern(node, 'dynamic-require', 'require() of a computed name'); } else { moduleUse(node, literal); }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
        concern(node, 'eval', 'eval()');
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      concern(node, 'new-function', 'new Function()');
    } else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const match of node.text.matchAll(URL_PATTERN)) { urls.add(match[0]); }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host);
    } catch {
      // not a URL after all (a template fragment)
    }
  }
  return {
    size: Buffer.byteLength(code, 'utf8'),
    builtins: [...builtins].sort(),
    concerns,
    urls: [...urls].sort(),
    hosts: [...hosts].sort(),
  };
}
