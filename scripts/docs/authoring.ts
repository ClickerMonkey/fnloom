/**
 * Writes the system authoring guide, `packages/sdk/AUTHORING.md`: everything an author (or an LLM writing a system)
 * needs, in one file that ships with the SDK. The reference is read from the SDK's sources with the TypeScript compiler
 * API, the prose from `scripts/docs/prose/`, the code samples from compiled files (the template system, the example
 * system in `scripts/docs/example/`, the fs contract). Beside it, it writes the guide's parts
 * (`systems/fs/shared/authoring.gen.ts`, `parts.ts`), which fs offers as one context item per section. With `--check`
 * it writes nothing and fails when either file is stale, so `npm run check` breaks until an SDK change is documented.
 * The config is `config.ts`.
 *
 * Run: npm run docs:authoring   (check: npm run docs:authoring -- --check)
 */
import { writeFileSync } from 'node:fs';
import { GuideProblems } from './compose.ts';
import { AUTHORING_CONFIG, AUTHORING_FILE, AUTHORING_PARTS_FILE } from './config.ts';
import { buildGuide, isCurrent } from './guide.ts';
import { guideParts, partsModule } from './parts.ts';

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

const guide = build();
const outputs = [
  { file: AUTHORING_FILE, text: guide },
  { file: AUTHORING_PARTS_FILE, text: partsModule(guideParts(guide, AUTHORING_CONFIG.outline)) },
];
const stale = outputs.filter((output) => !isCurrent(output.file, output.text));
if (process.argv.includes('--check')) {
  if (stale.length > 0) {
    console.error('docs.authoring.stale', { files: stale.map((output) => output.file), fix: 'npm run docs:authoring' });
    process.exit(1);
  }
} else {
  for (const output of stale) {
    writeFileSync(output.file, output.text);
    console.info('docs.authoring.written', { file: output.file, characters: output.text.length });
  }
}
