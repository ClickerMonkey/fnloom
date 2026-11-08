/** The packaging tunables (link module): where pairing links point, and how installed packages get their externals. */
import { env } from '@ayepi/env';
import { z } from 'zod';

export const packagingEnv = env({
  HARNESS_PUBLIC_URL: z.url().optional().describe(
    'The hub as a phone or another machine reaches it, for pairing links and QR codes (`https://hub.example`). Unset: built from the address the system used to reach the hub.',
  ),
  HARNESS_PACKAGE_MAX: z.number().int().min(1_024).default(200_000_000).describe('The largest package zip or data export the hub unpacks, in bytes (unpacked).'),
  HARNESS_NPM: z.string().default(process.platform === 'win32' ? 'npm.cmd' : 'npm').describe('The npm the hub installs packages and their native externals with.'),
});

/** The parsed packaging tunables. */
export type PackagingEnv = ReturnType<typeof packagingEnv.parse>;
