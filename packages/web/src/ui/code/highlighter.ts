/**
 * Syntax highlighting behind one interface, so the engine can change without a component noticing. A highlighter
 * splits code into tokens (`TokenKind` and text) that code blocks draw as spans, as text, never as HTML, so nothing
 * in the code can inject markup. `prepare` loads what a language needs (a grammar engine loads grammars lazily);
 * until it resolves, `tokens` answers with what it has, so a block draws at once and sharpens when the grammar
 * arrives.
 *
 * The built-in highlighter (`ui/markdown/highlight.ts`) is synchronous and knows about a dozen language families. An
 * app with a grammar engine (Shiki) provides its own under `HIGHLIGHTER`.
 */
import { computed, inject, shallowRef, watch, type ComputedRef, type InjectionKey } from 'vue';
import { highlight, knowsLanguage, type Token } from '../markdown/highlight.ts';

export type { Token, TokenKind } from '../markdown/highlight.ts';

/** A syntax highlighter. */
export interface Highlighter {
  /** The tokens of `code` in `language` with what is loaded now (plain text for a language it doesn't know). */
  tokens(code: string, language: string): readonly Token[];
  /** Load what `language` needs; resolves true when `tokens` would now answer better than before. */
  prepare(language: string): Promise<boolean>;
  /** Whether it can colour `language` (once prepared). */
  knows(language: string): boolean;
}

/** The built-in highlighter: synchronous, keyword-level, for the languages an agent shows most. */
export class BuiltinHighlighter implements Highlighter {
  tokens(code: string, language: string): readonly Token[] {
    return highlight(code, language);
  }

  prepare(): Promise<boolean> {
    return Promise.resolve(false);
  }

  knows(language: string): boolean {
    return knowsLanguage(language);
  }
}

/** Where code blocks find the app's highlighter. */
export const HIGHLIGHTER: InjectionKey<Highlighter> = Symbol('harness.highlighter');

/** The highlighter used when the app provides none. */
export const BUILTIN_HIGHLIGHTER: Highlighter = new BuiltinHighlighter();

/**
 * Tokens for code that change with it, from the provided highlighter: drawn at once with what is loaded, and again
 * once the language's grammar has loaded.
 */
export function useTokens(code: () => string, language: () => string): ComputedRef<readonly Token[]> {
  const highlighter = inject(HIGHLIGHTER, BUILTIN_HIGHLIGHTER);
  const loaded = shallowRef(0);
  watch(language, (lang) => {
    void highlighter.prepare(lang).then((better) => { if (better) { loaded.value++; } }, () => undefined);
  }, { immediate: true });
  // `loaded` is read so the tokens are made again once a grammar arrives
  return computed(() => (loaded.value >= 0 ? highlighter.tokens(code(), language()) : []));
}

/** The tokens of each line, for code drawn with line numbers: a token that spans lines (a block comment) is split. */
export function tokenLines(tokens: readonly Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) { lines.push([]); }
      if (part !== '') { lines.at(-1)?.push({ kind: token.kind, text: part }); }
    });
  }
  if (lines.length > 1 && lines.at(-1)?.length === 0) { lines.pop(); }
  return lines;
}
