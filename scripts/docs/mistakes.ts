/**
 * The mistakes that must not compile, read from the SDK's compile-time tests (`packages/sdk/typetests`): each
 * `// @ts-expect-error <why>` comment and the code under it that the compiler refuses. `npm run typecheck` proves each
 * still fails, so the list in the guide is always true.
 */
import { fence } from './compose.ts';

/** One refused mistake: why it is refused, and the code. */
export interface Mistake {
  readonly why: string;
  readonly code: string;
  /** The file it was read from, relative to the repository. */
  readonly file: string;
}

const EXPECT_ERROR = /^(\s*)\/\/\s*@ts-expect-error\s*(.*)$/;

/**
 * The mistakes in one source file. The code is the statement under the comment: the next line, and the lines after it
 * that are indented deeper (the rest of a multi-line call), up to the first line back at the comment's indent.
 */
export function mistakesIn(source: string, file: string): Mistake[] {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const found: Mistake[] = [];
  lines.forEach((line, index) => {
    const match = EXPECT_ERROR.exec(line);
    if (match === null) { return; }
    const indent = match[1]?.length ?? 0;
    const why = (match[2] ?? '').trim();
    // plain comment lines just above explain the setting; keep them with the code
    const notes: string[] = [];
    for (let at = index - 1; at >= 0; at -= 1) {
      const above = lines[at] ?? '';
      if (!/^\s*\/\/(?!\s*@ts-expect-error)/.test(above) || (/^\s*/.exec(above)?.[0].length ?? 0) !== indent) { break; }
      notes.unshift(above);
    }
    const statement: string[] = [];
    for (const next of lines.slice(index + 1)) {
      const nextIndent = /^\s*/.exec(next)?.[0].length ?? 0;
      if (statement.length > 0 && (next.trim() === '' || nextIndent <= indent)) {
        // a closing bracket at the comment's indent still belongs to the statement
        if (/^\s*[)\]}]/.test(next) && nextIndent === indent) { statement.push(next); }
        break;
      }
      if (EXPECT_ERROR.test(next)) { break; }
      statement.push(next);
    }
    const code = [...notes, ...statement];
    found.push({ why: why === '' ? 'refused by the compiler' : why, code: code.map((l) => l.slice(Math.min(indent, /^\s*/.exec(l)?.[0].length ?? 0))).join('\n'), file });
  });
  return found;
}

/** The mistakes as a markdown list, grouped by file in the order given. */
export function renderMistakes(mistakes: readonly Mistake[]): string {
  return mistakes.map((m) => `- **${m.why.replace(/^./, (c) => c.toUpperCase())}.**\n\n${fence(m.code, 'ts').split('\n').map((l) => `  ${l}`).join('\n')}`).join('\n');
}
