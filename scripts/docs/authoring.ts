/**
 * Writes the system authoring guide, `packages/sdk/AUTHORING.md`: everything an author (or an LLM writing a system)
 * needs, in one file that ships with the SDK. The reference is read from the SDK's sources with the TypeScript compiler
 * API, the prose from `scripts/docs/prose/`, the code samples from compiled files (the template system, the example
 * system in `scripts/docs/example/`, the fs contract). Beside it, it writes the guide as fs's context folder
 * (`systems/fs/context/authoring/`, `context-files.ts`): a shallow index, topic groups and one item per part. With
 * `--check` it writes nothing and fails when any of them is stale, so `npm run check` breaks until an SDK change is
 * documented. The config is `config.ts`.
 *
 * Run: npm run docs:authoring   (check: npm run docs:authoring -- --check)
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { GuideProblems } from './compose.ts';
import { AUTHORING_CONFIG, AUTHORING_FILE } from './config.ts';
import { AUTHORING_CONTEXT_DIR, contextFiles } from './context-files.ts';
import { buildGuide, isCurrent } from './guide.ts';
import { guideParts } from './parts.ts';

/** Build the guide, or list what stops it and exit. */
function build(): string {
  try {
    return buildGuide(AUTHORING_CONFIG);
  } catch (error) {
    if (!(error instanceof GuideProblems)) { throw error; }
    console.error('docs.authoring.problems', { problems: error.problems });
    process.exit(1);
  }
}

/** Every file under a folder, as paths from it (none when it doesn't exist). */
function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  } catch {
    return [];
  }
}

const guide = build();
const parts = guideParts(guide, AUTHORING_CONFIG.outline);
const contextDir = join(AUTHORING_CONFIG.root, AUTHORING_CONTEXT_DIR);
const outputs = [
  { file: AUTHORING_FILE, text: guide },
  ...contextFiles(parts).map((output) => ({ file: join(contextDir, output.path), text: output.text })),
];
// files left in the folder from parts the guide no longer has
const written = new Set(outputs.map((output) => output.file));
const leftover = filesIn(contextDir).map((path) => join(contextDir, path)).filter((path) => !written.has(path));
const stale = outputs.filter((output) => !isCurrent(output.file, output.text));
if (process.argv.includes('--check')) {
  if (stale.length > 0 || leftover.length > 0) {
    console.error('docs.authoring.stale', { files: [...stale.map((output) => output.file), ...leftover], fix: 'npm run docs:authoring' });
    process.exit(1);
  }
} else {
  for (const path of leftover) { rmSync(path); }
  for (const output of stale) {
    mkdirSync(dirname(output.file), { recursive: true });
    writeFileSync(output.file, output.text);
    console.info('docs.authoring.written', { file: output.file, characters: output.text.length });
  }
}
