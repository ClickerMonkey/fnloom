/**
 * The scenario runner's tunables (`npm run scenarios`). The keys are read from the environment; on Windows, when Git
 * Bash doesn't carry them, they are read from the Windows user environment instead, where they are kept.
 */
import { execFileSync } from 'node:child_process';
import { env } from '@ayepi/env';
import { z } from 'zod';

export const scenariosEnv = env({
  /** The hub's port for each repetition's stack (never 4300, 4310, 4320 or 4330 to 4340: those are other stacks). */
  HARNESS_SCENARIOS_PORT: z.coerce.number().int().min(4341).max(65535).default(4350),
  /** The port `--view` serves a saved repetition on. */
  HARNESS_SCENARIOS_VIEW_PORT: z.coerce.number().int().min(4341).max(65535).default(4351),
  /** The chat model, the simulated person's and the judge's (OpenRouter ids). */
  HARNESS_SCENARIOS_MODEL: z.string().default('openai/gpt-6-luna'),
  HARNESS_SCENARIOS_PERSON_MODEL: z.string().default('deepseek/deepseek-v4.1-flash'),
  HARNESS_SCENARIOS_JUDGE_MODEL: z.string().default('openai/gpt-6-luna'),
  /** The diagnostician's model (`diagnose.ts`: why each step of a case went the way it did). */
  HARNESS_SCENARIOS_DIAGNOSE_MODEL: z.string().default('openai/gpt-6-luna'),
  /** The EmbeddingGemma service the embedder system wraps; when it doesn't answer, the embedder isn't run. */
  HARNESS_SCENARIOS_EMBEDDER: z.string().default('http://127.0.0.1:8760'),
  /** How long one agent turn may take before the case gives up waiting (ms). */
  HARNESS_SCENARIOS_TURN_TIMEOUT: z.coerce.number().int().min(30_000).default(480_000),
  /** How long the stack may take to start each part (ms). */
  HARNESS_SCENARIOS_START_TIMEOUT: z.coerce.number().int().min(10_000).default(180_000),
  /** How long a repetition waits for the hub's index to be embedded before it plays (ms); past it, the cases run and the report says so. */
  HARNESS_SCENARIOS_INDEX_TIMEOUT: z.coerce.number().int().min(10_000).default(600_000),
  /** How often the index's progress is asked for and logged while waiting (ms). */
  HARNESS_SCENARIOS_INDEX_POLL: z.coerce.number().int().min(500).default(5_000),
  /**
   * The decision model of the `on` variant (`variants.ts`): the decide role, the suggestions chooser and both search
   * decisions. GPT-6 Luna Decisions (OpenAI's Decisions API), served through the OpenRouter provider the hub already has.
   */
  HARNESS_SCENARIOS_DECISION_MODEL: z.string().min(1).default('typesafe/jev-1.14'),
  /** How many times a hub call the hub shed (HTTP 503, "the hub is busy") is tried in all before the case fails on it. */
  HARNESS_SCENARIOS_BUSY_TRIES: z.coerce.number().int().min(1).max(100).default(12),
  /** The first wait after a shed call (ms); each next wait doubles, never under the hub's retry-after. */
  HARNESS_SCENARIOS_BUSY_WAIT: z.coerce.number().int().min(100).default(1_000),
  /** The longest one wait may be (ms). */
  HARNESS_SCENARIOS_BUSY_WAIT_MAX: z.coerce.number().int().min(100).default(30_000),
  /** The most one call may wait in all for a busy hub (ms), whatever the tries left. */
  HARNESS_SCENARIOS_BUSY_TOTAL: z.coerce.number().int().min(1_000).default(240_000),
  /**
   * Where each rep's fake home folder (the fs system's `home` root) is made: outside any git repository, so the fs
   * git hook never reports this repository to a household person. Default: `<os temp>/harness-scenarios`. A root inside
   * a git repository is refused when a rep starts.
   */
  HARNESS_SCENARIOS_HOME_ROOT: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  TAVILY_API_KEY: z.string().min(1).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
});

export type ScenariosSettings = ReturnType<typeof scenariosEnv.parse>;

/** The keys the runner may find in the Windows user environment. */
const USER_KEYS = ['OPENROUTER_API_KEY', 'TAVILY_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;

/** A variable of the Windows user environment, or undefined. */
function windowsUserVariable(name: string): string | undefined {
  try {
    const value = execFileSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetEnvironmentVariable('${name}','User')`], { encoding: 'utf8' }).trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * The settings, with the keys filled in from the Windows user environment where the process lacks them. They go into
 * `process.env` too, so the hub and the web system (started as children) inherit them.
 */
export function loadSettings(): ScenariosSettings {
  if (process.platform === 'win32') {
    for (const key of USER_KEYS) {
      if (process.env[key] !== undefined && process.env[key] !== '') { continue; }
      const value = windowsUserVariable(key);
      if (value !== undefined) { process.env[key] = value; }
    }
  }
  return scenariosEnv.parse();
}
