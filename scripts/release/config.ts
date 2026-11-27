/**
 * The release settings, from one place: the `release` block of the root `package.json` (the npm name the harness is
 * published under, its description and keywords) and the root `version`. Changing the published name is one edit
 * there; the command people run stays `harness`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The repository root. */
export const REPO = fileURLToPath(new URL('../..', import.meta.url));

const RootPackage = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  license: z.string(),
  engines: z.object({ node: z.string() }),
  release: z.object({
    /** The npm package name (`fnloom`). */
    name: z.string().regex(/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/),
    /** The command people type (`fnloom`); the CLI reads it back from the package's `bin`. The repository's stays `harness`. */
    bin: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: z.string(),
    keywords: z.array(z.string()).default([]),
    repository: z.string(),
    homepage: z.string().optional(),
  }),
});

/** What the release script needs from the root `package.json`. */
export type ReleaseConfig = z.infer<typeof RootPackage>;

/** The release settings from the root `package.json`. */
export function releaseConfig(root: string = REPO): ReleaseConfig {
  return RootPackage.parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
}
