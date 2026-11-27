/**
 * `npm run release:version <x.y.z>`: set the version the harness is published as (the root `package.json` `version`,
 * and the root entries of `package-lock.json`), then say the commands that release it. Pushing the tag `v<x.y.z>`
 * runs `.github/workflows/release.yml`, which publishes it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, releaseConfig } from './config.ts';

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: npm run release:version <x.y.z>');
  process.exit(2);
}

/** Change `"version": "…"` near the top of a JSON file, keeping the rest of its text as it is. */
function setVersion(path: string, count: number): void {
  let text = readFileSync(path, 'utf8');
  let left = count;
  text = text.replace(/("version":\s*")[^"]*(")/g, (match, open: string, close: string) => (left-- > 0 ? `${open}${version}${close}` : match));
  writeFileSync(path, text);
}

const before = releaseConfig().version;
setVersion(join(REPO, 'package.json'), 1);
// the lockfile names the root's version twice: at its top and as `packages[""]`
setVersion(join(REPO, 'package-lock.json'), 2);
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8')) as { version?: string; packages?: Record<string, { version?: string }> };
if (lock.version !== version || lock.packages?.['']?.version !== version) { throw new Error('package-lock.json did not take the version: run npm install'); }
console.info(`${releaseConfig().release.name}: ${before} -> ${version}`);
console.info(`Release it: git commit -am "Release ${version}" && git tag v${version} && git push && git push origin v${version}`);
