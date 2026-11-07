/**
 * Password hashing for the hub's `PasswordHasher` port: ayepi's scrypt hashing (`@ayepi/auth/server`). A hash records
 * its own parameters (`scrypt$<log2 N>$<r>$<p>$<salt>$<key>`), so raising the cost later still verifies old hashes.
 */
import { hashPassword, verifyPassword } from '@ayepi/auth/server';
import type { PasswordHasher } from './index.ts';

/** scrypt password hashing at a set cost (log2 of scrypt's N). */
export class ScryptHasher implements PasswordHasher {
  readonly #cost: number;

  constructor(cost: number) {
    this.#cost = cost;
  }

  hash(password: string): Promise<string> {
    return hashPassword(password, { cost: this.#cost });
  }

  verify(password: string, hash: string): Promise<boolean> {
    return verifyPassword(password, hash);
  }
}
