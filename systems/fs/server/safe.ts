/**
 * The safe-command check: which `bash` command lines run without asking. A line is safe only when
 *
 * - it starts with one of the safe entries word for word (`ls`, `git status`),
 * - it has no chaining, redirects, substitution, variables, globs, brace lists or backslashes, which make the shell
 *   run or read something other than what the line spells out,
 * - every path-like word (each argument that isn't an option, and each option's `=` value) is inside the roots, as the
 *   path guard places it (links followed), and starts with no `~`,
 * - and its arguments fit the entry's shape (`SAFE_SHAPES`): some safe entries also have options that write files or
 *   run programs (`git diff --output`, `git branch -D`), and those ask.
 *
 * Anything else asks the person.
 */
import { tokenize, unknownWord } from './sensitive.ts';

/** Characters that chain, redirect, substitute, expand or escape: a line holding any is never safe. */
const UNSAFE_MARKS = /[;&|><`$\\*?[\]{}\n\r]/;

/**
 * What a safe entry's arguments may be: long options it refuses (a prefix of one is refused too, since git takes an
 * option's unambiguous start for the whole), short option letters it refuses (alone or bundled, as `-rD`), and
 * whether it takes arguments that aren't options at all.
 */
export interface CommandShape {
  readonly refused: readonly string[];
  readonly short?: string;
  readonly positionals?: false;
}

/** The options of git's diff, log and show that write a file or run a program from the config. */
const GIT_DIFF_REFUSED = ['--output', '--ext-diff', '--textconv'];

/** The shapes of the default safe entries that have options that write; entries not listed only need their paths inside. */
export const SAFE_SHAPES: Readonly<Record<string, CommandShape>> = {
  'git status': { refused: [] },
  'git diff': { refused: GIT_DIFF_REFUSED },
  'git log': { refused: GIT_DIFF_REFUSED },
  'git show': { refused: GIT_DIFF_REFUSED },
  // listing only: no creating, deleting, moving, copying or changing upstreams
  'git branch': {
    refused: ['--delete', '--move', '--copy', '--force', '--set-upstream', '--set-upstream-to', '--unset-upstream', '--track', '--no-track', '--edit-description', '--create-reflog', '--recurse-submodules'],
    short: 'dDfmMcCut',
    positionals: false,
  },
};

/** Whether a word is inside the roots, as the path guard places it from the folder the command runs in. */
export type InsideRoots = (word: string) => boolean;

/** Whether one option word is refused by a shape. */
function refusedOption(word: string, shape: CommandShape): boolean {
  if (word.startsWith('--')) {
    const name = word.split('=')[0] ?? word;
    return name.length > 2 && shape.refused.some((refused) => refused.startsWith(name));
  }
  const letters = word.slice(1);
  return Array.from(shape.short ?? '').some((letter) => letters.includes(letter));
}

/** Whether a command runs without asking under these safe entries. */
export function isSafe(command: string, safe: readonly string[], inside: InsideRoots, shapes: Readonly<Record<string, CommandShape>> = SAFE_SHAPES): boolean {
  if (UNSAFE_MARKS.test(command)) { return false; }
  const tokens = tokenize(command);
  if (tokens.some((token) => token.type !== 'word')) { return false; }
  const words = tokens.map((token) => token.text);
  return safe.some((entry) => {
    const head = entry.trim().split(/\s+/).filter((word) => word !== '');
    if (head.length === 0 || head.some((word, i) => words[i] !== word)) { return false; }
    const shape = shapes[head.join(' ')];
    let options = true;
    return words.slice(head.length).every((word) => {
      if (unknownWord(word)) { return false; }
      if (options && word === '--') { options = false; return true; }
      if (options && word.startsWith('-') && word !== '-') {
        if (shape !== undefined && refusedOption(word, shape)) { return false; }
        const value = word.startsWith('--') && word.includes('=') ? word.slice(word.indexOf('=') + 1) : undefined;
        return value === undefined || value === '' || inside(value);
      }
      if (shape?.positionals === false) { return false; }
      return inside(word);
    });
  });
}
