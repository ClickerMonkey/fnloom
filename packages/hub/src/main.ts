#!/usr/bin/env node
/**
 * The hub process (`npm run dev` starts it with `tsx watch`). Values in `.env` (in the working folder) fill in what
 * the environment doesn't set; then the hub starts with every module from `boot/modules.ts` and stops on Ctrl+C
 * (SIGINT), SIGTERM or Ctrl+Break (SIGBREAK). A failed start is logged and exits with status 1.
 */
import { loadEnv } from '@ayepi/env/load';
import { HUB_MODULES } from './boot/modules.ts';
import { startHub } from './boot/start.ts';

for (const [key, value] of Object.entries(loadEnv({ files: ['.env'] }))) {
  process.env[key] ??= typeof value === 'string' ? value : JSON.stringify(value);
}

try {
  await startHub({ modules: HUB_MODULES, signals: true });
} catch (error) {
  console.error('hub.start.failed', error);
  process.exitCode = 1;
}
