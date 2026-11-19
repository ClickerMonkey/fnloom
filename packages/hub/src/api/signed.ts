/**
 * Signed, expiring payloads the hub hands a browser or a provider and reads back: a connect sign-in's `state`
 * (`connections/service.ts`) and an SSO sign-in's binding cookie (`api/sso.ts`). A payload is JSON with the time it
 * stops working, base64url, then an HMAC-SHA256 over it: `<payload>.<signature>`. Each start of the hub may use a new
 * key, so a sign-in in flight across a restart starts again.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** When a payload stops working, beside its own fields. */
const Until = z.object({ u: z.number() });

/** Signs payloads and reads them back while they are good. */
export class SignedPayloads {
  readonly #key: Buffer;
  readonly #clock: () => number;

  /** `key` signs (a fresh random one when not given); `clock` says when a payload has expired. */
  constructor(clock: () => number, key: Buffer = randomBytes(32)) {
    this.#key = key;
    this.#clock = clock;
  }

  /** `<payload>.<signature>`: the fields, good until `until` (epoch ms). */
  sign(fields: Readonly<Record<string, unknown>>, until: number): string {
    const payload = Buffer.from(JSON.stringify({ ...fields, u: until })).toString('base64url');
    return `${payload}.${this.#mac(payload)}`;
  }

  /** The fields of a payload this signed, read with `schema`; undefined when it is forged, malformed or expired. */
  read<S extends z.ZodType>(schema: S, signed: string | undefined): z.output<S> | undefined {
    const [payload, signature, extra] = (signed ?? '').split('.');
    if (payload === undefined || signature === undefined || extra !== undefined || !sameText(this.#mac(payload), signature)) return undefined;
    const json = parseJson(Buffer.from(payload, 'base64url').toString('utf8'));
    const until = Until.safeParse(json);
    if (!until.success || until.data.u <= this.#clock()) return undefined;
    const fields = schema.safeParse(json);
    return fields.success ? fields.data : undefined;
  }

  #mac(payload: string): string {
    return createHmac('sha256', this.#key).update(payload).digest('base64url');
  }
}

/** A fresh random secret, base64url: a browser binding, a test sign-in's id. */
export function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** The SHA-256 of a text, base64url. */
export function sha256Url(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}

/** Equal texts, compared in constant time. */
export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** JSON text's value, or undefined when it isn't JSON. */
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
