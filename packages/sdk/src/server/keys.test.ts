import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoPairId } from '@harness/core';
import { describe, expect, it } from 'vitest';
import { AUTO_PAIR_FILE, FileKeyStore } from './keys.ts';

describe('FileKeyStore auto pair', () => {
  it('keeps the newest grant beside the key, private, and forgets it', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'harness-keys-'));
    try {
      const keys = new FileKeyStore(folder);
      expect(await keys.autoPair()).toBeUndefined();
      const grant = { id: AutoPairId.parse('apk_1'), secret: 'a'.repeat(43) };
      await keys.saveAutoPair(grant);
      await keys.saveAutoPair({ ...grant, secret: 'b'.repeat(43), expiresAt: 9 });
      expect(await new FileKeyStore(folder).autoPair()).toEqual({ ...grant, secret: 'b'.repeat(43), expiresAt: 9 });
      if (process.platform !== 'win32') { expect((await stat(join(folder, AUTO_PAIR_FILE))).mode & 0o777).toBe(0o600); }
      expect(await readFile(join(folder, AUTO_PAIR_FILE), 'utf8')).not.toContain('a'.repeat(43));
      await keys.saveAutoPair(undefined);
      expect(await keys.autoPair()).toBeUndefined();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
