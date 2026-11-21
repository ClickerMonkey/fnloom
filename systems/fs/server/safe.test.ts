import { describe, expect, it } from 'vitest';
import { fsEnv } from './env.ts';
import { isSafe } from './safe.ts';

/** Every word is inside the roots, except those starting `..` or `/etc`. */
const inside = (word: string) => !word.startsWith('..') && !word.startsWith('/etc');
const DEFAULT_SAFE = fsEnv.parse().FS_SAFE_COMMANDS;

describe('isSafe', () => {
  const safe = ['ls', 'git status', 'cat'];
  it('accepts a safe entry alone or with arguments inside the roots', () => {
    expect(isSafe('ls', safe, inside)).toBe(true);
    expect(isSafe('  ls -la src ', safe, inside)).toBe(true);
    expect(isSafe('git status --short', safe, inside)).toBe(true);
    expect(isSafe('cat "docs/a b.md"', safe, inside)).toBe(true);
  });

  it('refuses lookalikes and anything that chains, pipes, redirects or substitutes', () => {
    expect(isSafe('lsof', safe, inside)).toBe(false);
    expect(isSafe('git statusx', safe, inside)).toBe(false);
    for (const line of ['ls; rm -rf .', 'ls && rm x', 'ls | sh', 'ls > out', 'ls `rm x`', 'ls $(rm x)', 'ls\nrm x', 'ls & rm x']) {
      expect(isSafe(line, safe, inside)).toBe(false);
    }
    expect(isSafe('ls', [], inside)).toBe(false);
  });

  it('refuses paths outside the roots, as arguments or option values', () => {
    expect(isSafe('cat ../../.ssh/id_rsa', safe, inside)).toBe(false);
    expect(isSafe('cat /etc/passwd', safe, inside)).toBe(false);
    expect(isSafe('ls --hide=/etc/x', safe, inside)).toBe(false);
  });

  it('refuses variables, ~, globs, brace lists and backslashes, whose path the line doesn\'t spell', () => {
    for (const line of ['cat $PWD/.env', 'cat "$HOME/.aws/credentials"', 'cat ~/.ssh/id_rsa', 'ls --dir=~/x', 'cat .en?', 'cat *.pem', 'cat [.]env', 'cat {a,/etc/passwd}', 'cat \\.env']) {
      expect(isSafe(line, safe, inside)).toBe(false);
    }
    // `~` mid-word is no home: git's HEAD~1
    expect(isSafe('git status HEAD~1', safe, inside)).toBe(true);
  });

  it('runs no echo, test runner or type checker by default', () => {
    for (const line of ['echo $OPENROUTER_API_KEY', 'echo hi', 'npm test', 'npx vitest', 'npx tsc', 'npm run typecheck']) {
      expect(isSafe(line, DEFAULT_SAFE, inside)).toBe(false);
    }
  });

  it('lets git diff, log and show read but not write a file or run a diff program', () => {
    for (const line of ['git diff', 'git diff --stat HEAD~2', 'git log -3 --format=%h', 'git show HEAD:src/a.ts', 'git log --no-ext-diff', 'git diff -- src']) {
      expect(isSafe(line, DEFAULT_SAFE, inside)).toBe(true);
    }
    for (const line of ['git diff --output=out.txt', 'git diff --out=x', 'git log -p --output x', 'git show --ext-diff', 'git diff --textconv', 'git log --ext']) {
      expect(isSafe(line, DEFAULT_SAFE, inside)).toBe(false);
    }
  });

  it('lets git branch list, and nothing else', () => {
    for (const line of ['git branch', 'git branch -a', 'git branch -vv', 'git branch --show-current', 'git branch --contains=HEAD']) {
      expect(isSafe(line, DEFAULT_SAFE, inside)).toBe(true);
    }
    for (const line of ['git branch -D main', 'git branch -rd origin/x', 'git branch -f main HEAD', 'git branch -m a b', 'git branch -c a', 'git branch new', 'git branch --delete x', 'git branch --del x', 'git branch --set-upstream-to=origin/main', 'git branch -u origin/main', 'git branch --unset-upstream']) {
      expect(isSafe(line, DEFAULT_SAFE, inside)).toBe(false);
    }
  });
});
