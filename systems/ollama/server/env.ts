/**
 * The Ollama system's tunables, an `@ayepi/env` slice. Durations are milliseconds. They are named `OLLAMA_SYSTEM_*`
 * so they never mix with Ollama's own `OLLAMA_*` variables, which the system sets for the server it runs.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

/** The environment variables a GPU server usually needs, passed to the Ollama it runs (the rest of this process's env is not). */
const GPU_ENV = ['CUDA_VISIBLE_DEVICES', 'HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES', 'GPU_DEVICE_ORDINAL', 'HSA_OVERRIDE_GFX_VERSION', 'OLLAMA_FLASH_ATTENTION'];

export const ollamaEnv = env({
  ...systemFields(),
  /** Where Ollama's releases are listed (GitHub's releases API for ollama/ollama). */
  OLLAMA_SYSTEM_RELEASES: z.string().default('https://api.github.com/repos/ollama/ollama/releases'),
  /** How long one call to the Ollama server may take (a pull's stream excepted). */
  OLLAMA_SYSTEM_TIMEOUT: z.number().int().min(1).default(15_000),
  /** How long a download of a release may go without receiving anything. */
  OLLAMA_SYSTEM_DOWNLOAD_IDLE: z.number().int().min(1_000).default(60_000),
  /** How long a started server has to answer before the start counts as failed. */
  OLLAMA_SYSTEM_START_TIMEOUT: z.number().int().min(1_000).default(30_000),
  /** How often a starting server is asked whether it answers yet. */
  OLLAMA_SYSTEM_HEALTH_EVERY: z.number().int().min(10).default(250),
  /** How long a stopping server has to exit before it is killed. */
  OLLAMA_SYSTEM_STOP_GRACE: z.number().int().min(0).default(10_000),
  /** The first wait before a crashed server is started again; it doubles with each crash in a row. */
  OLLAMA_SYSTEM_RESTART_DELAY: z.number().int().min(0).default(1_000),
  /** The longest wait before a restart. */
  OLLAMA_SYSTEM_RESTART_MAX: z.number().int().min(0).default(60_000),
  /** Crashes in an hour after which the server stays down (`failed`) until an admin starts it. */
  OLLAMA_SYSTEM_RESTARTS_PER_HOUR: z.number().int().min(1).default(10),
  /** How many of the server's last output lines are kept for `ollama/status`. */
  OLLAMA_SYSTEM_OUTPUT_LINES: z.number().int().min(0).default(200),
  /** The most window assumed for a model whose Modelfile sets no `num_ctx` when the config sets no `contextLength`. */
  OLLAMA_SYSTEM_MAX_CTX: z.number().int().min(256).default(4_096),
  /** Names of this process's environment variables the server it runs gets too, comma-separated (GPU selection). */
  OLLAMA_SYSTEM_PASS_ENV: z.string().default(GPU_ENV.join(',')),
  /** Where `ollama/detect` asks for an Ollama that already runs on this machine. */
  OLLAMA_SYSTEM_DEFAULT_URL: z.string().default('http://127.0.0.1:11434'),
}).add(systemState('ollama'));

/** The Ollama system's settings, resolved. */
export type OllamaSettings = ReturnType<typeof ollamaEnv.parse>;
