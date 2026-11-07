/**
 * A small syntax highlighter for code blocks: comments, strings, numbers, keywords and literals, for the languages an
 * agent shows most (TypeScript and JavaScript, Python, shell, JSON, YAML, CSS, HTML-ish, SQL, Go, Rust). It splits
 * code into tokens that `UiCodeBlock` draws as spans, as text (never HTML), so nothing in a block can inject markup.
 * An unknown language is drawn plain. Pure, so it is tested alone.
 */

/** How a piece of code is drawn. */
export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'literal';

/** One piece of code. */
export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

/** How one family of languages looks. */
interface Grammar {
  readonly line: readonly string[];
  readonly block?: readonly [string, string];
  readonly quotes: readonly string[];
  readonly keywords: ReadonlySet<string>;
  readonly literals: ReadonlySet<string>;
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(' '));

const C_LIKE = {
  line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'],
  keywords: words('abstract as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield fn func go impl match mod mut pub struct trait use where loop defer chan map range select'),
  literals: words('true false null undefined NaN Infinity nil None Some Ok Err self'),
} as const satisfies Grammar;

const JSON_GRAMMAR = { line: [], quotes: ['"'], keywords: words(''), literals: words('true false null') } as const satisfies Grammar;
const PYTHON = { line: ['#'], quotes: ['"', "'"], keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'), literals: words('True False None self') } as const satisfies Grammar;
const SHELL = { line: ['#'], quotes: ['"', "'"], keywords: words('if then else elif fi for while do done case esac in function return export local set unset echo cd exit'), literals: words('true false') } as const satisfies Grammar;
const YAML = { line: ['#'], quotes: ['"', "'"], keywords: words(''), literals: words('true false null yes no on off') } as const satisfies Grammar;
const CSS = { line: [], block: ['/*', '*/'], quotes: ['"', "'"], keywords: words('import media supports keyframes from to important'), literals: words('none auto inherit initial unset') } as const satisfies Grammar;
const SQL = { line: ['--'], block: ['/*', '*/'], quotes: ["'", '"'], keywords: words('select from where and or not insert into values update set delete create table index view join left right inner outer on group by order having limit offset as distinct union all primary key references drop alter'), literals: words('null true false') } as const satisfies Grammar;

/** Each language name (and its usual aliases) and its grammar. */
const GRAMMARS: Readonly<Record<string, Grammar>> = {
  ts: C_LIKE, typescript: C_LIKE, tsx: C_LIKE, js: C_LIKE, javascript: C_LIKE, jsx: C_LIKE, mjs: C_LIKE, vue: C_LIKE, go: C_LIKE, rust: C_LIKE, rs: C_LIKE,
  java: C_LIKE, c: C_LIKE, cpp: C_LIKE, cs: C_LIKE, swift: C_LIKE, kotlin: C_LIKE,
  json: JSON_GRAMMAR, jsonc: { ...JSON_GRAMMAR, line: ['//'], block: ['/*', '*/'] },
  py: PYTHON, python: PYTHON, sh: SHELL, bash: SHELL, shell: SHELL, zsh: SHELL, console: SHELL, yaml: YAML, yml: YAML, css: CSS, scss: CSS, sql: SQL,
};

/** Whether a language is one the highlighter knows. */
export function knowsLanguage(language: string): boolean {
  return GRAMMARS[language.toLowerCase()] !== undefined;
}

const WORD = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/i;

/** Split code into tokens for its language; plain text when the language is unknown. */
export function highlight(code: string, language: string): Token[] {
  const grammar = GRAMMARS[language.toLowerCase()];
  if (grammar === undefined) { return [{ kind: 'plain', text: code }]; }
  const out: Token[] = [];
  const push = (kind: TokenKind, text: string): void => {
    const last = out.at(-1);
    if (last !== undefined && last.kind === kind) { out[out.length - 1] = { kind, text: last.text + text }; } else { out.push({ kind, text }); }
  };
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    const line = grammar.line.find((start) => rest.startsWith(start) && (start !== '#' || i === 0 || /\s/.test(code[i - 1] ?? ' ')));
    if (line !== undefined) {
      const end = rest.indexOf('\n');
      const text = end === -1 ? rest : rest.slice(0, end);
      push('comment', text);
      i += text.length;
      continue;
    }
    if (grammar.block !== undefined && rest.startsWith(grammar.block[0])) {
      const end = rest.indexOf(grammar.block[1], grammar.block[0].length);
      const text = end === -1 ? rest : rest.slice(0, end + grammar.block[1].length);
      push('comment', text);
      i += text.length;
      continue;
    }
    const quote = grammar.quotes.find((q) => rest.startsWith(q));
    if (quote !== undefined) {
      let j = quote.length;
      while (j < rest.length && !rest.startsWith(quote, j) && (quote === '`' || rest[j] !== '\n')) { j += rest[j] === '\\' ? 2 : 1; }
      const text = rest.slice(0, Math.min(rest.length, j + quote.length));
      push('string', text);
      i += text.length;
      continue;
    }
    const number = /[\w$]/.test(code[i - 1] ?? ' ') ? undefined : NUMBER.exec(rest)?.[0];
    if (number !== undefined) { push('number', number); i += number.length; continue; }
    const word = WORD.exec(rest)?.[0];
    if (word !== undefined) {
      const lower = grammar === SQL ? word.toLowerCase() : word;
      push(grammar.keywords.has(lower) ? 'keyword' : grammar.literals.has(lower) ? 'literal' : 'plain', word);
      i += word.length;
      continue;
    }
    push('plain', code[i] ?? '');
    i++;
  }
  return out;
}
