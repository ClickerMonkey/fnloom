/**
 * Logging for a system process, on `@ayepi/log`. Every line is a stable dotted key plus structured fields. Lines go to
 * the local console and, while connected, to the hub (`HubLink.log`), which files them under the system and, when the
 * fields name one, the run.
 */
import { consoleTransport, createLogger, type Logger, type LogRecord, type Transport } from '@ayepi/log';
import { Json, type JsonObject, type LogLine } from '@harness/core';
import type { Log } from '../ctx.ts';
import { messageOf } from './wire.ts';

/** Where the hub-bound copy of each line goes. Never throws, and never logs its own failures. */
export type LogSink = (line: LogLine) => void;

const RECORD_KEYS = new Set(['tms', 'level', 'msg', 'error', 'additionalErrors']);

/** Turn arbitrary fields into JSON, dropping what doesn't survive a JSON round trip. */
export function jsonFields(fields: Readonly<Record<string, unknown>>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(fields)) {
    const plain = roundTrip(value);
    if (plain === undefined) { continue; }
    const json = Json.safeParse(plain);
    if (json.success) { out[key] = json.data; }
  }
  return out;
}

/** A value after a JSON round trip; `undefined` for what JSON can't hold (functions, symbols), a marker for cycles. */
function roundTrip(value: unknown): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') { return undefined; }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return '(not JSON: cyclic or too deep)';
  }
}

/** An `@ayepi/log` transport that forwards each record to the hub. */
class HubTransport implements Transport {
  readonly name = 'harness-hub';
  readonly #sink: LogSink;

  constructor(sink: LogSink) {
    this.#sink = sink;
  }

  write(record: LogRecord): void {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!RECORD_KEYS.has(key)) { fields[key] = value; }
    }
    if (record.error !== undefined) { fields['error'] = record.error.message; }
    this.#sink({ level: record.level, key: record.msg, fields: jsonFields(fields) });
  }
}

/** Writes every level to stderr, for when stdout carries a protocol (MCP over stdio). */
const stderrConsole = { log: console.error, info: console.error, debug: console.error, warn: console.error, error: console.error };

/**
 * Make the process logger: the console (`stderr` keeps stdout free for MCP over stdio; `none` is for tests), plus the
 * hub while connected. Secrets in fields are masked.
 */
export function systemLogger(options: { level: 'debug' | 'info' | 'warn' | 'error'; json: boolean; sink: LogSink; console: 'stdout' | 'stderr' | 'none' }): Logger {
  const local = options.console === 'none' ? [] : [consoleTransport(options.console === 'stderr' ? { console: stderrConsole } : {})];
  return createLogger({
    level: options.level,
    structured: options.json,
    transports: [...local, new HubTransport(options.sink)],
    sanitize: { sensitiveKeys: ['password', 'authorization', 'cookie', /token$/i, /secret/i, /apikey/i, /privatekey/i], maxStringLength: 4_000, maxArrayLength: 50 },
  });
}

/** The `Log` every context gets: the process logger with fixed fields (the system, the run) added to every line. */
export class ScopedLog implements Log {
  readonly #logger: Logger;
  readonly #base: Readonly<Record<string, Json>>;

  constructor(logger: Logger, base: Readonly<Record<string, Json>>) {
    this.#logger = logger;
    this.#base = base;
  }

  /** The same logger with more fixed fields. */
  with(fields: Readonly<Record<string, Json>>): ScopedLog {
    return new ScopedLog(this.#logger, { ...this.#base, ...fields });
  }

  debug(key: string, fields?: Record<string, Json>): void {
    this.#logger.debug(key, { ...this.#base, ...fields });
  }

  info(key: string, fields?: Record<string, Json>): void {
    this.#logger.info(key, { ...this.#base, ...fields });
  }

  warn(key: string, fields?: Record<string, Json>): void {
    this.#logger.warn(key, { ...this.#base, ...fields });
  }

  error(key: string, fields?: Record<string, Json>, error?: unknown): void {
    if (error === undefined) {
      this.#logger.error(key, { ...this.#base, ...fields });
    } else {
      this.#logger.error(key, { ...this.#base, ...fields }, error instanceof Error ? error : new Error(messageOf(error)));
    }
  }
}
