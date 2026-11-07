/**
 * Password hashing with scrypt (`node:crypto`). A hash records its own parameters
 * (`scrypt$<log2 N>$<r>$<p>$<salt>$<key>`, base64url), so raising the cost later still verifies old hashes.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { PasswordHasher } from './index.ts';

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const BLOCK_SIZE = 8;
const PARALLEL = 1;
const PREFIX = 'scrypt';

/** The bytes scrypt needs for these parameters, with room to spare (node refuses above `maxmem`). */
const memoryFor = (cost: number, blockSize: number): number => 256 * 2 ** cost * blockSize;

function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallel: number): Promise<Buffer> {
  const options: ScryptOptions = { N: 2 ** cost, r: blockSize, p: parallel, maxmem: memoryFor(cost, blockSize) };
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, key) => { if (error === null) { resolve(key); } else { reject(error); } });
  });
}

/** The parts of a stored hash, or undefined when it isn't one of ours. */
function parse(hash: string): { cost: number; blockSize: number; parallel: number; salt: Buffer; key: Buffer } | undefined {
  const [prefix, cost, blockSize, parallel, salt, key, ...rest] = hash.split('$');
  if (prefix !== PREFIX || cost === undefined || blockSize === undefined || parallel === undefined || salt === undefined || key === undefined || rest.length > 0) {
    return undefined;
  }
  const numbers = [Number(cost), Number(blockSize), Number(parallel)] as const;
  if (!numbers.every((n) => Number.isInteger(n) && n > 0) || numbers[0] > 24) { return undefined; }
  return { cost: numbers[0], blockSize: numbers[1], parallel: numbers[2], salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') };
}

/** scrypt password hashing. `cost` is log2 of scrypt's N. */
export class ScryptHasher implements PasswordHasher {
  readonly #cost: number;

  constructor(cost: number) {
    this.#cost = cost;
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await derive(password, salt, this.#cost, BLOCK_SIZE, PARALLEL);
    return [PREFIX, this.#cost, BLOCK_SIZE, PARALLEL, salt.toString('base64url'), key.toString('base64url')].join('$');
  }

  async verify(password: string, hash: string): Promise<boolean> {
    const parts = parse(hash);
    if (parts === undefined || parts.key.length !== KEY_LENGTH) { return false; }
    const key = await derive(password, parts.salt, parts.cost, parts.blockSize, parts.parallel);
    return timingSafeEqual(key, parts.key);
  }
}
