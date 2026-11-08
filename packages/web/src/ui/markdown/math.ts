/**
 * TeX math for markdown, drawn as MathML (which browsers lay out themselves), built as a tree and rendered as
 * elements, never as HTML text. It reads the TeX people write in notes and answers: letters, numbers and operators,
 * groups, superscripts and subscripts, `\frac`, `\sqrt` (with an index), Greek letters and the common symbols,
 * `\text` and `\mathrm`, `\left` / `\right` delimiters, spacing, named functions (`\sin`, `\log`, `\lim`), big
 * operators (`\sum`, `\int`) with limits, `\overline`, `\hat` and `\vec`, and matrices (`\begin{matrix}` and its
 * bracketed kinds). A command it doesn't know is shown as its name, marked, so nothing is lost. Pure, so it is tested
 * alone.
 */

/** A MathML element: its tag, attributes and children, or its text. */
export type MathNode =
  | { readonly tag: MathTag; readonly attrs?: Readonly<Record<string, string>>; readonly children: readonly MathNode[] }
  | { readonly tag: MathLeaf; readonly attrs?: Readonly<Record<string, string>>; readonly text: string };

/** The MathML elements with children. */
export type MathTag = 'mrow' | 'mfrac' | 'msqrt' | 'mroot' | 'msup' | 'msub' | 'msubsup' | 'munderover' | 'munder' | 'mover' | 'mtable' | 'mtr' | 'mtd';
/** The MathML elements holding text. */
export type MathLeaf = 'mi' | 'mn' | 'mo' | 'mtext' | 'mspace';

const GREEK: Readonly<Record<string, string>> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const OPERATORS: Readonly<Record<string, string>> = {
  cdot: '⋅', times: '×', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝',
  infty: '∞', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦',
  partial: '∂', nabla: '∇', in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅',
  forall: '∀', exists: '∃', neg: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', circ: '∘', star: '⋆',
  ast: '∗', prime: '′', angle: '∠', perp: '⊥', parallel: '∥', mid: '∣', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  lbrace: '{', rbrace: '}', vert: '|', Vert: '‖', backslash: '\\', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', degree: '°',
};

/** Big operators: drawn with limits above and below in a display formula. */
const BIG: Readonly<Record<string, string>> = { sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃', bigcap: '⋂' };

/** Named functions, drawn upright. */
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'deg', 'dim', 'ker', 'arg', 'Pr']);

/** Functions whose limits go under them in a display formula. */
const LIMIT_FUNCTIONS = new Set(['lim', 'max', 'min', 'sup', 'inf']);

const SPACES: Readonly<Record<string, string>> = { ',': '0.17em', ':': '0.22em', ';': '0.28em', ' ': '0.25em', quad: '1em', qquad: '2em', '!': '0em' };

const ACCENTS: Readonly<Record<string, string>> = { hat: '^', bar: '¯', overline: '¯', vec: '→', dot: '˙', ddot: '¨', tilde: '~', widehat: '^', widetilde: '~' };

/** The delimiters a matrix kind is wrapped in. */
const MATRICES: Readonly<Record<string, readonly [string, string]>> = { matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{', ''] };

const OPERATOR_CHARS = new Set('+-=<>()[]|,;:!/*.?\'');

const row = (children: readonly MathNode[]): MathNode => (children.length === 1 && children[0] !== undefined ? children[0] : { tag: 'mrow', children });

/** Reads TeX left to right into MathML nodes. */
class TexReader {
  readonly #src: string;
  readonly #display: boolean;
  #at = 0;

  constructor(src: string, display: boolean) {
    this.#src = src;
    this.#display = display;
  }

  /** Read until the end, or until `stop` (a closing brace, `\right`, `&`, `\\` or `\end`). */
  list(stop?: (reader: TexReader) => boolean): MathNode[] {
    const out: MathNode[] = [];
    while (this.#at < this.#src.length) {
      this.#skipSpace();
      if (this.#at >= this.#src.length || (stop?.(this) ?? false)) { break; }
      const atom = this.#atom();
      if (atom === undefined) { continue; }
      out.push(this.#scripts(atom));
    }
    return out;
  }

  peek(text: string): boolean {
    return this.#src.startsWith(text, this.#at);
  }

  #skipSpace(): void {
    while (/\s/.test(this.#src[this.#at] ?? '')) { this.#at++; }
  }

  /** `^` and `_` after an atom. */
  #scripts(base: MathNode): MathNode {
    let sup: MathNode | undefined;
    let sub: MathNode | undefined;
    for (;;) {
      this.#skipSpace();
      const ch = this.#src[this.#at];
      if (ch === '^' && sup === undefined) { this.#at++; sup = this.#argument(); continue; }
      if (ch === '_' && sub === undefined) { this.#at++; sub = this.#argument(); continue; }
      if (ch === '\'' ) { this.#at++; sup = row([...(sup === undefined ? [] : [sup]), { tag: 'mo', text: '′' }]); continue; }
      break;
    }
    if (sup === undefined && sub === undefined) { return base; }
    const limits = this.#display && 'attrs' in base && base.attrs['data-limits'] === 'true';
    if (sub !== undefined && sup !== undefined) { return { tag: limits ? 'munderover' : 'msubsup', children: [base, sub, sup] }; }
    if (sub !== undefined) { return { tag: limits ? 'munder' : 'msub', children: [base, sub] }; }
    return { tag: limits ? 'mover' : 'msup', children: [base, sup ?? row([])] };
  }

  /** A command's or a script's argument: a group in braces, or one atom. */
  #argument(): MathNode {
    this.#skipSpace();
    if (this.#src[this.#at] === '{') { return this.#group(); }
    return this.#atom() ?? row([]);
  }

  /** `{ … }`. */
  #group(): MathNode {
    this.#at++;
    const inner = this.list((r) => r.peek('}'));
    if (this.#src[this.#at] === '}') { this.#at++; }
    return row(inner);
  }

  /** Text in braces as written (`\text{…}`). */
  #rawGroup(): string {
    this.#skipSpace();
    if (this.#src[this.#at] !== '{') { return ''; }
    let depth = 0;
    const start = this.#at + 1;
    for (; this.#at < this.#src.length; this.#at++) {
      const ch = this.#src[this.#at];
      if (ch === '{') { depth++; }
      if (ch === '}') { depth--; if (depth === 0) { break; } }
    }
    const text = this.#src.slice(start, this.#at);
    this.#at++;
    return text;
  }

  #atom(): MathNode | undefined {
    const ch = this.#src[this.#at] ?? '';
    if (ch === '{') { return this.#group(); }
    if (ch === '}') { this.#at++; return undefined; }
    if (ch === '\\') { return this.#command(); }
    if (ch === '&') { this.#at++; return undefined; }
    if (/[0-9.]/.test(ch)) {
      const number = /^\d*\.?\d+|^\d+/.exec(this.#src.slice(this.#at))?.[0] ?? ch;
      this.#at += number.length;
      return { tag: 'mn', text: number };
    }
    this.#at++;
    if (/\p{L}/u.test(ch)) { return { tag: 'mi', text: ch }; }
    if (OPERATOR_CHARS.has(ch)) { return { tag: 'mo', text: ch === '-' ? '−' : ch === '*' ? '∗' : ch }; }
    return { tag: 'mo', text: ch };
  }

  #command(): MathNode | undefined {
    this.#at++;
    const symbol = this.#src[this.#at] ?? '';
    if (!/[A-Za-z]/.test(symbol)) {
      this.#at++;
      if (symbol === '\\') { return undefined; }
      const space = SPACES[symbol];
      if (space !== undefined) { return { tag: 'mspace', attrs: { width: space }, text: '' }; }
      return { tag: 'mo', text: symbol };
    }
    const name = /^[A-Za-z]+/.exec(this.#src.slice(this.#at))?.[0] ?? '';
    this.#at += name.length;
    const greek = GREEK[name];
    if (greek !== undefined) { return { tag: 'mi', attrs: name[0] === name[0]?.toUpperCase() ? { mathvariant: 'normal' } : {}, text: greek }; }
    const operator = OPERATORS[name];
    if (operator !== undefined) { return { tag: 'mo', text: operator }; }
    const big = BIG[name];
    if (big !== undefined) { return { tag: 'mo', attrs: { largeop: 'true', 'data-limits': name.includes('int') ? 'false' : 'true' }, text: big }; }
    if (FUNCTIONS.has(name)) { return { tag: 'mi', attrs: { mathvariant: 'normal', 'data-limits': LIMIT_FUNCTIONS.has(name) ? 'true' : 'false' }, text: name }; }
    const space = SPACES[name];
    if (space !== undefined) { return { tag: 'mspace', attrs: { width: space }, text: '' }; }
    const accent = ACCENTS[name];
    if (accent !== undefined) { return { tag: 'mover', attrs: { accent: 'true' }, children: [this.#argument(), { tag: 'mo', text: accent }] }; }
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': { const top = this.#argument(); return { tag: 'mfrac', children: [top, this.#argument()] }; }
      case 'binom': { const top = this.#argument(); const bottom = this.#argument(); return row([{ tag: 'mo', text: '(' }, { tag: 'mfrac', attrs: { linethickness: '0' }, children: [top, bottom] }, { tag: 'mo', text: ')' }]); }
      case 'sqrt': {
        this.#skipSpace();
        if (this.#src[this.#at] === '[') {
          const close = this.#src.indexOf(']', this.#at);
          const index = new TexReader(this.#src.slice(this.#at + 1, close === -1 ? undefined : close), false).list();
          this.#at = close === -1 ? this.#src.length : close + 1;
          return { tag: 'mroot', children: [this.#argument(), row(index)] };
        }
        return { tag: 'msqrt', children: [this.#argument()] };
      }
      case 'text': case 'textrm': case 'mbox': case 'operatorname': return { tag: name === 'operatorname' ? 'mi' : 'mtext', ...(name === 'operatorname' ? { attrs: { mathvariant: 'normal' } } : {}), text: this.#rawGroup() };
      case 'mathrm': case 'mathbf': case 'mathit': case 'mathbb': case 'mathcal': {
        const variant = { mathrm: 'normal', mathbf: 'bold', mathit: 'italic', mathbb: 'double-struck', mathcal: 'script' }[name];
        return { tag: 'mi', attrs: { mathvariant: variant }, text: this.#rawGroup() };
      }
      case 'left': case 'right': case 'big': case 'Big': case 'bigg': case 'Bigg': {
        this.#skipSpace();
        const delimiter = this.#atom();
        return delimiter !== undefined && 'text' in delimiter ? { tag: 'mo', attrs: { stretchy: 'true' }, text: delimiter.text === '.' ? '' : delimiter.text } : undefined;
      }
      case 'begin': return this.#environment(this.#rawGroup());
      case 'end': this.#rawGroup(); return undefined;
      default: return { tag: 'mtext', attrs: { class: 'md-math-unknown' }, text: `\\${name}` };
    }
  }

  /** A matrix environment: rows split by `\\`, cells by `&`, wrapped in its kind's delimiters. */
  #environment(kind: string): MathNode {
    const rows: MathNode[][] = [];
    let cells: MathNode[] = [];
    const endsCell = (r: TexReader): boolean => r.peek('&') || r.peek('\\\\') || r.peek('\\end');
    while (this.#at < this.#src.length) {
      cells.push(row(this.list(endsCell)));
      if (this.peek('&')) { this.#at++; continue; }
      rows.push(cells);
      cells = [];
      if (this.peek('\\\\')) { this.#at += 2; continue; }
      if (this.peek('\\end')) { this.#at += 4; this.#rawGroup(); }
      break;
    }
    const table: MathNode = { tag: 'mtable', children: rows.map((cellsOfRow) => ({ tag: 'mtr', children: cellsOfRow.map((cell) => ({ tag: 'mtd', children: [cell] })) })) };
    const [open, close] = MATRICES[kind] ?? ['', ''];
    return row([...(open === '' ? [] : [{ tag: 'mo', text: open } satisfies MathNode]), table, ...(close === '' ? [] : [{ tag: 'mo', text: close } satisfies MathNode])]);
  }
}

/** TeX as a MathML tree: the children of the `math` element. `display` draws big operators with limits. */
export function texToMath(tex: string, display = false): MathNode[] {
  return new TexReader(tex, display).list();
}

/** The attributes a node is drawn with (the reader's own marks, such as where limits go, are left out). */
export function mathAttrs(node: MathNode): Readonly<Record<string, string>> {
  const attrs = node.attrs ?? {};
  return Object.fromEntries(Object.entries(attrs).filter(([key]) => !key.startsWith('data-')));
}
