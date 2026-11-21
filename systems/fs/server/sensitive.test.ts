import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import type { SensitivityRule } from '@harness/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Located } from './index.ts';
import { RootGuard } from './paths.ts';
import { DEFAULT_SENSITIVITY_RULES, GIT_INTERNALS_RULE, GitIgnores, RUNS_CODE_RULES, Sensitivity, commandPaths, rulesOf } from './sensitive.ts';
import { NodeExec } from './shell.ts';
import { NO_IGNORES, ignoring, tempFolder } from './testing.ts';

const exec = new NodeExec({ outputMax: 100_000, progressEvery: 1_000 });

describe('the default sensitivity rules', () => {
  const rules = new Sensitivity(DEFAULT_SENSITIVITY_RULES, NO_IGNORES);
  const named = (path: string) => rules.byName(path).map((rule) => rule.name);

  it.each([
    ['.env', 'env-files'], ['config/.env.local', 'env-files'], ['.envrc', 'env-files'],
    ['server.pem', 'key-files'], ['certs/.secret.key', 'key-files'], ['store.p12', 'key-files'],
    ['home/.ssh/id_rsa', 'ssh-keys'], ['id_ed25519.pub', 'ssh-keys'],
    ['.npmrc', 'credential-files'], ['.git-credentials', 'credential-files'], ['aws/credentials', 'credential-files'], ['gcp.credentials.json', 'credential-files'],
    ['vault/.env/anything.txt', 'env-files'],
  ])('flags %s by name (%s)', (path, rule) => {
    expect(named(path)).toEqual([rule]);
    expect(rules.hides(path)).toBe(true);
  });

  it('matches without case where the file system finds names without case', () => {
    const caseless = new Sensitivity(DEFAULT_SENSITIVITY_RULES, NO_IGNORES, { caseless: true });
    for (const path of ['.GIT/config', '.Git/hooks/pre-commit', 'PACKAGE.JSON', '.ENV', 'Server.PEM']) {
      expect(caseless.named(path, 'write'), path).toEqual([expect.objectContaining({ action: 'ask' })]);
    }
    expect(caseless.hides('.ENV.example')).toBe(false);
    expect(new Sensitivity(DEFAULT_SENSITIVITY_RULES, NO_IGNORES, { caseless: false }).named('.GIT/config', 'write')).toEqual([]);
  });

  it.each(['.env.example', '.env.sample', 'src/id_map.ts', 'README.md', 'keys.ts', 'credentialsHelper.ts'])('leaves %s alone', (path) => {
    expect(named(path)).toEqual([]);
    expect(rules.hides(path)).toBe(false);
  });

  it.each([
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nabc', 'private-key-content'],
    ['aws = AKIAABCDEFGHIJKLMNOP', 'token-content'],
    [`const key = "sk-proj-${'a'.repeat(40)}";`, 'token-content'],
    [`token: ghp_${'A'.repeat(36)}`, 'token-content'],
    ['DB_PASSWORD="hunter2hunter2"', 'password-content'],
    ['password: \'correct horse\'', undefined],
    ['const password = process.env.PASSWORD;', undefined],
  ])('scans content: %s', (text, rule) => {
    expect(rules.byContent(text).map((r) => r.name)).toEqual(rule === undefined ? [] : [rule]);
  });
});

describe('Sensitivity', () => {
  let tmp: Awaited<ReturnType<typeof tempFolder>>;
  let guard: RootGuard;
  const at = (path: string): Located => guard.resolve(path, { write: false });

  beforeEach(async () => {
    tmp = await tempFolder();
    guard = new RootGuard([{ path: tmp.path, name: 'work', writable: true, index: 'none' }]);
    await mkdir(`${tmp.path}/src`, { recursive: true });
    await writeFile(`${tmp.path}/src/app.ts`, 'export const a = 1;\n');
    await writeFile(`${tmp.path}/src/config.ts`, 'export const apiKey = "abcdefgh12345678";\n');
    await writeFile(`${tmp.path}/.env`, 'X=1\n');
  });
  afterEach(() => tmp.cleanup());

  it('flags reads that ask, every write, and the content a write would put there', async () => {
    const rules = new Sensitivity(DEFAULT_SENSITIVITY_RULES, NO_IGNORES);
    const flags = await rules.flags([
      { at: at('.env'), access: 'read', certain: true },
      { at: at('src/app.ts'), access: 'read', certain: true },
      { at: at('src/config.ts'), access: 'read', certain: true },
      { at: at('src/new.ts'), access: 'write', certain: true, text: '-----BEGIN RSA PRIVATE KEY-----' },
    ]);
    expect(flags).toEqual([
      { path: '.env', kind: 'env', rule: 'env-files', access: 'read', action: 'ask', why: 'Env files hold keys and passwords.', certain: true },
      expect.objectContaining({ path: 'src/config.ts', rule: 'password-content', action: 'ask' }),
      expect.objectContaining({ path: 'src/new.ts', rule: 'private-key-content', access: 'write', action: 'ask' }),
    ]);
  });

  it('picks the strictest rule, and a configured list replaces the defaults', async () => {
    const list: SensitivityRule[] = [
      { name: 'secrets-folder', kind: 'credential', match: { type: 'glob', glob: 'src/*' }, except: ['src/app.ts'], read: 'refuse', write: 'refuse', why: 'Not for agents.' },
      { name: 'ts', kind: 'credential', match: { type: 'glob', glob: '*.ts' }, read: 'allow', write: 'ask', why: 'Allowed.' },
    ];
    const rules = new Sensitivity(list, NO_IGNORES);
    const flags = await rules.flags([{ at: at('src/config.ts'), access: 'read', certain: true }, { at: at('src/app.ts'), access: 'read', certain: true }, { at: at('.env'), access: 'read', certain: true }]);
    expect(flags.map((f) => [f.path, f.rule, f.action])).toEqual([['src/config.ts', 'secrets-folder', 'refuse'], ['src/app.ts', 'ts', 'allow']]);
    expect([...await rules.hidden([at('src/config.ts'), at('src/app.ts')], { content: false })]).toEqual([at('src/config.ts').path]);
  });

  it('flags gitignored files from git, and judges words it can only read by name', async () => {
    const rules = new Sensitivity(DEFAULT_SENSITIVITY_RULES, ignoring([at('src/app.ts').path]));
    expect((await rules.flags([{ at: at('src/app.ts'), access: 'write', certain: false }]))[0]).toMatchObject({ kind: 'gitignored', access: 'write', action: 'ask', certain: false });
    expect(rules.named('~/.ssh/id_rsa', 'read')).toEqual([expect.objectContaining({ path: '~/.ssh/id_rsa', rule: 'ssh-keys', certain: false })]);
    expect(rules.named('*.md', 'read')).toEqual([]);
  });

  it('leaves the files of a root git ignores as a whole alone (a root chosen inside a data folder)', async () => {
    const rules = new Sensitivity(DEFAULT_SENSITIVITY_RULES, ignoring([at('src/app.ts').root.folder, at('src/app.ts').path]));
    expect(await rules.flags([{ at: at('src/app.ts'), access: 'read', certain: true }])).toEqual([]);
    expect(await rules.hidden([at('src/app.ts')], { content: false })).toEqual(new Set());
  });

  it('asks the real git which files it ignores, per work tree', async () => {
    execFileSync('git', ['init', '-q'], { cwd: tmp.path });
    await writeFile(`${tmp.path}/.gitignore`, 'dist/\n*.log\n');
    await mkdir(`${tmp.path}/dist`, { recursive: true });
    await writeFile(`${tmp.path}/dist/out.js`, '');
    await writeFile(`${tmp.path}/debug.log`, '');
    const ignores = new GitIgnores(exec, 10_000);
    const found = await ignores.ignored([at('dist/out.js').path, at('debug.log').path, at('src/app.ts').path]);
    expect([...found].sort()).toEqual([at('debug.log').path, at('dist/out.js').path]);
    expect(await new GitIgnores(exec, 10_000).ignored([`${tmp.path}/../outside.txt`])).toEqual(new Set());
  });

  it('refuses a content pattern that does not compile, in words an admin can act on', () => {
    expect(() => new Sensitivity([{ name: 'bad', kind: 'token', match: { type: 'content', pattern: '(' }, read: 'ask', write: 'ask', why: 'x' }], NO_IGNORES)).toThrow(/"bad" has a pattern/);
  });
});

describe('rulesOf', () => {
  it('turns an old secrets list into rules, keeping the gitignored and content defaults', () => {
    const rules = rulesOf({ secrets: ['vault', '!vault/public.txt'] });
    expect(rules.filter((rule) => rule.match.type === 'glob' && rule.kind !== 'runs-code')).toEqual([expect.objectContaining({ name: 'secret vault', match: { type: 'glob', glob: 'vault' }, except: ['vault/public.txt'] })]);
    expect(rules.some((rule) => rule.match.type === 'gitignored')).toBe(true);
    expect(rulesOf({})).toBe(DEFAULT_SENSITIVITY_RULES);
    expect(rules.filter((rule) => rule.kind === 'runs-code')).toEqual(RUNS_CODE_RULES);
    // an admin's own list, even an empty one, still asks before writes into .git
    expect(rulesOf({ sensitive: [], secrets: ['x'] })).toEqual([GIT_INTERNALS_RULE]);
  });
});

describe('commandPaths', () => {
  it.each([
    ['cat .env', [{ word: '.env', access: 'read' }]],
    ['echo "KEY=1" > .env.local', [{ word: 'KEY=1', access: 'read' }, { word: '.env.local', access: 'write' }]],
    ['rm -f secrets/a.pem && git status', [{ word: 'secrets/a.pem', access: 'write' }, { word: 'status', access: 'read' }]],
    ['FOO=1 node "my file.js" 2>&1 | tee out.log', [{ word: 'my file.js', access: 'read' }, { word: 'out.log', access: 'write' }]],
    ['ls *.pem $HOME https://x.y/z', [{ word: '*.pem', access: 'read', glob: true }, { word: '$HOME', access: 'read', unknown: true }]],
    ['cd sub && cat .env; cd ../b && rm x', [{ word: '.env', access: 'read', folder: 'sub' }, { word: 'x', access: 'write', folder: 'sub/../b' }]],
    ['cd && cat .env', [{ word: '.env', access: 'read', lost: true }]],
    ['cd - && cat .env', [{ word: '.env', access: 'read', lost: true }]],
  ])('finds the paths in %s', (command, expected) => {
    expect(commandPaths(command)).toEqual(expected);
  });
});
