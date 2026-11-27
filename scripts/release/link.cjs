/**
 * The published package keeps the repository's layout (`packages/*`, `systems/*`, `scripts/`), so every relative path
 * in the code (the hub's web build and bundled systems, the CLI's template) means what it means in the repository.
 * What npm workspaces give the repository, links from `node_modules/@harness/<name>` to those folders, this makes for
 * the package: a directory junction on Windows (no admin rights needed), a relative symlink elsewhere. It runs as the
 * package's `postinstall`, and again from the `harness` binary before anything is imported (cheap when the links are
 * there), so an install made with `--ignore-scripts` still works. In the repository itself (a `package.json` with
 * `workspaces`) npm owns these links, and it does nothing.
 *
 * Plain CommonJS with no dependencies: it runs before anything is installed or registered.
 */
'use strict';
const { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } = require('node:fs');
const { dirname, join, relative } = require('node:path');

/** The package root: two folders above this file. */
const ROOT = join(__dirname, '..', '..');

/** The workspace folders whose `package.json` names a package the code imports. */
const PARENTS = ['packages', 'systems'];

/** Every workspace folder in the package, with the name its `package.json` gives it. */
function workspaces(root) {
  const found = [];
  for (const parent of PARENTS) {
    const dir = join(root, parent);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const manifest = join(dir, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof name === 'string' && name !== '') found.push({ name, dir: join(dir, entry.name) });
    }
  }
  return found;
}

/** Whether a path exists as anything at all, a broken link included. */
function present(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

/** Make the links that are missing; returns how many it made. */
function ensureLinks(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.workspaces !== undefined) return 0;
  let made = 0;
  for (const { name, dir } of workspaces(root)) {
    const link = join(root, 'node_modules', ...name.split('/'));
    if (existsSync(join(link, 'package.json'))) continue;
    // a broken link from an earlier install of this folder: replace it (only a link, never a real folder)
    if (present(link)) {
      if (!lstatSync(link).isSymbolicLink()) continue;
      rmSync(link, { force: true });
    }
    mkdirSync(dirname(link), { recursive: true });
    if (process.platform === 'win32') symlinkSync(dir, link, 'junction');
    else symlinkSync(relative(dirname(link), dir), link, 'dir');
    made++;
  }
  return made;
}

module.exports = { ensureLinks, workspaces };

if (require.main === module) {
  try {
    ensureLinks();
  } catch (error) {
    console.error(`harness: could not link its packages in ${ROOT}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
