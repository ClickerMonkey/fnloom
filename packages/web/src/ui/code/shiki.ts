/**
 * Syntax highlighting with Shiki (`Highlighter`): TextMate grammars on Shiki's JavaScript regex engine (no wasm),
 * loaded the first time a language is drawn, with the engine itself loaded only then. Shiki's tokens are read by
 * scope into the app's token kinds and drawn as text spans like every highlighter's, never as HTML; the colours come
 * from the design tokens. Until a language's grammar has loaded, the built-in highlighter answers.
 */
import type { HighlighterCore, LanguageInput, ThemeRegistration, ThemedToken } from 'shiki/core';
import { BUILTIN_HIGHLIGHTER, type Highlighter, type Token, type TokenKind } from './highlighter.ts';

/** The theme Shiki tokenizes with: no colours of its own, since tokens are read by scope (`kindOf`). */
const SCOPES_ONLY: ThemeRegistration = { name: 'harness-scopes', type: 'light', fg: '#000000', bg: '#ffffff', settings: [] };

/** Scope prefixes, most specific first, and the token kind each draws as. */
const SCOPE_KINDS: ReadonlyArray<readonly [string, TokenKind]> = [
  ['comment', 'comment'],
  ['punctuation.definition.comment', 'comment'],
  ['string', 'string'],
  ['punctuation.definition.string', 'string'],
  ['constant.numeric', 'number'],
  ['constant.language', 'literal'],
  ['support.constant', 'literal'],
  ['constant.character', 'literal'],
  ['keyword.operator', 'plain'],
  ['keyword', 'keyword'],
  ['storage', 'keyword'],
];

/** The kind of a token from the scopes it matched (innermost last). */
export function kindOf(scopes: readonly string[]): TokenKind {
  for (const scope of [...scopes].reverse()) {
    const found = SCOPE_KINDS.find(([prefix]) => scope === prefix || scope.startsWith(`${prefix}.`));
    if (found !== undefined) { return found[1]; }
  }
  return 'plain';
}

/** Shiki's lines of tokens as one list of the app's tokens, neighbours of a kind merged, lines joined by newlines. */
export function tokensOf(lines: readonly (readonly ThemedToken[])[]): Token[] {
  const out: Token[] = [];
  const push = (kind: TokenKind, text: string): void => {
    const last = out.at(-1);
    if (last?.kind === kind) { out[out.length - 1] = { kind, text: last.text + text }; } else if (text !== '') { out.push({ kind, text }); }
  };
  lines.forEach((line, i) => {
    if (i > 0) { push('plain', '\n'); }
    for (const token of line) {
      // a token is what one colour covers; its explanation keeps the scoped parts, each drawn by its own kind
      if (token.explanation === undefined) { push('plain', token.content); continue; }
      for (const part of token.explanation) { push(kindOf(part.scopes.map((s) => s.scopeName)), part.content); }
    }
  });
  return out;
}

/** The part of Shiki's highlighter core the highlighter uses: loading a grammar and tokenizing with it. */
export type ShikiCore = Pick<HighlighterCore, 'codeToTokensBase' | 'loadLanguage'>;

/** What loads Shiki: its core with the JavaScript engine, and its grammars by name. An interface so tests use a fake. */
export interface ShikiLoader {
  /** The highlighter core, with no languages yet. */
  core(): Promise<ShikiCore>;
  /** The grammar loader of each language, by its name and its aliases. */
  languages(): Promise<ReadonlyMap<string, LanguageInput>>;
}

/** The real loader: Shiki's modules, imported the first time a language is asked for. */
export const BUNDLED_SHIKI: ShikiLoader = {
  async core() {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
    return createHighlighterCore({ themes: [SCOPES_ONLY], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  },
  async languages() {
    const { bundledLanguages, bundledLanguagesAlias } = await import('shiki/langs');
    return new Map<string, LanguageInput>([...Object.entries(bundledLanguagesAlias), ...Object.entries(bundledLanguages)]);
  },
};

/** Highlights with Shiki once a language's grammar is in, with the built-in highlighter until then. */
export class ShikiHighlighter implements Highlighter {
  readonly #loader: ShikiLoader;
  readonly #fallback: Highlighter;
  #core: Promise<ShikiCore> | undefined;
  #ready: ShikiCore | undefined;
  readonly #loading = new Map<string, Promise<boolean>>();
  readonly #loaded = new Set<string>();

  constructor(loader: ShikiLoader = BUNDLED_SHIKI, fallback: Highlighter = BUILTIN_HIGHLIGHTER) {
    this.#loader = loader;
    this.#fallback = fallback;
  }

  tokens(code: string, language: string): readonly Token[] {
    const core = this.#ready;
    if (core === undefined || !this.#loaded.has(language)) { return this.#fallback.tokens(code, language); }
    try {
      return tokensOf(core.codeToTokensBase(code, { lang: language, theme: SCOPES_ONLY.name ?? '', includeExplanation: 'scopeName' }));
    } catch {
      // Shiki tokenizes each line twice (scopes, then colours), each under its own time limit; when the first pass
      // stops early on a slow device its tokens run out before the second pass's do and Shiki throws. The built-in
      // highlighter answers for that draw instead.
      return this.#fallback.tokens(code, language);
    }
  }

  prepare(language: string): Promise<boolean> {
    if (this.#loaded.has(language)) { return Promise.resolve(false); }
    const known = this.#loading.get(language);
    if (known !== undefined) { return known; }
    const loading = this.#load(language).catch(() => false);
    this.#loading.set(language, loading);
    return loading;
  }

  knows(language: string): boolean {
    return this.#loaded.has(language) || this.#fallback.knows(language);
  }

  async #load(language: string): Promise<boolean> {
    const grammar = (await this.#loader.languages()).get(language);
    if (grammar === undefined) { return false; }
    this.#core ??= this.#loader.core();
    const core = await this.#core;
    await core.loadLanguage(grammar);
    this.#ready = core;
    this.#loaded.add(language);
    return true;
  }
}
