/**
 * Sensitive files: one list of rules per fs instance (the config's `sensitive`, else `DEFAULT_SENSITIVITY_RULES`)
 * says which files are gitignored, env files, keys, credentials or hold tokens, and what reads and writes of them do
 * (core `sensitivity.ts`). The same list decides:
 *
 * - the flags fs answers before a run of `read`, `write`, `edit`, `remove`, `list`, `glob`, `grep` and `bash`, which
 *   the hub turns into a refusal, a question for the person, or a pass (`flagsVerdict`);
 * - which files `list`, `glob` and `grep` leave out of their results;
 * - which changed files a `bash` call's change set lists without a diff;
 * - which files are never served as resources (by name, gitignored or by content), so the hub never indexes them.
 *
 * A glob without `/` matches a file or folder name at any depth (so a matched folder covers what it holds); one with
 * `/` matches the path from the root. `except` globs leave a match alone. Content rules look at the first
 * `SENSITIVE_SCAN_BYTES` of a text file; `gitignored` asks git.
 */
import { open, stat } from 'node:fs/promises';
import { dirname, join, matchesGlob } from 'node:path';
import { SENSITIVE_SCAN_BYTES, type SensitivityFlag, type SensitivityRule } from '@harness/core';
import type { Exec, IgnoreCheck, Located, PathGuard } from './index.ts';
import { inside, normalize } from './paths.ts';
import { FsProblem } from './problem.ts';

/**
 * What an fs instance treats as sensitive when its config names no list. Reads of gitignored files, env files, keys,
 * credential files and files holding tokens or passwords ask the person; every write of one asks.
 */
export const DEFAULT_SENSITIVITY_RULES: readonly SensitivityRule[] = [
  { name: 'gitignored', kind: 'gitignored', match: { type: 'gitignored' }, read: 'ask', write: 'ask', why: 'Git ignores it: build output, local settings or secrets kept out of the repository.' },
  { name: 'env-files', kind: 'env', match: { type: 'glob', glob: '.env*' }, except: ['.env.example', '.env.sample', '.env.template'], read: 'ask', write: 'ask', why: 'Env files hold keys and passwords.' },
  { name: 'key-files', kind: 'key', match: { type: 'glob', glob: '*.{pem,key,pfx,p12,jks,keystore,ppk,asc}' }, read: 'ask', write: 'ask', why: 'Key files hold private keys and certificates.' },
  // named by their kinds rather than `id_*`, which would catch source files such as `id_map.ts`
  { name: 'ssh-keys', kind: 'key', match: { type: 'glob', glob: 'id_{rsa,dsa,ecdsa,ed25519}*' }, read: 'ask', write: 'ask', why: 'SSH keys let whoever holds them sign in as you.' },
  { name: 'credential-files', kind: 'credential', match: { type: 'glob', glob: '{.npmrc,.pypirc,.netrc,.git-credentials,.dockercfg,credentials,credentials.*,*.credentials,*.credentials.json}' }, read: 'ask', write: 'ask', why: 'Credential files hold tokens and passwords for other services.' },
  { name: 'private-key-content', kind: 'key', match: { type: 'content', pattern: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY' }, read: 'ask', write: 'ask', why: 'It holds a private key.' },
  { name: 'token-content', kind: 'token', match: { type: 'content', pattern: '\\b(?:AKIA[0-9A-Z]{16}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[abprs]-[A-Za-z0-9-]{20,})' }, read: 'ask', write: 'ask', why: 'It holds what looks like an access token (AWS, OpenAI, Anthropic, GitHub or Slack).' },
  { name: 'password-content', kind: 'secret-content', match: { type: 'content', pattern: '(?:password|passwd|PASSWORD|Password|secret|SECRET|api_?key|API_?KEY|apiKey)["\']?\\s*[:=]\\s*["\'][^"\'\\s]{8,}["\']' }, read: 'ask', write: 'ask', why: 'It has a password or secret written out in it.' },
];

/** The glob rules the old `secrets` config list stands for: each glob a credential rule, `!` globs its exceptions. */
export function rulesFromSecrets(globs: readonly string[]): SensitivityRule[] {
  const except = globs.filter((glob) => glob.startsWith('!') && glob.length > 1).map((glob) => glob.slice(1));
  return globs.filter((glob) => glob.trim() !== '' && !glob.startsWith('!')).map((glob) => ({
    name: `secret ${glob}`, kind: 'credential', match: { type: 'glob', glob }, ...(except.length === 0 ? {} : { except }),
    read: 'ask', write: 'ask', why: 'The fs config lists it as a secret.',
  }));
}

/**
 * The rule list of a config: `sensitive` when given; else, for a config from before build 8 that names `secrets`, the
 * default gitignored and content rules plus its globs; else the defaults.
 */
export function rulesOf(config: { readonly sensitive?: readonly SensitivityRule[] | undefined; readonly secrets?: readonly string[] | undefined }): readonly SensitivityRule[] {
  if (config.sensitive !== undefined) { return config.sensitive; }
  if (config.secrets === undefined) { return DEFAULT_SENSITIVITY_RULES; }
  return [...DEFAULT_SENSITIVITY_RULES.filter((rule) => rule.match.type !== 'glob'), ...rulesFromSecrets(config.secrets)];
}

/**
 * `matchesGlob` with dot files included: `*`, `?` and `[...]` also match a leading dot, so `*.pem` finds `.secret.pem`.
 * Node's matcher has no dot option, so the second test swaps each name's leading dot for a NUL, which no glob spells
 * out but every wildcard matches; the first test keeps globs that spell the dot (`.env*`) working.
 */
function matchesDotted(subject: string, glob: string): boolean {
  return matchesGlob(subject, glob) || matchesGlob(subject.replace(/(^|\/)\./g, '$1\u0000'), glob);
}

/** How strict an action is, to pick the strictest of several matching rules. */
const STRICTNESS = { allow: 0, ask: 1, refuse: 2 } as const;

/** What one access does under a rule. */
export function actionOf(rule: SensitivityRule, access: 'read' | 'write'): SensitivityFlag['action'] {
  return access === 'read' ? rule.read : rule.write;
}

/** The first bytes of a file as text, or `undefined` for a folder, a missing file or a binary one. */
async function headText(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile()) { return undefined; }
    const bytes = new Uint8Array(Math.min(info.size, SENSITIVE_SCAN_BYTES));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const read = bytes.subarray(0, bytesRead);
    return read.subarray(0, 8_000).includes(0) ? undefined : new TextDecoder().decode(read);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** One file to judge: where it is, and the text it will hold when that is known (a write's new text). */
export interface Judged {
  readonly at: Located;
  readonly access: 'read' | 'write';
  /** Whether the call surely touches it (false for a path found in a command line). */
  readonly certain: boolean;
  /** Text to scan instead of (and as well as) the file's own: what a write puts there. */
  readonly text?: string;
  /** The path shown on the flag when it isn't the located one (a command line's word). */
  readonly shown?: string;
}

/** A compiled rule list. One per config value. */
export class Sensitivity {
  readonly rules: readonly SensitivityRule[];
  private readonly ignores: IgnoreCheck;
  private readonly patterns: ReadonlyMap<SensitivityRule, RegExp>;

  constructor(rules: readonly SensitivityRule[], ignores: IgnoreCheck) {
    this.rules = rules;
    this.ignores = ignores;
    const patterns = new Map<SensitivityRule, RegExp>();
    for (const rule of rules) {
      if (rule.match.type !== 'content') { continue; }
      try {
        patterns.set(rule, new RegExp(rule.match.pattern, 'm'));
      } catch (error) {
        throw new FsProblem('bad-config', `The sensitive rule "${rule.name}" has a pattern that isn't a valid regular expression: ${error instanceof Error ? error.message : 'unknown problem'}. An admin fixes it in the fs config.`);
      }
    }
    this.patterns = patterns;
  }

  /** Whether the path (relative to its root, with `/`) is never served as a resource: a name rule that doesn't allow reads. */
  hides(relative: string): boolean {
    return this.byName(relative).some((rule) => rule.read !== 'allow');
  }

  /** The name rules matching a path relative to its root, or any folder above it. */
  byName(relative: string): SensitivityRule[] {
    if (relative === '') { return []; }
    const parts = relative.split('/');
    return this.rules.filter((rule) => {
      if (rule.match.type !== 'glob') { return false; }
      const glob = rule.match.glob;
      return parts.some((_, i) => {
        const entry = parts.slice(0, i + 1);
        const subject = glob.includes('/') ? entry.join('/') : entry[entry.length - 1] ?? '';
        if (!matchesDotted(subject, glob)) { return false; }
        return !(rule.except ?? []).some((except) => matchesDotted(except.includes('/') ? entry.join('/') : entry[entry.length - 1] ?? '', except));
      });
    });
  }

  /** The content rules whose pattern is found in a text. */
  byContent(text: string): SensitivityRule[] {
    return [...this.patterns].filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule);
  }

  /**
   * Flags from the name rules alone, for a word that may name files but can't be placed or read (a search's glob, a
   * command line's path outside the roots). Never `certain`.
   */
  named(word: string, access: 'read' | 'write'): SensitivityFlag[] {
    const rule = strictest(this.byName(word.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')), access);
    return rule === undefined ? [] : [{ path: word, kind: rule.kind, rule: rule.name, access, action: actionOf(rule, access), why: rule.why, certain: false }];
  }

  /** The flags for files a call would touch: the strictest matching rule per file and access. */
  async flags(items: readonly Judged[], signal?: AbortSignal): Promise<SensitivityFlag[]> {
    const ignored = await this.ignoredOf(items.map((item) => item.at.path), signal);
    const flags: SensitivityFlag[] = [];
    for (const item of items) {
      const matched = await this.matching(item.at, { ignored: ignored.has(item.at.path), content: true, ...(item.text === undefined ? {} : { text: item.text }) });
      const rule = strictest(matched, item.access);
      if (rule === undefined) { continue; }
      flags.push({ path: item.shown ?? (item.at.relative === '' ? item.at.root.name : item.at.relative), kind: rule.kind, rule: rule.name, access: item.access, action: actionOf(rule, item.access), why: rule.why, certain: item.certain });
    }
    return flags;
  }

  /**
   * Which of these paths a read must leave out: a matching rule that doesn't allow reads. `content` also scans each
   * file's first bytes (for `grep`, which shows what files hold; `list` and `glob` show only names).
   */
  async hidden(paths: readonly Located[], options: { content: boolean }, signal?: AbortSignal): Promise<Set<string>> {
    const ignored = await this.ignoredOf(paths.map((at) => at.path), signal);
    const out = new Set<string>();
    for (const at of paths) {
      const matched = await this.matching(at, { ignored: ignored.has(at.path), content: options.content });
      if (matched.some((rule) => rule.read !== 'allow')) { out.add(at.path); }
    }
    return out;
  }

  /**
   * The rule a changed file falls under (names, and content now or `before` the change: a secret the change removed
   * is still on the diff's `-` lines; gitignored files are counted, not listed), if any.
   */
  async changed(at: Located, before?: string): Promise<SensitivityRule | undefined> {
    return strictest(await this.matching(at, { ignored: false, content: true, ...(before === undefined ? {} : { text: before }) }), 'read');
  }

  /** Every rule matching a file. */
  private async matching(at: Located, options: { ignored: boolean; content: boolean; text?: string }): Promise<SensitivityRule[]> {
    const matched = this.byName(at.relative);
    if (options.ignored) { matched.push(...this.rules.filter((rule) => rule.match.type === 'gitignored')); }
    if (options.content && this.patterns.size > 0) {
      const texts = [options.text, await headText(at.path)].filter((text): text is string => text !== undefined);
      for (const text of texts) { matched.push(...this.byContent(text.slice(0, SENSITIVE_SCAN_BYTES))); }
    }
    return [...new Set(matched)];
  }

  /** Which paths git ignores, asked only when a rule cares. */
  private async ignoredOf(paths: readonly string[], signal?: AbortSignal): Promise<ReadonlySet<string>> {
    if (paths.length === 0 || !this.rules.some((rule) => rule.match.type === 'gitignored')) { return new Set(); }
    return this.ignores.ignored(paths, signal);
  }
}

/**
 * Whether the person saw a file on an approved card: a flag names it or a folder above it, or, for a flag made from a
 * search's glob (never `certain`), the glob matches it (a glob with `/` against the path's trailing parts, one
 * without against its name). Only flags count: approving a card that showed none unhides nothing.
 */
export function shownOn(flags: readonly SensitivityFlag[], relative: string): boolean {
  const parts = relative.split('/');
  return flags.some((flag) => {
    if (flag.path === relative || relative.startsWith(`${flag.path}/`)) { return true; }
    if (flag.certain) { return false; }
    const glob = flag.path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
    if (!glob.includes('/')) { return matchesDotted(parts[parts.length - 1] ?? '', glob); }
    return parts.some((_, i) => matchesDotted(parts.slice(i).join('/'), glob));
  });
}

/** The strictest of the rules for an access. */
export function strictest(rules: readonly SensitivityRule[], access: 'read' | 'write'): SensitivityRule | undefined {
  let best: SensitivityRule | undefined;
  for (const rule of rules) {
    if (best === undefined || STRICTNESS[actionOf(rule, access)] > STRICTNESS[actionOf(best, access)]) { best = rule; }
  }
  return best;
}

/** How many paths go on one `git check-ignore` command line (Windows caps a command line at 32k characters). */
const CHECK_CHUNK = 100;

/** Which files git ignores, through `git check-ignore`, grouped by the work tree each path is in. */
export class GitIgnores implements IgnoreCheck {
  private readonly exec: Exec;
  private readonly timeout: number;

  constructor(exec: Exec, timeout: number) {
    this.exec = exec;
    this.timeout = timeout;
  }

  async ignored(paths: readonly string[], signal?: AbortSignal): Promise<ReadonlySet<string>> {
    const tops = new Map<string, string | undefined>();
    const byTop = new Map<string, string[]>();
    for (const path of paths) {
      const top = await workTreeOf(normalize(path), tops);
      if (top === undefined) { continue; }
      const rel = inside(top, normalize(path));
      if (rel === undefined || rel === '' || rel === '.git' || rel.startsWith('.git/')) { continue; }
      byTop.set(top, [...(byTop.get(top) ?? []), rel]);
    }
    const out = new Set<string>();
    for (const [top, rels] of byTop) {
      for (const rel of await this.ignoredIn(top, rels, signal)) { out.add(normalize(join(top, rel))); }
    }
    return out;
  }

  /** Which of these paths (relative to the work tree, with `/`; a trailing `/` asks about a folder) git ignores. */
  async ignoredIn(top: string, rels: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < rels.length; i += CHECK_CHUNK) {
      const chunk = rels.slice(i, i + CHECK_CHUNK);
      const run = await this.exec.exec('git', ['-C', top, '-c', 'core.quotepath=off', 'check-ignore', '--', ...chunk], { timeout: this.timeout, ...(signal === undefined ? {} : { signal }) });
      // 0: some are ignored, 1: none are; anything else (git missing, a path outside the tree) judges nothing
      if (run.ended !== 'exit' || run.exitCode !== 0) { continue; }
      // one path per line, as given (`-z` needs `--stdin`, which the exec seam can't feed)
      for (const rel of run.stdout.split(/\r?\n/)) { if (rel !== '') { out.add(rel); } }
    }
    return out;
  }
}

/** The git work tree a path is in: the nearest folder above it holding `.git`, looked up once per folder. */
async function workTreeOf(path: string, known: Map<string, string | undefined>): Promise<string | undefined> {
  const seen: string[] = [];
  let folder = dirname(path).replaceAll('\\', '/');
  for (;;) {
    if (known.has(folder)) { break; }
    seen.push(folder);
    const found = await stat(join(folder, '.git')).then(() => true, () => false);
    if (found) { known.set(folder, folder); break; }
    const up = dirname(folder).replaceAll('\\', '/');
    if (up === folder) { known.set(folder, undefined); break; }
    folder = up;
  }
  const top = known.get(folder);
  for (const below of seen) { known.set(below, top); }
  return top;
}

/** A word of a command line that may be a path, and whether the command writes it. */
export interface CommandPath {
  readonly word: string;
  readonly access: 'read' | 'write';
}

/** Commands whose path arguments are written (or removed), not only read. */
const WRITING = new Set(['rm', 'mv', 'cp', 'touch', 'tee', 'truncate', 'chmod', 'chown', 'ln', 'dd', 'install', 'shred']);

/** One token of a command line: a word, or an operator (`|`, `&&`, `;`, `>` ...). */
type Token = { readonly type: 'word'; readonly text: string } | { readonly type: 'op'; readonly text: string };

/** Split a POSIX command line into words and operators, honouring quotes and backslashes. */
export function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let quoted = false;
  let quote: '"' | '\'' | undefined;
  const end = () => {
    if (word !== '' || quoted) { tokens.push({ type: 'word', text: word }); }
    word = '';
    quoted = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] ?? '';
    if (quote !== undefined) {
      if (c === quote) { quote = undefined; } else if (c === '\\' && quote === '"' && i + 1 < command.length) { i += 1; word += command[i] ?? ''; } else { word += c; }
      continue;
    }
    if (c === '"' || c === '\'') { quote = c; quoted = true; continue; }
    if (c === '\\' && i + 1 < command.length) { i += 1; word += command[i] ?? ''; continue; }
    if (/\s/.test(c)) { end(); continue; }
    const op = /^(?:&&|\|\||>>|\d?>&?\d?|<|\||;|&)/.exec(command.slice(i))?.[0];
    if (op !== undefined && !(/^\d/.test(op) && word !== '')) {
      end();
      tokens.push({ type: 'op', text: op });
      i += op.length - 1;
      continue;
    }
    word += c;
  }
  end();
  return tokens;
}

/**
 * The words of a command line that may name files, with whether the command writes them: redirect targets and the
 * arguments of commands like `rm`, `mv` and `tee` are writes, other arguments reads. Options, variables, globs and
 * env assignments are left out. A guess: the shell may do anything, so the flags it leads to are never `certain`.
 */
export function commandPaths(command: string): CommandPath[] {
  const out: CommandPath[] = [];
  let program: string | undefined;
  let redirect: 'read' | 'write' | undefined;
  for (const token of tokenize(command)) {
    if (token.type === 'op') {
      if (token.text.includes('>') && !token.text.includes('&')) { redirect = 'write'; } else if (token.text === '<') { redirect = 'read'; } else { program = undefined; redirect = undefined; }
      continue;
    }
    const word = token.text;
    if (redirect !== undefined) { if (plausiblePath(word)) { out.push({ word, access: redirect }); } redirect = undefined; continue; }
    if (program === undefined) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { continue; }
      program = word.split('/').pop() ?? word;
      continue;
    }
    if (plausiblePath(word)) { out.push({ word, access: WRITING.has(program) ? 'write' : 'read' }); }
  }
  return out;
}

/** Whether a word could be a file path worth judging. */
function plausiblePath(word: string): boolean {
  return word !== '' && !word.startsWith('-') && !/[$`*?{}()<>|;&]/.test(word) && !/^[a-z]+:\/\//i.test(word);
}

/** The flags-worthy files a command line names, located against the folder it runs in. Words outside the roots are skipped. */
export function commandFiles(guard: PathGuard, command: string, cwd: string | undefined): Array<{ at: Located; access: 'read' | 'write'; word: string }> {
  return commandPaths(command).flatMap(({ word, access }) => {
    try {
      return [{ at: guard.resolve(word, { write: false, cwd }), access, word }];
    } catch (error) {
      if (error instanceof FsProblem) { return []; }
      throw error;
    }
  });
}

