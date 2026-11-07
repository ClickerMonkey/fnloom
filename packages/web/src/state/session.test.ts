import { Tokens } from '@harness/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokens = Tokens.parse({
  access: 'a.b.c',
  refresh: 'r1',
  expiresIn: 900_000,
  user: { id: 'act_1', kind: 'user', name: 'Ada', email: 'ada@example.com', role: 'admin' },
});

describe('session state', () => {
  beforeEach(() => { window.localStorage.clear(); vi.resetModules(); });

  it('keeps tokens across a reload and forgets them on sign-out', async () => {
    const first = await import('./session.ts');
    expect(first.signedIn.value).toBe(false);
    first.keepTokens(tokens);
    expect(first.accessToken.value).toBe('a.b.c');

    vi.resetModules();
    const reloaded = await import('./session.ts');
    expect(reloaded.signedIn.value).toBe(true);
    expect(reloaded.currentUser.value?.name).toBe('Ada');

    reloaded.forgetTokens();
    expect(reloaded.signedIn.value).toBe(false);
    expect(window.localStorage.getItem('harness.session')).toBeNull();
  });

  it('ignores a stored value that does not match the schema', async () => {
    window.localStorage.setItem('harness.session', JSON.stringify({ access: 1 }));
    const session = await import('./session.ts');
    expect(session.signedIn.value).toBe(false);
  });
});
