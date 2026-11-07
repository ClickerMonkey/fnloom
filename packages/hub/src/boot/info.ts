/** The hub's name and version, read from its package.json so the version has one source. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Package = z.object({ version: z.string() });

/** The hub package's folder. */
export const HUB_PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** The name people see, and the hub's version. */
export const HUB_INFO = {
  name: 'Harness',
  version: Package.parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))).version,
} as const;
