/**
 * The e2e suite's tunables. By default it boots its own stack (hub, fs, embedder) on `HARNESS_E2E_PORT` with a fresh
 * data folder and its own admin account; set `HARNESS_E2E_URL` to test a stack that is already running instead
 * (then `HARNESS_E2E_EMAIL` / `HARNESS_E2E_PASSWORD` must be that hub's admin).
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

export const e2eEnv = env({
  HARNESS_E2E_URL: z.string().optional(),
  HARNESS_E2E_PORT: z.number().int().min(4301).max(65535).default(4330),
  HARNESS_E2E_DATA: z.string().default('.harness/e2e'),
  HARNESS_E2E_EMAIL: z.email().default('e2e@harness.local'),
  HARNESS_E2E_PASSWORD: z.string().min(10).default('e2e-admin-password'),
  /** How long one agent turn may take with a free model. */
  HARNESS_E2E_TURN_TIMEOUT: z.number().int().min(10_000).default(240_000),
});

/** The parsed e2e settings. */
export type E2eSettings = ReturnType<typeof e2eEnv.parse>;
