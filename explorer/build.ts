// Builds explorer/explorer.html from types/*.ts and docs/harness.md.
// Run: npm run explorer
//
// Every exported declaration in types/ becomes a page: its doc comment, type parameters, what it extends,
// its members (each with its own note box), what extends or implements it, which unions it belongs to,
// and where it is used. Type names inside signatures are links. docs/harness.md is rendered as the Guide,
// with `Code` spans that name a type linked to that type. Notes are kept in localStorage and exported as
// JSON (review/notes.json is where an exported file goes so the next session can read it).
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.join(import.meta.dirname, '..');
const typesDir = path.join(root, 'types');

interface Member { name: string; kind: 'prop' | 'method' | 'call' | 'index' | 'construct'; optional: boolean; readonly: boolean; type: string; doc: string; tags: Record<string, string> }
interface Decl {
  name: string; kind: 'interface' | 'type' | 'class' | 'function' | 'const';
  file: string; line: number; group: string; doc: string; tags: Record<string, string>;
  typeParams: string; extends: string[]; implements: string[]; alias?: string; members: Member[];
  unionOf: string[]; signature?: string; refs: string[];
}

// the SDK first: it is what station authors use; then the fs station, the hub, and the examples
const ORDER = ['sdk.ts', 'fs.ts', 'hub.ts', 'examples.ts'];
const rank = (f: string) => (ORDER.indexOf(f) + 1 || ORDER.length + 1);
const files = fs.readdirSync(typesDir).filter(f => f.endsWith('.ts')).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, root);
const program = ts.createProgram(cfg.fileNames, cfg.options);
const decls: Decl[] = [];
const external: Record<string, string> = {}; // imported name → module

const docOf = (node: ts.Node, sf: ts.SourceFile): { doc: string; tags: Record<string, string> } => {
  const jsDocs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc ?? [];
  const last = jsDocs[jsDocs.length - 1];
  if (!last) return { doc: '', tags: {} };
  const text = (c: ts.JSDoc['comment']): string => typeof c === 'string' ? c : (c ?? []).map(p => p.getText(sf)).join('');
  const tags: Record<string, string> = {};
  for (const t of last.tags ?? []) tags[t.tagName.text] = text(t.comment).trim();
  return { doc: text(last.comment).trim(), tags };
};

const clean = (s: string) => s.replace(/\r/g, '');

for (const f of files) {
  const sf = program.getSourceFile(path.join(typesDir, f));
  if (!sf) continue;
  // a file's title is its first line, `// # Title`; its banners become groups under that title
  const title = /^\/\/ # (.+)/.exec(sf.getFullText())?.[1] ?? f;
  let group = title;
  const full = sf.getFullText();
  for (const st of sf.statements) {
    // a section banner `// ═══ Name ═══` (in the leading comments) starts a group
    const lead = full.slice(st.getFullStart(), st.getStart(sf));
    for (const m of lead.matchAll(/\/\/\s*═+\s*(.+?)\s*═+/g)) group = `${title} · ${m[1]!}`;
    if (ts.isImportDeclaration(st)) {
      const mod = (st.moduleSpecifier as ts.StringLiteral).text;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) external[e.name.text] = mod;
      continue;
    }
    const exported = ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
    const { doc, tags } = docOf(st, sf);
    const tp = (n: { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }) => n.typeParameters ? `<${n.typeParameters.map(p => clean(p.getText(sf))).join(', ')}>` : '';
    const base = { file: f, line, group: tags.group ?? group, doc, tags, unionOf: [] as string[], refs: [] as string[], extends: [] as string[], implements: [] as string[], members: [] as Member[] };
    const membersOf = (ms: ts.NodeArray<ts.TypeElement | ts.ClassElement>): Member[] => ms.flatMap((m): Member[] => {
      const d = docOf(m, sf);
      const ro = ts.canHaveModifiers(m) && (ts.getModifiers(m) ?? []).some(x => x.kind === ts.SyntaxKind.ReadonlyKeyword);
      const nm = m.name ? clean(m.name.getText(sf)) : '';
      if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) return [{ name: nm, kind: 'prop', optional: !!m.questionToken, readonly: ro, type: m.type ? clean(m.type.getText(sf)) : 'unknown', doc: d.doc, tags: d.tags }];
      if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
        const sig = `${tp(m)}(${m.parameters.map(p => clean(p.getText(sf))).join(', ')}) => ${m.type ? clean(m.type.getText(sf)) : 'void'}`;
        return [{ name: nm, kind: 'method', optional: !!m.questionToken, readonly: false, type: sig, doc: d.doc, tags: d.tags }];
      }
      if (ts.isCallSignatureDeclaration(m)) return [{ name: '(call)', kind: 'call', optional: false, readonly: false, type: clean(m.getText(sf)), doc: d.doc, tags: d.tags }];
      if (ts.isConstructSignatureDeclaration(m)) return [{ name: '(new)', kind: 'construct', optional: false, readonly: false, type: clean(m.getText(sf)), doc: d.doc, tags: d.tags }];
      if (ts.isIndexSignatureDeclaration(m)) return [{ name: `[${m.parameters.map(p => clean(p.getText(sf))).join(', ')}]`, kind: 'index', optional: false, readonly: ro, type: clean(m.type.getText(sf)), doc: d.doc, tags: d.tags }];
      if (ts.isConstructorDeclaration(m)) return [{ name: 'constructor', kind: 'construct', optional: false, readonly: false, type: `(${m.parameters.map(p => clean(p.getText(sf))).join(', ')})`, doc: d.doc, tags: d.tags }];
      if (ts.isGetAccessorDeclaration(m)) return [{ name: nm, kind: 'prop', optional: false, readonly: true, type: m.type ? clean(m.type.getText(sf)) : 'unknown', doc: d.doc, tags: d.tags }];
      return [];
    });
    if (ts.isInterfaceDeclaration(st)) {
      decls.push({ ...base, name: st.name.text, kind: 'interface', typeParams: tp(st), extends: (st.heritageClauses ?? []).flatMap(h => h.types.map(t => clean(t.getText(sf)))), members: membersOf(st.members) });
    } else if (ts.isTypeAliasDeclaration(st)) {
      let t = st.type;
      const unionOf = ts.isUnionTypeNode(t) ? t.types.filter(ts.isTypeReferenceNode).map(x => x.typeName.getText(sf)) : [];
      const members = ts.isTypeLiteralNode(t) ? membersOf(t.members) : [];
      decls.push({ ...base, name: st.name.text, kind: 'type', typeParams: tp(st), alias: ts.isTypeLiteralNode(t) ? undefined : clean(t.getText(sf)), members, unionOf });
      void t;
    } else if (ts.isClassDeclaration(st) && st.name) {
      const ext = (st.heritageClauses ?? []).filter(h => h.token === ts.SyntaxKind.ExtendsKeyword).flatMap(h => h.types.map(t => clean(t.getText(sf))));
      const impl = (st.heritageClauses ?? []).filter(h => h.token === ts.SyntaxKind.ImplementsKeyword).flatMap(h => h.types.map(t => clean(t.getText(sf))));
      decls.push({ ...base, name: st.name.text, kind: 'class', typeParams: tp(st), extends: ext, implements: impl, members: membersOf(st.members) });
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      const sig = `${tp(st)}(${st.parameters.map(p => clean(p.getText(sf))).join(', ')}) => ${st.type ? clean(st.type.getText(sf)) : 'void'}`;
      decls.push({ ...base, name: st.name.text, kind: 'function', typeParams: '', signature: sig });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        decls.push({ ...base, name: d.name.getText(sf), kind: 'const', typeParams: '', signature: d.type ? clean(d.type.getText(sf)) : clean(d.initializer?.getText(sf) ?? '') });
      }
    }
  }
}

// references: every capitalised identifier in a decl's text that names a decl
const names = new Set(decls.map(d => d.name));
const idents = (s: string) => [...s.matchAll(/\b[A-Za-z_]\w*\b/g)].map(m => m[0]);
const usedBy: Record<string, string[]> = {};
for (const d of decls) {
  const texts: Array<[string, string]> = [
    ['extends', d.extends.join(' ')], ['implements', d.implements.join(' ')], ['', d.alias ?? ''], ['', d.signature ?? ''], ['<>', d.typeParams],
    ...d.members.map((m): [string, string] => [m.name, m.type]),
  ];
  const refs = new Set<string>();
  for (const [where, s] of texts) for (const n of idents(s)) if (n !== d.name && (names.has(n) || n in external)) {
    refs.add(n);
    (usedBy[n] ??= []).push(where ? `${d.name}.${where}` : d.name);
  }
  d.refs = [...refs];
}
for (const k of Object.keys(usedBy)) usedBy[k] = [...new Set(usedBy[k])];
const baseName = (s: string) => s.replace(/<.*$/s, '').trim();
const subtypes: Record<string, string[]> = {};
for (const d of decls) for (const e of [...d.extends, ...d.implements]) (subtypes[baseName(e)] ??= []).push(d.name);
const unions: Record<string, string[]> = {};
for (const d of decls) for (const u of d.unionOf) (unions[u] ??= []).push(d.name);

// groups in file order
const groups: string[] = [];
for (const d of decls) if (!groups.includes(d.group)) groups.push(d.group);

const guidePath = path.join(root, 'docs', 'harness.md');
const guide = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';

// the TypeScript compiler must agree the model is valid before we publish it
const diags = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
for (const d of diags.slice(0, 30)) {
  const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
  console.error(`${d.file ? path.basename(d.file.fileName) : ''}:${pos ? pos.line + 1 : ''} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}
if (diags.length) process.exitCode = 1;

const data = { generated: new Date().toISOString().slice(0, 16).replace('T', ' '), decls, groups, usedBy, subtypes, unions, external, guide };
const tpl = fs.readFileSync(path.join(import.meta.dirname, 'template.html'), 'utf8');
fs.writeFileSync(path.join(import.meta.dirname, 'explorer.html'), tpl.replace('/*DATA*/null', () => JSON.stringify(data).replace(/<\/script/g, '<\\/script')));
const counts = decls.reduce<Record<string, number>>((a, d) => ((a[d.kind] = (a[d.kind] ?? 0) + 1), a), {});
console.log(`${decls.length} declarations (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}) in ${groups.length} groups; ${diags.length} type errors`);
