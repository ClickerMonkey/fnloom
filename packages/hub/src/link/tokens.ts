/** Short-lived HTTP tokens for linked systems, signed with the hub's JWT secret (`@ayepi/auth`). */
import { signJwt } from '@ayepi/auth/server';
import type { LinkSession } from '@harness/core';
import type { SystemTokens } from './index.ts';

/** The claims of a system's HTTP token. */
export interface SystemTokenClaims {
  readonly sub: string;
  readonly kind: 'system';
  readonly instance: string;
}

/** Signs system tokens as HS256 JWTs. `ttl` is in milliseconds. */
export class JwtSystemTokens implements SystemTokens {
  readonly #secret: string;
  readonly #ttl: number;

  constructor(options: { secret: string; ttl: number }) {
    this.#secret = options.secret;
    this.#ttl = options.ttl;
  }

  issue(session: LinkSession): string {
    const claims: SystemTokenClaims = { sub: session.system, kind: 'system', instance: session.instance };
    return signJwt(claims, { secret: this.#secret, expiresIn: Math.max(1, Math.round(this.#ttl / 1000)), audience: 'harness-system' }).token;
  }
}
