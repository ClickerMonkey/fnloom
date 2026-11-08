/**
 * Writes the system authoring guide, `packages/sdk/AUTHORING.md`: everything an author (or an LLM writing a system)
 * needs, in one file that ships with the SDK. The reference is read from the SDK's sources with the TypeScript compiler
 * API, the prose from `scripts/docs/prose/`, the code samples from compiled files (the template system, the example
 * system in `scripts/docs/example/`, the fs contract). With `--check` it writes nothing and fails when the file is
 * stale, so `npm run check` breaks until an SDK change is documented. The config is `config.ts`.
 *
 * Run: npm run docs:authoring   (check: npm run docs:authoring -- --check)
 */
import { writeFileSync } from 'node:fs';
import { GuideProblems } from './compose.ts';
import { AUTHORING_CONFIG, AUTHORING_FILE } from './config.ts';
import { buildGuide, isCurrent } from './guide.ts';

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

const text = build();
if (process.argv.includes('--check')) {
  if (!isCurrent(AUTHORING_FILE, text)) {
    console.error('docs.authoring.stale', { file: AUTHORING_FILE, fix: 'npm run docs:authoring' });
    process.exit(1);
  }
} else if (!isCurrent(AUTHORING_FILE, text)) {
  writeFileSync(AUTHORING_FILE, text);
  console.info('docs.authoring.written', { file: AUTHORING_FILE, characters: text.length });
}
