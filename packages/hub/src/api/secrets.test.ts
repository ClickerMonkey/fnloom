import { describe, expect, it } from 'vitest';
import { ActorId, SecretId } from '@harness/core';
import { testStore } from '../testing.ts';
import { AesSecretVault, SecretBox } from './secrets.ts';

describe('SecretBox', () => {
  const box = new SecretBox('a-key-that-is-long-enough-for-the-hub-0123');

  it('opens what it sealed, and seals the same text differently each time', () => {
    const sealed = box.seal('sk-or-123');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('sk-or-123');
    expect(box.open(sealed)).toBe('sk-or-123');
    expect(box.seal('sk-or-123')).not.toBe(sealed);
  });

  it('refuses text sealed with another key, changed, or not sealed at all', () => {
    const sealed = box.seal('secret');
    expect(new SecretBox('another-key-that-is-long-enough-0123456789').open(sealed)).toBeUndefined();
    const [version, iv, tag, body] = sealed.split('.');
    const flipped = `${body?.startsWith('A') === true ? 'B' : 'A'}${body?.slice(1) ?? ''}`;
    expect(box.open([version, iv, tag, flipped].join('.'))).toBeUndefined();
    expect(box.open('v2.a.b.c')).toBeUndefined();
    expect(box.open('nonsense')).toBeUndefined();
  });
});

describe('AesSecretVault', () => {
  it('stores sealed, reveals plain, and removes', async () => {
    const store = await testStore();
    const vault = new AesSecretVault({ store, box: new SecretBox('a-key-that-is-long-enough-for-the-hub-0123'), clock: () => 5 });
    const id = await vault.store({ name: 'provider:openrouter', owner: ActorId.parse('act_admin'), value: 'sk-or-abc' });
    const row = await store.table('secrets').get(id);
    expect(row?.ciphertext).not.toContain('sk-or-abc');
    expect(row?.createdAt).toBe(5);
    await expect(vault.reveal(id)).resolves.toBe('sk-or-abc');
    await expect(vault.remove(id)).resolves.toBe(true);
    await expect(vault.reveal(id)).resolves.toBeUndefined();
    await expect(vault.reveal(SecretId.parse('sec_missing'))).resolves.toBeUndefined();
  });
});
