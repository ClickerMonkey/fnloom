/**
 * The hub's logger (`@ayepi/log`): structured records whose message is a stable dotted key, secrets masked at any
 * depth, written to the console and (unless turned off) to daily files in the log folder. `console.*` anywhere in
 * the process goes through it once `interceptConsole()` is called, so library output is structured too.
 */
import { join } from 'node:path';
import { consoleTransport, createLogger, type Logger, type Transport } from '@ayepi/log';
import { fileTransport } from '@ayepi/log/file';
import type { HubSettings } from './env.ts';

/** Field names whose values never reach a log. */
export const SENSITIVE_KEYS: readonly (string | RegExp)[] = [
  'password', 'authorization', 'cookie', 'refresh', 'access', 'apiKey', 'credentials', 'privateKey', /token$/i, /secret/i, /^key$/i,
];

/** Make the hub logger from its settings. */
export function makeLogger(settings: Pick<HubSettings, 'logEnv' | 'hubEnv'>, now?: () => number): Logger {
  const { logEnv, hubEnv } = settings;
  // Made before `interceptConsole()`: the transport binds the console's methods now, so lines never loop back.
  const transports: Transport[] = [consoleTransport()];
  if (logEnv.HARNESS_LOG_FILES) {
    transports.push(fileTransport({ path: join(hubEnv.HARNESS_LOG_DIR, 'hub.log'), strategy: 'date', maxFiles: logEnv.HARNESS_LOG_KEEP, structured: true }));
  }
  return createLogger({
    level: logEnv.HARNESS_LOG_LEVEL,
    structured: logEnv.HARNESS_LOG_JSON,
    transports,
    sanitize: { sensitiveKeys: SENSITIVE_KEYS, maxStringLength: 4_000, maxArrayLength: 50 },
    ...(now === undefined ? {} : { now }),
  });
}
