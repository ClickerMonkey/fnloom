/**
 * Test helpers for the store: an in-memory or temp-file store (the shared `testStore` with the test embedder), and row builders for the
 * tables the tests use. Only tests import this file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ActorId, LedgerId, NotificationId, RunId, SessionId, SystemName, type LedgerEntry, type Notification, type UserActor,
} from '@harness/core';
import type { StoreOptions } from './index.ts';
import type { SqliteStore } from './sqlite.ts';
import { testStore } from '../testing.ts';

/** The embedder the tests give vectors for, and its (small) dimensions. */
export const TEST_EMBEDDER = 'embedder/test';
export const TEST_DIMENSIONS = 3;

/** Open and migrate a store with the test embedder's table; `:memory:` unless a file is given. */
export function openTestStore(options: Partial<StoreOptions> = {}): Promise<SqliteStore> {
  return testStore({ dimensions: { [TEST_EMBEDDER]: TEST_DIMENSIONS }, ...options });
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
