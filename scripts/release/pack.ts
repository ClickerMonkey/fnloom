/**
 * `npm run release:pack`: the one npm package the harness is published as, built into `.release/`.
 *
 * The package keeps the repository's layout, so every relative path in the code works as it does here:
 *
 *   package.json            the configured name and command (root package.json `release.name`, `release.bin`),
 *                           and every workspace's third-party runtime dependencies at the lockfile's versions
 *   README.md, LICENSE      docs/install.md as the README
 *   tsconfig.base.json      what system folders' tsconfig.json extend (`harness system new`, `build`)
 *   packages/{core,sdk,hub,cli,build}   their tracked source, without tests
 *   packages/web            its package.json and the built app (dist/) the hub serves
 *   systems/*               every premade system's tracked source, without tests
 *   scripts/                the stack (`harness start`) and `release/link.cjs`
 *
 * The internal `@harness/*` workspaces are not published on their own: `scripts/release/link.cjs` links
 * `node_modules/@harness/<name>` to those folders after install, as npm workspaces do in the repository. Only files git
 * tracks are copied (never `.env`, `.harness` or other local data), and the staged tree is checked for secrets
 * before it is packed.
 *
 * `--skip-build` packs the web build already in `packages/web/dist`; `--out <dir>` puts the tarball elsewhere.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO, releaseConfig } from './config.ts';

/** The workspaces whose source ships (the web app ships only its build). */
const PACKAGES = ['packages/core', 'packages/sdk', 'packages/hub', 'packages/cli', 'packages/build'] as const;
/** The scripts `harness start` runs, and the link step. */
const SCRIPTS = ['scripts/start.ts', 'scripts/run-stack.ts', 'scripts/stack.ts', 'scripts/supervise.ts', 'scripts/hub-client.ts', 'scripts/dev-env.ts', 'scripts/release/link.cjs'] as const;
/** Tracked files that stay out: tests and what only tests and the repository's own tooling use. */
const LEAVE_OUT = [/\.test\.ts$/, /\/e2e\//, /\/typetests\//, /\/__snapshots__\//, /(^|\/)\.gitignore$/];
/**
 * Runtime dependencies of the workspaces that are not imported at run time by the hub, the CLI or a system: the web
 * app's are compiled into its build.
 */
const BUILD_ONLY_WORKSPACES = new Set(['packages/web']);
/** Optional peers the hub and CLI use at run time: Vite and its Vue plugin build systems' client renderers. */
const RUNTIME_PEERS = ['vite', '@vitejs/plugin-vue', 'vue'] as const;
/** Files that must never be in the package, by name. */
const SECRET_NAMES = [/^\.env(\..*)?$/, /\.pem$/, /\.key$/, /^id_(rsa|ed25519|ecdsa)/, /^keys\.json$/, /\.sqlite(-wal|-shm)?$/, /^\.npmrc$/];
/** Content that looks like a real credential. */
const SECRET_CONTENT = [
  /sk-or-v1-[0-9a-f]{40,}/, /sk-ant-[A-Za-z0-9_-]{60,}/, /sk-proj-[A-Za-z0-9_-]{40,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{36}/, /github_pat_[A-Za-z0-9_]{40,}/,
  /npm_[A-Za-z0-9]{36}/, /tvly-[A-Za-z0-9-]{20,}/, /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]/,
];

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
  scripts?: Record<string, string>;
  workspaces?: string[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const writeJson = (path: string, value: unknown): void => { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

/** `git ls-files` under some paths, as forward-slash paths from the repository root. */
function tracked(...paths: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter((path) => path !== '' && existsSync(join(REPO, path)));
}

/** Copy a repository file into the staging folder at the same path. */
function copy(stage: string, path: string): void {
  mkdirSync(dirname(join(stage, path)), { recursive: true });
  cpSync(join(REPO, path), join(stage, path));
}

/** A workspace's `package.json` as it ships: no dev dependencies or scripts. */
function shippedManifest(manifest: Manifest): Manifest {
  const { devDependencies: _dev, scripts: _scripts, ...rest } = manifest;
  return rest;
}

/** The version of a package the lockfile installed at the top of `node_modules`. */
function lockedVersion(lock: { packages: Record<string, { version?: string; link?: boolean }> }, name: string): string {
  const entry = lock.packages[`node_modules/${name}`];
  if (entry?.version === undefined) { throw new Error(`${name} is not in package-lock.json: run npm install`); }
  return entry.version;
}

/** Every workspace's third-party runtime dependencies (and the runtime peers), at the lockfile's versions. */
function runtimeDependencies(workspaces: readonly string[]): Record<string, string> {
  const lock = readJson<{ packages: Record<string, { version?: string }> }>(join(REPO, 'package-lock.json'));
  const names = new Set<string>(RUNTIME_PEERS);
  for (const name of Object.keys(readJson<Manifest>(join(REPO, 'package.json')).dependencies ?? {})) { names.add(name); }
  for (const workspace of workspaces) {
    if (BUILD_ONLY_WORKSPACES.has(workspace)) { continue; }
    for (const name of Object.keys(readJson<Manifest>(join(REPO, workspace, 'package.json')).dependencies ?? {})) {
      if (!name.startsWith('@harness/')) { names.add(name); }
    }
  }
  names.add('tsx');
  return Object.fromEntries([...names].sort().map((name) => [name, lockedVersion(lock, name)]));
}

/** Every file under a folder, relative to it. */
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path, base) : [relative(base, path).split('\\').join('/')];
  });
}

/** Secrets in the staged tree: files that must not ship, content that looks like a credential, and values from `.env`. */
function secretsIn(stage: string): string[] {
  const envValues = existsSync(join(REPO, '.env'))
    // the values of settings named like secrets (keys, tokens, passwords), not addresses or emails
    ? readFileSync(join(REPO, '.env'), 'utf8').split(/\r?\n/).map((line) => /^\s*[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*"?([^"#\s]{8,})"?/.exec(line)?.[2]).filter((v): v is string => v !== undefined)
    : [];
  const found: string[] = [];
  for (const path of walk(stage)) {
    const name = path.split('/').pop() ?? path;
    if (SECRET_NAMES.some((pattern) => pattern.test(name))) { found.push(`${path}: a file that must not ship`); continue; }
    if (statSync(join(stage, path)).size > 4 * 1024 * 1024) { continue; }
    const text = readFileSync(join(stage, path), 'utf8');
    for (const pattern of SECRET_CONTENT) { if (pattern.test(text)) { found.push(`${path}: looks like a credential (${pattern.source.slice(0, 20)}…)`); } }
    if (envValues.some((value) => text.includes(value))) { found.push(`${path}: holds a value from .env`); }
  }
  return found;
}

const { values } = parseArgs({ options: { 'skip-build': { type: 'boolean', default: false }, out: { type: 'string' } } });
const config = releaseConfig();
const out = resolve(values.out ?? join(REPO, '.release'));
const stage = join(out, 'stage');
const root = readJson<Manifest>(join(REPO, 'package.json'));
const workspaces = root.workspaces ?? [];
const systems = workspaces.filter((w) => w.startsWith('systems/'));

if (!values['skip-build']) {
  execFileSync(process.execPath, [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: join(REPO, 'packages', 'web'), stdio: 'inherit' });
}
if (!existsSync(join(REPO, 'packages', 'web', 'dist', 'index.html'))) { throw new Error('packages/web/dist is missing: run npm run build'); }

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const path of tracked(...PACKAGES, ...systems, 'tsconfig.base.json', 'LICENSE')) {
  if (LEAVE_OUT.some((pattern) => pattern.test(path))) { continue; }
  copy(stage, path);
}
for (const path of SCRIPTS) { copy(stage, path); }
copy(stage, 'packages/web/package.json');
// the built app without its source maps (most of its size, and of no use to someone running it)
cpSync(join(REPO, 'packages', 'web', 'dist'), join(stage, 'packages', 'web', 'dist'), { recursive: true, filter: (source) => !source.endsWith('.map') });
cpSync(join(REPO, 'docs', 'install.md'), join(stage, 'README.md'));
for (const workspace of [...PACKAGES, 'packages/web', ...systems]) {
  const path = join(stage, workspace, 'package.json');
  writeJson(path, shippedManifest(readJson<Manifest>(path)));
}

const shipped = [...PACKAGES, ...systems];
writeJson(join(stage, 'package.json'), {
  name: config.release.name,
  version: config.version,
  description: config.release.description,
  keywords: config.release.keywords,
  license: config.license,
  repository: { type: 'git', url: `git+${config.release.repository}.git` },
  ...(config.release.homepage === undefined ? {} : { homepage: config.release.homepage }),
  type: 'module',
  engines: config.engines,
  bin: { [config.release.bin]: 'packages/cli/bin/harness.mjs' },
  scripts: { postinstall: 'node scripts/release/link.cjs' },
  dependencies: runtimeDependencies(shipped),
});

const secrets = secretsIn(stage);
if (secrets.length > 0) {
  console.error(`release.pack.refused: ${secrets.length} possible secrets in the package\n${secrets.map((s) => `  ${s}`).join('\n')}`);
  process.exit(1);
}

const files = walk(stage);
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', out], { cwd: stage, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 })) as Array<{ filename: string; size: number; unpackedSize: number; entryCount: number }>;
const result = packed[0];
if (result === undefined) { throw new Error('npm pack wrote nothing'); }
if (result.entryCount !== files.length) { console.warn('release.pack.dropped', { staged: files.length, packed: result.entryCount }); }
console.info('release.packed', {
  name: config.release.name, version: config.version, tarball: join(out, result.filename),
  size: `${(result.size / 1024 / 1024).toFixed(2)} MB`, unpacked: `${(result.unpackedSize / 1024 / 1024).toFixed(2)} MB`, files: result.entryCount,
});
