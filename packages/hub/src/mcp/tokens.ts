/**
 * Session tokens minted from a hub MCP (`McpTokens`): short-lived HS256 JWTs (`@ayepi/auth`) carrying
 * `McpTokenClaims`, for the MCP's grantee systems (a Claude system gives each Claude Code session its own labelled
 * credential, and the endpoint secret never leaves the hub). The signing secret is the hub's own, made once and kept
 * in the store, so tokens outlive a restart; revoking is "stop minting" plus the short lifetime.
 */
import { randomBytes } from 'node:crypto';
import { signJwt, verifyJwt } from '@ayepi/auth/server';
import { reject } from '@ayepi/core';
import type { Logger } from '@ayepi/log';
import { McpTokenClaims, type HubMcpId, type SystemName } from '@harness/core';
import type { HubKeyValue } from '../store/index.ts';
import type { McpRegistry, McpTokens } from './index.ts';

/** The audience every MCP session token names, so no other hub token passes as one. */
export const MCP_TOKEN_AUDIENCE = 'harness-mcp';
/** Where the signing secret is kept. */
const SECRET_KEY = 'mcp:token-secret';

/** What the tokens use. */
export interface JwtMcpTokensDeps {
  readonly keys: () => HubKeyValue;
  readonly registry: () => Pick<McpRegistry, 'record'>;
  readonly clock: () => number;
  readonly log: Logger;
  /** The longest a token may last (`HARNESS_HUB_MCP_TOKEN_TTL`). */
  readonly maxTtl: number;
}

/** MCP session tokens as JWTs. */
export class JwtMcpTokens implements McpTokens {
  readonly #deps: JwtMcpTokensDeps;
  #secret: Promise<string> | undefined;

  constructor(deps: JwtMcpTokensDeps) {
    this.#deps = deps;
  }

  async mint(input: { mcp: HubMcpId; label: string; ttl: number; system: SystemName }): Promise<{ token: string; expiresAt: number }> {
    const record = await this.#deps.registry().record(input.mcp);
    if (record?.enabled !== true) throw reject(404, 'MCP_NOT_FOUND', `no hub MCP ${input.mcp}`);
    if (!record.grantees.includes(input.system)) throw reject(403, 'NOT_A_GRANTEE', `${input.system} may not mint tokens for /mcp/${record.slug}`);
    const seconds = Math.max(1, Math.round(Math.min(input.ttl, this.#deps.maxTtl) / 1000));
    const now = this.#deps.clock();
    const claims: McpTokenClaims = { mcp: input.mcp, label: input.label, exp: Math.floor(now / 1000) + seconds };
    const { token } = signJwt(claims, { secret: await this.#key(), expiresIn: seconds, audience: MCP_TOKEN_AUDIENCE });
    this.#deps.log.info('mcp.token.minted', { mcp: input.mcp, label: input.label, system: input.system, ttl: seconds * 1000 });
    return { token, expiresAt: now + seconds * 1000 };
  }

  async verify(token: string): Promise<McpTokenClaims | undefined> {
    try {
      const payload = verifyJwt(token, { secret: await this.#key(), audience: MCP_TOKEN_AUDIENCE });
      const claims = McpTokenClaims.safeParse(payload);
      return claims.success ? claims.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** The signing secret: made once, kept in the store's key/value port. */
  #key(): Promise<string> {
    this.#secret ??= (async () => {
      const keys = this.#deps.keys();
      await keys.setIfNotExists(SECRET_KEY, randomBytes(32).toString('base64url'));
      const secret = await keys.get(SECRET_KEY);
      if (secret === undefined) throw new Error('the MCP token secret could not be kept');
      return secret;
    })();
    return this.#secret;
  }
}
