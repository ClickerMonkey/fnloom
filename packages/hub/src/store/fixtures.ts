/**
 * Test helpers for the store: an in-memory or temp-file store that logs into an array, and row builders for the
 * tables the tests use. Only tests import this file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActorId, LedgerId, NotificationId, RunId, SessionId, SystemName, type LedgerEntry, type Notification, type UserActor,
} from '@harness/core';
import { type LogRecord, type Logger, createLogger } from '@ayepi/log';
import type { StoreOptions } from './index.ts';
import { SqliteStore } from './sqlite.ts';

/** The embedder the tests give vectors for, and its (small) dimensions. */
export const TEST_EMBEDDER = 'embedder/test';
export const TEST_DIMENSIONS = 3;

/** A logger that keeps its records. */
export function memoryLog(): { log: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const log = createLogger({ level: 'debug', transports: [{ name: 'memory', write: (record) => { records.push(record); } }] });
  return { log, records };
}

/** Open and migrate a store; `:memory:` unless a file is given. */
export async function openTestStore(options: Partial<StoreOptions> = {}): Promise<SqliteStore> {
  const store = SqliteStore.open({ file: ':memory:', dimensions: { [TEST_EMBEDDER]: TEST_DIMENSIONS }, log: memoryLog().log, ...options });
  await store.migrate();
  return store;
}

/** A temporary folder, removed by `dispose`. */
export function tempDir(): { dir: string; file: (name: string) => string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-store-'));
  return { dir, file: (name) => join(dir, name), dispose: () => { rmSync(dir, { recursive: true, force: true }); } };
}

export const actorId = (n: number | string) => ActorId.parse(`act_${n}`);

export function user(n: number, fields: Partial<UserActor> = {}): UserActor {
  return {
    id: actorId(n), kind: 'user', name: `User ${n}`, about: '', createdAt: 1_000 + n, disabled: false, email: `u${n}@example.com`, role: 'member',
    ...fields,
  };
}

export function ledger(n: number, fields: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: LedgerId.parse(`led_${String(n).padStart(4, '0')}`), at: 10_000 + n, cost: n / 100, tokens: n * 10, actor: actorId(1), fn: 'hub/chat',
    run: RunId.parse(`run_${n}`), ...fields,
  };
}

export function notification(n: number, fields: Partial<Notification> = {}): Notification {
  return {
    id: NotificationId.parse(`ntf_${n}`), user: actorId(1), reason: 'replied', title: `Title ${n}`, body: 'body', link: { session: SessionId.parse('ses_1') },
    read: false, pushed: false, createdAt: 5_000 + n, ...fields,
  };
}

export const systemName = (name: string) => SystemName.parse(name);
