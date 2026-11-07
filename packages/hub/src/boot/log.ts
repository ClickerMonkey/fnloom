/**
 * The hub's logger (`@ayepi/log`): structured records whose message is a stable dotted key, secrets masked at any
 * depth, written to the console and (unless turned off) to daily files in the log folder. `console.*` anywhere in
 * the process goes through it once `interceptConsole()` is called, so library output is structured too.
 */
import { join } from 'node:path';
import { consoleTransport, createLogger, type Logger, type Transport } from '@ayepi/log';
import { fileTransport } from '@ayepi/log/file';
import { errorFieldFilter } from '@harness/sdk/server';
import type { HubSettings } from './env.ts';

/** Field names whose values never reach a log. */
export const SENSITIVE_KEYS: readonly (string | RegExp)[] = [
  'password', 'authorization', 'cookie', 'refresh', 'access', 'apiKey', 'credentials', 'privateKey', /token$/i, /secret/i, /^key$/i,
];

/** Make the hub logger from its settings. */
export function makeLogger(settings: Pick<HubSettings, 'logEnv' | 'hubEnv'>, now?: () => number): Logger {
  const { logEnv, hubEnv } = settings;
  // The console's own methods, bound now: `interceptConsole()` later replaces them, and writing through the replaced
  // ones would feed each line back into the logger, which drops it.
  const original = { log: console.log.bind(console), info: console.info.bind(console), debug: console.debug.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  const transports: Transport[] = [consoleTransport({ console: original })];
  if (logEnv.HARNESS_LOG_FILES) {
    transports.push(fileTransport({ path: join(hubEnv.HARNESS_LOG_DIR, 'hub.log'), strategy: 'date', maxFiles: logEnv.HARNESS_LOG_KEEP, structured: true }));
  }
  return createLogger({
    level: logEnv.HARNESS_LOG_LEVEL,
    structured: logEnv.HARNESS_LOG_JSON,
    transports,
    filter: errorFieldFilter,
    sanitize: { sensitiveKeys: SENSITIVE_KEYS, maxStringLength: 4_000, maxArrayLength: 50 },
    ...(now === undefined ? {} : { now }),
  });
}
