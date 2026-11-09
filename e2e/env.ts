/**
 * The e2e suite's tunables. By default it boots its own stack (hub, fs, embedder, and the web system when
 * `TAVILY_API_KEY` is set) on `HARNESS_E2E_PORT` with a fresh data folder and its own admin account; set
 * `HARNESS_E2E_URL` to test a stack that is already running instead (then `HARNESS_E2E_EMAIL` /
 * `HARNESS_E2E_PASSWORD` must be that hub's admin).
 */
import { env } from '@ayepi/env';
import { z } from 'zod';

export const e2eEnv = env({
  HARNESS_E2E_URL: z.string().optional(),
  HARNESS_E2E_PORT: z.number().int().min(4301).max(65535).default(4330),
  HARNESS_E2E_DATA: z.string().default('.harness-test/e2e'),
  /** The port of the hub the restart test starts for itself, which installs and supervises fs. */
  HARNESS_E2E_RESTART_PORT: z.number().int().min(4301).max(65535).default(4331),
  HARNESS_E2E_EMAIL: z.email().default('e2e@harness.local'),
  HARNESS_E2E_PASSWORD: z.string().min(10).default('e2e-admin-password'),
  /** How long one agent turn may take with a free model. */
  HARNESS_E2E_TURN_TIMEOUT: z.number().int().min(10_000).default(240_000),
  /** The Tavily key: with it the stack runs the web system and the web suite runs; without, that suite is skipped. */
  TAVILY_API_KEY: z.string().min(1).optional(),
  /** The local Ollama the graph contextor suite uses (skipped when it doesn't answer). */
  HARNESS_E2E_OLLAMA: z.string().default('http://127.0.0.1:11434'),
  /** The Ollama models the graph suite tries, first one present wins: a small tool-capable one first. */
  HARNESS_E2E_OLLAMA_MODELS: z.string().default('qwen2.5:3b,llama3.2:3b,deepseek-r1:7b'),
  /** How long one local-model turn may take (qwen2.5:3b answers in seconds; a reasoning model like deepseek-r1:7b can take over 7 minutes on a two-step turn). */
  HARNESS_E2E_LOCAL_TURN_TIMEOUT: z.number().int().min(10_000).default(900_000),
});

/** The parsed e2e settings. */
export type E2eSettings = ReturnType<typeof e2eEnv.parse>;
