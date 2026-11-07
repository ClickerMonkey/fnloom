import { describe, expect, it } from 'vitest';
import { ScryptHasher } from './hash.ts';

describe('ScryptHasher', () => {
  const hasher = new ScryptHasher(10);

  it('verifies the password it hashed and refuses another', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(/^scrypt\$10\$8\$1\$[\w-]+\$[\w-]+$/);
    await expect(hasher.verify('correct horse battery', hash)).resolves.toBe(true);
    await expect(hasher.verify('correct horse batterz', hash)).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hasher.hash('same')).not.toBe(await hasher.hash('same'));
  });

  it('verifies hashes made with another cost (the hash records its parameters)', async () => {
    const old = await new ScryptHasher(11).hash('pw');
    await expect(hasher.verify('pw', old)).resolves.toBe(true);
  });

  it.each(['', 'plain', 'scrypt$10$8$1$c2FsdA', 'bcrypt$10$8$1$a$b', 'scrypt$99$8$1$a$b', 'scrypt$x$8$1$a$b', 'scrypt$10$8$1$c2FsdA$c2hvcnQ'])(
    'refuses a malformed hash %j', async (hash) => {
      await expect(hasher.verify('pw', hash)).resolves.toBe(false);
    },
  );
});
