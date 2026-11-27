// Publishes the site to GitHub Pages: builds site/dist, then force-pushes it as the only commit of the `gh-pages`
// branch (GitHub serves that branch as-is; no workflow or runner involved).
//
//   node site/tools/publish-pages.mjs            # build and push
//   node site/tools/publish-pages.mjs --dry-run  # build and stage, don't push
//
// The first time, turn Pages on for the branch: gh api -X POST repos/<owner>/<repo>/pages -f source[branch]=gh-pages
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(site, '..');
const dryRun = process.argv.includes('--dry-run');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

execFileSync(process.execPath, [join(site, 'tools', 'build.mjs')], { stdio: 'inherit' });
const origin = git(['remote', 'get-url', 'origin'], repo);
const head = git(['rev-parse', '--short', 'HEAD'], repo);
const out = mkdtempSync(join(tmpdir(), 'site-pages-'));
try {
  cpSync(join(site, 'dist'), out, { recursive: true });
  writeFileSync(join(out, '.nojekyll'), '');
  git(['init', '-q'], out);
  git(['checkout', '-q', '-b', 'gh-pages'], out);
  git(['add', '-A'], out);
  git(['-c', 'user.name=site', '-c', 'user.email=site@users.noreply.github.com', 'commit', '-q', '-m', `Site from ${head}`], out);
  if (dryRun) {
    console.log(`Staged in ${out} (not pushed).`);
  } else {
    git(['push', '-q', '--force', origin, 'gh-pages'], out);
    console.log(`Pushed the site (from ${head}) to gh-pages on ${origin}.`);
  }
} finally {
  if (!dryRun) { rmSync(out, { recursive: true, force: true }); }
}
