/**
 * Reads a package's public API with the TypeScript compiler API: every export of its entry points with its TSDoc and
 * its declaration as TypeScript (signatures printed by the checker, interface and type alias bodies as written, class
 * members without bodies), the named types of other packages those declarations reach (core's records), and chosen
 * declarations of external modules (gin's type builder). The result is plain data for `compose.ts` to render.
 */
import { relative } from 'node:path';
import ts from 'typescript';

/** One entry point of the package being documented: how authors import it, and its source file. */
export interface EntryPoint {
  /** The import specifier: `@harness/sdk`, `@harness/sdk/server`. */
  readonly specifier: string;
  /** The absolute path of its source file. */
  readonly file: string;
}

/** Declarations to document from a module outside the package (the gin builder), by export name. */
export interface ExternalModule {
  readonly specifier: string;
  /** The file the specifier is resolved from. */
  readonly from: string;
  readonly names: readonly string[];
}

/** What a declaration is. One name can be several (a class is a value and a type; a schema is a const and a type). */
export type ApiKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum';

/** One documented declaration. */
export interface ApiItem {
  readonly name: string;
  /** Where it is imported from: the entry point's specifier, or the module that declares a reached type. */
  readonly module: string;
  readonly kinds: readonly ApiKind[];
  /** Its TSDoc: the summary, then any tags (`@example`, `@param`). Empty when it has none. */
  readonly docs: string;
  /** The declaration as TypeScript, without bodies. */
  readonly code: string;
  /** The declaring file, relative to the root, with forward slashes. */
  readonly file: string;
  /** Names of reached types (`ApiModel.reached`) its declaration refers to. */
  readonly reaches: readonly string[];
}

/** A package's documented API. */
export interface ApiModel {
  /** Every export of every entry point, in entry order and then declaration order. A name exported twice appears once. */
  readonly exports: readonly ApiItem[];
  /** Named types of the reached packages that the exports refer to (and that those refer to, to `reachDepth`), by name. */
  readonly reached: readonly ApiItem[];
  /** The external declarations asked for, in the order asked. */
  readonly external: readonly ApiItem[];
}

/** What to extract. */
export interface ExtractOptions {
  /** Paths in the result are relative to this folder. */
  readonly root: string;
  readonly entries: readonly EntryPoint[];
  readonly external?: readonly ExternalModule[];
  /** Whether types declared in this file are documented when an export refers to them. */
  readonly reach: (file: string) => boolean;
  /** How many steps of references to follow among reached types (1: only what exports name directly). */
  readonly reachDepth: number;
  /** Overrides of the compiler options (the defaults match `tsconfig.base.json`). */
  readonly compilerOptions?: ts.CompilerOptions;
}

/** The compiler options the repository builds with (`tsconfig.base.json`), for reading sources. */
export const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.dom.asynciterable.d.ts'],
  types: ['node'],
  strict: true,
  exactOptionalPropertyTypes: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  noEmit: true,
};

/** How the checker prints types and signatures: never truncated, aliases kept. */
const PRINT_FLAGS: ts.TypeFormatFlags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.WriteTypeArgumentsOfSignature;

const PRINTER = ts.createPrinter({ removeComments: true });

/** A const whose type prints longer than this is shown by its initializer instead. */
const LONG_TYPE = 320;
/** A const whose initializer is longer than this is shown by its type name only. */
const LONG_INITIALIZER = 2_400;

/** Forward slashes, so output is the same on every platform. */
function slash(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Whether a declaration is at the top level of its file (so it has a name authors can import). */
function isTopLevel(decl: ts.Declaration): boolean {
  // a module's own declaration (and globalThis's) is its source file, which has no parent
  if (ts.isSourceFile(decl)) { return false; }
  if (ts.isVariableDeclaration(decl)) { return ts.isSourceFile(decl.parent.parent.parent); }
  return ts.isSourceFile(decl.parent) || ts.isModuleBlock(decl.parent);
}

/** Drop `export`, `declare` and `default` from the front of a declaration's text. */
function stripModifiers(text: string): string {
  return text.replace(/^(?:export\s+)?(?:declare\s+)?(?:default\s+)?/, '');
}

/** Re-indent a block of text so its first non-empty line starts at column 0. */
function dedent(text: string): string {
  const lines = text.split('\n');
  const indents = lines.slice(1).filter((line) => line.trim() !== '').map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const cut = indents.length === 0 ? 0 : Math.min(...indents);
  return [lines[0] ?? '', ...lines.slice(1).map((line) => line.slice(Math.min(cut, /^\s*/.exec(line)?.[0].length ?? 0)))].join('\n');
}

/** Reads one program's exports. */
class ApiExtractor {
  readonly #program: ts.Program;
  readonly #checker: ts.TypeChecker;
  readonly #options: ExtractOptions;
  readonly #reached = new Map<string, { symbol: ts.Symbol; depth: number }>();

  constructor(options: ExtractOptions) {
    this.#options = options;
    const files = [...options.entries.map((e) => e.file), ...(options.external ?? []).map((e) => e.from)];
    this.#program = ts.createProgram(files, { ...DEFAULT_COMPILER_OPTIONS, ...options.compilerOptions });
    this.#checker = this.#program.getTypeChecker();
  }

  extract(): ApiModel {
    const seen = new Set<string>();
    const exports: ApiItem[] = [];
    for (const entry of this.#options.entries) {
      for (const symbol of this.#exportsOf(entry.file)) {
        if (seen.has(symbol.name)) { continue; }
        seen.add(symbol.name);
        exports.push(this.#item(symbol, entry.specifier, 1));
      }
    }
    const external = (this.#options.external ?? []).flatMap((ext) => this.#externalItems(ext));
    // follow references breadth-first, so depth counts steps from an export
    const reached: ApiItem[] = [];
    const done = new Set<string>();
    for (let depth = 1; depth <= this.#options.reachDepth; depth += 1) {
      for (const [name, { symbol, depth: at }] of [...this.#reached]) {
        if (at !== depth || done.has(name)) { continue; }
        done.add(name);
        reached.push(this.#item(symbol, this.#moduleOf(symbol), depth + 1));
      }
    }
    // a reached type the package exports itself is documented as an export, not again as reached
    const exported = new Set(exports.map((item) => item.name));
    const kept = reached.filter((item) => !exported.has(item.name));
    const known = new Set(kept.map((item) => item.name));
    const prune = (item: ApiItem): ApiItem => ({ ...item, reaches: item.reaches.filter((name) => known.has(name)) });
    return {
      exports: exports.map(prune),
      reached: kept.map(prune).sort((a, b) => a.name.localeCompare(b.name)),
      external: external.map(prune),
    };
  }

  /** The exports of a module, aliases resolved, in declaration order. */
  #exportsOf(file: string): ts.Symbol[] {
    const source = this.#program.getSourceFile(file);
    if (source === undefined) { throw new Error(`docs: ${file} is not in the program`); }
    const module = this.#checker.getSymbolAtLocation(source);
    if (module === undefined) { throw new Error(`docs: ${file} is not a module`); }
    return this.#checker.getExportsOfModule(module).filter((symbol) => symbol.name !== 'default');
  }

  #externalItems(ext: ExternalModule): ApiItem[] {
    const resolved = ts.resolveModuleName(ext.specifier, ext.from, this.#program.getCompilerOptions(), ts.sys).resolvedModule;
    if (resolved === undefined) { throw new Error(`docs: cannot resolve ${ext.specifier} from ${ext.from}`); }
    const symbols = new Map(this.#exportsOf(resolved.resolvedFileName).map((symbol) => [symbol.name, symbol]));
    return ext.names.map((name) => {
      const symbol = symbols.get(name);
      if (symbol === undefined) { throw new Error(`docs: ${ext.specifier} has no export ${name}`); }
      return this.#item(symbol, ext.specifier, Number.POSITIVE_INFINITY);
    });
  }

  #resolve(symbol: ts.Symbol): ts.Symbol {
    return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : this.#checker.getAliasedSymbol(symbol);
  }

  /** The module a reached declaration is imported from: its package's name when it has one, else its file. */
  #moduleOf(symbol: ts.Symbol): string {
    const file = symbol.declarations?.[0]?.getSourceFile().fileName ?? '';
    return slash(relative(this.#options.root, file));
  }

  /** One export as documentation; `depth` is how far references from it are still followed. */
  #item(exported: ts.Symbol, module: string, depth: number): ApiItem {
    const symbol = this.#resolve(exported);
    const decls = (symbol.declarations ?? []).filter(isTopLevel);
    if (decls.length === 0) { throw new Error(`docs: ${exported.name} has no top-level declaration`); }
    const kinds = new Set<ApiKind>();
    const parts: string[] = [];
    const typeAlias = decls.find(ts.isTypeAliasDeclaration);
    const schemaPair = typeAlias !== undefined && decls.some(ts.isVariableDeclaration);
    for (const decl of decls) {
      const printed = this.#print(exported.name, symbol, decl, schemaPair);
      if (printed === undefined) { continue; }
      kinds.add(printed.kind);
      if (printed.code !== '') { parts.push(printed.code); }
    }
    const reaches = new Set<string>();
    if (depth <= this.#options.reachDepth) {
      for (const decl of decls) { this.#collectReach(decl, reaches, depth); }
    }
    reaches.delete(exported.name);
    const file = decls[0]?.getSourceFile().fileName ?? '';
    return {
      name: exported.name,
      module,
      kinds: [...kinds],
      // sources may have Windows line ends; the output is the same on every platform
      docs: this.#docs(symbol, exported).replaceAll('\r\n', '\n'),
      code: parts.join('\n').replaceAll('\r\n', '\n'),
      file: slash(relative(this.#options.root, file)),
      reaches: [...reaches].sort(),
    };
  }

  /** TSDoc of a symbol, or of the export statement that re-exports it when the symbol has none. */
  #docs(symbol: ts.Symbol, exported: ts.Symbol): string {
    // an overloaded function's docs are its first signature's (each overload's are on its line in the code)
    const signatures = (symbol.flags & ts.SymbolFlags.Function) === 0 ? [] : this.#checker.getSignaturesOfType(this.#checker.getTypeOfSymbol(symbol), ts.SignatureKind.Call);
    const first = signatures[0];
    if (signatures.length > 1 && first !== undefined) { return ts.displayPartsToString(first.getDocumentationComment(this.#checker)).trim(); }
    const own = this.#docText(symbol);
    if (own !== '' || exported === symbol) { return own; }
    return this.#docText(exported);
  }

  #docText(symbol: ts.Symbol): string {
    const summary = ts.displayPartsToString(symbol.getDocumentationComment(this.#checker)).trim();
    const tags = symbol.getJsDocTags(this.#checker).map((tag) => {
      const text = ts.displayPartsToString(tag.text).trim();
      return text === '' ? `@${tag.name}` : `@${tag.name} ${text}`;
    });
    const docs = [summary, ...tags].filter((part) => part !== '').join('\n\n');
    // a re-export statement's comment is found on its export specifiers
    if (docs === '' && symbol.declarations?.[0] !== undefined && ts.isExportSpecifier(symbol.declarations[0])) {
      const statement = symbol.declarations[0].parent.parent;
      return ts.getJSDocCommentsAndTags(statement).map((doc) => (ts.isJSDoc(doc) ? ts.getTextOfJSDocComment(doc.comment) ?? '' : '')).join('\n').trim();
    }
    return docs;
  }

  /** One declaration as TypeScript. A const of a schema whose type has the same name is folded into the type. */
  #print(name: string, symbol: ts.Symbol, decl: ts.Declaration, schemaPair: boolean): { kind: ApiKind; code: string } | undefined {
    const source = decl.getSourceFile();
    if (ts.isFunctionDeclaration(decl)) {
      // overloads and the implementation are separate declarations; print the checker's signatures once
      if (symbol.declarations?.find(ts.isFunctionDeclaration) !== decl) { return { kind: 'function', code: '' }; }
      const signatures = this.#checker.getSignaturesOfType(this.#checker.getTypeOfSymbol(symbol), ts.SignatureKind.Call);
      // overloads each keep their own doc comment; the item's docs are the first one's
      const own = (sig: ts.Signature) => ts.displayPartsToString(sig.getDocumentationComment(this.#checker)).trim();
      return {
        kind: 'function',
        code: signatures.map((sig) => {
          const line = `function ${name}${this.#checker.signatureToString(sig, decl, PRINT_FLAGS)};`;
          return signatures.length > 1 && own(sig) !== '' ? `/** ${own(sig)} */\n${line}` : line;
        }).join('\n'),
      };
    }
    if (ts.isInterfaceDeclaration(decl)) { return { kind: 'interface', code: dedent(stripModifiers(decl.getText(source))) }; }
    if (ts.isEnumDeclaration(decl)) { return { kind: 'enum', code: dedent(stripModifiers(decl.getText(source))) }; }
    if (ts.isTypeAliasDeclaration(decl)) {
      const text = dedent(stripModifiers(decl.getText(source)));
      // a schema's type (`z.infer<typeof X>`) reads better resolved; a generic one can't be resolved
      if (decl.typeParameters === undefined && /\bz\.(?:infer|input|output)\b/.test(text)) {
        return { kind: 'type', code: `type ${name} = ${this.#printType(this.#checker.getTypeAtLocation(decl.type), decl)};` };
      }
      return { kind: 'type', code: text };
    }
    if (ts.isClassDeclaration(decl)) { return { kind: 'class', code: this.#printClass(name, decl) }; }
    if (ts.isVariableDeclaration(decl)) {
      if (schemaPair) { return { kind: 'const', code: '' }; }
      return { kind: 'const', code: this.#printConst(name, decl) };
    }
    if (ts.isModuleDeclaration(decl)) { return undefined; }
    throw new Error(`docs: ${name} is a ${ts.SyntaxKind[decl.kind]}, which the extractor does not print`);
  }

  /** A type in full, object literals over several lines. */
  #printType(type: ts.Type, at: ts.Node): string {
    const node = this.#checker.typeToTypeNode(type, at, ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.InTypeAlias | ts.NodeBuilderFlags.MultilineObjectLiterals | ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope);
    if (node === undefined) { return this.#checker.typeToString(type, at, PRINT_FLAGS); }
    return PRINTER.printNode(ts.EmitHint.Unspecified, node, at.getSourceFile()).replaceAll('    ', '  ');
  }

  #printConst(name: string, decl: ts.VariableDeclaration): string {
    const source = decl.getSourceFile();
    if (decl.type !== undefined) { return `const ${name}: ${decl.type.getText(source)};`; }
    const type = this.#checker.typeToString(this.#checker.getTypeAtLocation(decl.name), decl, PRINT_FLAGS);
    if (type.length <= LONG_TYPE) { return `const ${name}: ${type};`; }
    const init = decl.initializer?.getText(source);
    if (init !== undefined && init.length <= LONG_INITIALIZER) { return `const ${name} = ${dedent(init)};`; }
    return `const ${name}: typeof ${name}; // too large to print: see its section`;
  }

  #printClass(name: string, decl: ts.ClassDeclaration): string {
    const source = decl.getSourceFile();
    const params = decl.typeParameters === undefined ? '' : `<${decl.typeParameters.map((p) => p.getText(source)).join(', ')}>`;
    const heritage = (decl.heritageClauses ?? []).map((clause) => ` ${clause.getText(source)}`).join('');
    const abstract = ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract ? 'abstract ' : '';
    const lines = [`${abstract}class ${name}${params}${heritage} {`];
    const overloaded = new Set<string>();
    for (const member of decl.members) {
      if (ts.isMethodDeclaration(member) && member.body === undefined) { overloaded.add(member.name.getText(source)); }
    }
    for (const member of decl.members) {
      const printed = this.#printMember(member, overloaded);
      if (printed === undefined) { continue; }
      const docs = ts.getJSDocCommentsAndTags(member).filter(ts.isJSDoc).map((doc) => dedent(doc.getText(source)));
      for (const line of [...docs, printed].join('\n').split('\n')) { lines.push(`  ${line}`); }
    }
    lines.push('}');
    return lines.join('\n');
  }

  /** A class member without its body, or undefined when it is private. */
  #printMember(member: ts.ClassElement, overloaded: ReadonlySet<string>): string | undefined {
    const source = member.getSourceFile();
    const flags = ts.getCombinedModifierFlags(member);
    if ((flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0) { return undefined; }
    if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) { return undefined; }
    const prefix = [
      (flags & ts.ModifierFlags.Static) !== 0 ? 'static ' : '',
      (flags & ts.ModifierFlags.Abstract) !== 0 ? 'abstract ' : '',
      (flags & ts.ModifierFlags.Readonly) !== 0 ? 'readonly ' : '',
    ].join('');
    if (ts.isConstructorDeclaration(member)) {
      // with overloads, the implementation signature is not part of the surface
      const owner = member.parent;
      if (member.body !== undefined && ts.isClassLike(owner) && owner.members.some((m) => ts.isConstructorDeclaration(m) && m.body === undefined)) { return undefined; }
      return `constructor(${member.parameters.map((p) => p.getText(source)).join(', ')});`;
    }
    if (ts.isPropertyDeclaration(member)) {
      const type = member.type?.getText(source) ?? this.#checker.typeToString(this.#checker.getTypeAtLocation(member), member, PRINT_FLAGS);
      return `${prefix}${member.name.getText(source)}${member.questionToken === undefined ? '' : '?'}: ${type};`;
    }
    if (ts.isMethodDeclaration(member)) {
      const methodName = member.name.getText(source);
      if (member.body !== undefined && overloaded.has(methodName)) { return undefined; }
      const signature = this.#checker.getSignatureFromDeclaration(member);
      if (signature === undefined) { return undefined; }
      return `${prefix}${methodName}${this.#checker.signatureToString(signature, member, PRINT_FLAGS)};`;
    }
    if (ts.isGetAccessorDeclaration(member)) {
      const signature = this.#checker.getSignatureFromDeclaration(member);
      const type = signature === undefined ? 'unknown' : this.#checker.typeToString(signature.getReturnType(), member, PRINT_FLAGS);
      return `${prefix}get ${member.name.getText(source)}(): ${type};`;
    }
    return undefined;
  }

  /** Record the reachable named types a declaration refers to. */
  #collectReach(decl: ts.Declaration, into: Set<string>, depth: number): void {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const found = this.#checker.getSymbolAtLocation(node);
        if (found !== undefined) { this.#noteReached(this.#resolve(found), into, depth); }
      }
      // a body is implementation, not the surface an author sees
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && node.body !== undefined) {
        for (const child of [...node.parameters, ...(node.typeParameters ?? []), ...(node.type === undefined ? [] : [node.type])]) { visit(child); }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(decl);
  }

  #noteReached(symbol: ts.Symbol, into: Set<string>, depth: number): void {
    const decl = symbol.declarations?.find(isTopLevel);
    if (decl === undefined || !this.#options.reach(slash(decl.getSourceFile().fileName))) { return; }
    // functions and plain consts of the reached package are its code, not shapes an author writes
    const isShape = symbol.declarations?.some((d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isEnumDeclaration(d)) ?? false;
    if (!isShape) { return; }
    into.add(symbol.name);
    if (!this.#reached.has(symbol.name)) { this.#reached.set(symbol.name, { symbol, depth }); }
  }
}

/** Read a package's API. Throws when an entry point or an external name can't be found. */
export function extractApi(options: ExtractOptions): ApiModel {
  return new ApiExtractor(options).extract();
}
