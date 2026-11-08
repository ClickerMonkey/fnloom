/**
 * The packaging tunables (link module): where pairing links point, how auto-pair attempts are limited, and how
 * installed packages get their externals.
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

export const packagingEnv = env({
  HARNESS_PUBLIC_URL: z.url().optional().describe(
    'The hub as a phone or another machine reaches it, for pairing links and QR codes (`https://hub.example`). Unset: built from the address the system used to reach the hub.',
  ),
  HARNESS_AUTO_PAIR_LIMIT: z.number().int().min(1).default(10).describe('Most auto-pair attempts per address, and per secret, in HARNESS_AUTO_PAIR_WINDOW.'),
  HARNESS_AUTO_PAIR_WINDOW: z.number().int().min(1_000).default(600_000).describe('The window auto-pair attempts are counted in, in milliseconds.'),
  HARNESS_AUTO_PAIR_EXPIRY: z.number().int().min(60_000).default(90 * 24 * 60 * 60 * 1000).describe('How long an auto-pair secret lasts when the admin picks no expiry, in milliseconds (90 days).'),
  HARNESS_PACKAGE_MAX: z.number().int().min(1_024).default(200_000_000).describe('The largest package zip or data export the hub unpacks, in bytes (unpacked).'),
  HARNESS_NPM: z.string().default(process.platform === 'win32' ? 'npm.cmd' : 'npm').describe('The npm the hub installs packages and their native externals with.'),
});

/** The parsed packaging tunables. */
export type PackagingEnv = ReturnType<typeof packagingEnv.parse>;
