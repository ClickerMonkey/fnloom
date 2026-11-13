/**
 * The hub's version, read from its package.json so it has one source. The name people see is the hub's display name
 * (`boot/identity.ts`), never a constant.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Package = z.object({ version: z.string() });

/** The hub package's folder. */
export const HUB_PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** The hub's version. */
export const HUB_INFO = {
  version: Package.parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))).version,
} as const;

/** Build 9: the bundled systems folder (`HARNESS_BUNDLED_SYSTEMS`), or, when it is empty, the repository's `systems/`. */
export function bundledSystemsDir(setting: string): string {
  return setting === '' ? fileURLToPath(new URL('../../../../systems/', import.meta.url)) : setting;
}
