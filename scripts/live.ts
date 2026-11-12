/**
 * `npm run live`: a stack that edits to this working tree can't restart or change. The hub (with every package it
 * imports, the linked `@aeye/*` and `@ayepi/*` libraries included) is bundled into one file and the web app built,
 * both into `.live/<commit>/`, then run with plain Node and nothing watched, on the same port, data folder and
 * settings as `npm run dev` (stop dev first: they share both). Native modules and the build tools the hub runs at
 * run time (better-sqlite3, sqlite-vec, Vite, which builds systems' client renderers) stay in `node_modules`.
 *
 * The systems still run from this tree's source, unwatched: an edit reaches one only when it restarts (on purpose, or
 * after a crash). A clean tree reuses its commit's build; a tree with changes is built again into
 * `.live/<commit>-<time>/`, so a pinned build is never rewritten while it runs. Restart `npm run live` to take new code.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { runStack, stackSettings } from './run-stack.ts';
import { ROOT, runComponent } from './stack.ts';

/** Packages left out of the bundle: native addons and the build tools the hub loads at run time, found in `node_modules`. */
const EXTERNAL = ['better-sqlite3', 'sqlite-vec', 'vite', '@vitejs/*', 'vue', 'lightningcss', 'esbuild', 'rolldown', 'fsevents'];

/** `git` in this repository, its output trimmed. */
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** The folder this tree's build goes in: its commit, plus the time when the tree has uncommitted changes. */
function liveFolder(): string {
  const commit = git('rev-parse', '--short=12', 'HEAD');
  const changed = git('status', '--porcelain', '--untracked-files=no') !== '';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return join(ROOT, '.live', changed ? `${commit}-${stamp}` : commit);
}

/**
 * Bundle the hub to `<folder>/hub/src/boot/main.mjs` beside a copy of its `package.json`, so the hub finds its version
 * and the web app (`../web/dist`) where it looks from its own module, as it does in `packages/hub/src/boot`.
 */
async function bundleHub(folder: string): Promise<void> {
  const out = join(folder, 'hub', 'src', 'boot', 'main.mjs');
  await build({
    entryPoints: [join(ROOT, 'packages', 'hub', 'src', 'main.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: EXTERNAL, logLevel: 'warning',
    // bundled CommonJS packages call `require`, which an ES module doesn't have
    banner: { js: "import { createRequire as __liveRequire } from 'node:module'; const require = __liveRequire(import.meta.url);" },
  });
  copyFileSync(join(ROOT, 'packages', 'hub', 'package.json'), join(folder, 'hub', 'package.json'));
}

/** Build the web app into `<folder>/web/dist`. */
async function buildWeb(folder: string): Promise<void> {
  const out = join(folder, 'web', 'dist');
  const vite = runComponent('web', [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', out, '--emptyOutDir'], {
    cwd: join(ROOT, 'packages', 'web'), env: {}, output: (_, line, stream) => { (stream === 'err' ? process.stderr : process.stdout).write(`web       ${line}\n`); },
  });
  if (await vite.exited !== 0) { throw new Error('the web build failed'); }
}

const settings = stackSettings();
const folder = liveFolder();
const hub = join(folder, 'hub', 'src', 'boot', 'main.mjs');
const web = join(folder, 'web', 'dist');
if (existsSync(hub) && existsSync(join(web, 'index.html'))) {
  console.info('live.reused', { folder });
} else {
  mkdirSync(folder, { recursive: true });
  console.info('live.building', { folder });
  await bundleHub(folder);
  await buildWeb(folder);
}
await runStack({ name: 'live', watch: false, pinned: { hub, web } }, settings);
