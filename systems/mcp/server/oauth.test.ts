/**
 * OAuth sign-in to an MCP server over a scripted `fetch`: the server's challenge leads to its authorization server, the
 * instance registers a client, the person is sent to the PKCE URL with the server as the resource, the code becomes
 * tokens (with the client they belong to), refused tokens are refreshed and a signed request is tried once more.
 */
import { describe, expect, it } from 'vitest';
import { signedFetch } from './dial.ts';
import { OAuthSignIn } from './oauth.ts';

const SERVER = 'https://mcp.example/mcp';
const ISSUER = 'https://auth.example';
const REDIRECT = 'https://hub.example/connect/callback';

/** The server and its authorization server, answering what the flow asks; every request is kept. */
function scripted() {
  const seen: Array<{ url: string; method: string; body: string }> = [];
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '';
    seen.push({ url, method: init?.method ?? 'GET', body });
    if (url === SERVER) { return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp", scope="read write"' }); }
    if (url === 'https://mcp.example/.well-known/oauth-protected-resource/mcp') { return json({ resource: SERVER, authorization_servers: [ISSUER] }); }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, registration_endpoint: `${ISSUER}/register` });
    }
    if (url === `${ISSUER}/register`) { return json({ client_id: 'registered-1' }, 201); }
    if (url === `${ISSUER}/token`) {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'authorization_code') { return json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' }); }
      return json({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600 });
    }
    return new Response('not found', { status: 404 });
  };
  return { seen, fetcher };
}

describe('OAuth sign-in to an MCP server', () => {
  it('signs in through the challenge, a registered client and PKCE, then refreshes', async () => {
    const { seen, fetcher } = scripted();
    const oauth = new OAuthSignIn(SERVER, { kind: 'oauth', per: 'person' }, { fetch: fetcher, now: () => 1_000 });

    const { url } = await oauth.start({ connection: 'connection_1', redirect: REDIRECT, state: 'signed' });
    const sent = new URL(url);
    expect(sent.origin + sent.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(sent.searchParams)).toMatchObject({ client_id: 'registered-1', redirect_uri: REDIRECT, state: 'signed', resource: SERVER, scope: 'read write', code_challenge_method: 'S256' });

    const signedIn = await oauth.finish({ connection: 'connection_1', answer: { params: { code: 'code-1', state: 'signed' } } });
    expect(signedIn).toEqual({ credentials: { accessToken: 'access-1', tokenType: 'Bearer', clientId: 'registered-1', refreshToken: 'refresh-1' }, expiresAt: 1_000 + 3_600_000 });
    const exchange = new URLSearchParams(seen.findLast((request) => request.url === `${ISSUER}/token`)?.body);
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // a refresh keeps the refresh token the server didn't rotate
    if (!('credentials' in signedIn)) { throw new Error('no credentials'); }
    expect(await oauth.refresh(signedIn.credentials)).toEqual({ credentials: { accessToken: 'access-2', tokenType: 'Bearer', clientId: 'registered-1', refreshToken: 'refresh-1' }, expiresAt: 1_000 + 3_600_000 });

    expect(await oauth.finish({ connection: 'connection_2', answer: { params: { error: 'access_denied' } } })).toEqual({ problem: 'You didn\'t allow access.' });
    expect(await oauth.finish({ connection: 'connection_3', answer: { params: { code: 'x' } } })).toEqual({ problem: 'This sign-in was started before a restart; start it again.' });
  });

  it('refreshes refused credentials once and says when they stay refused', async () => {
    let token = 'old';
    let refused = 0;
    const base: typeof fetch = (_input, init) => Promise.resolve(new Response('', { status: new Headers(init?.headers).get('authorization') === 'Bearer new' ? 200 : 401 }));
    const signer = {
      headers: () => Promise.resolve({ authorization: `Bearer ${token}` }),
      refresh: () => { token = 'new'; return Promise.resolve(true); },
      refused: () => { refused += 1; },
    };
    expect((await signedFetch(base, signer)('https://mcp.example/mcp', { method: 'POST', body: '{}' })).status).toBe(200);
    expect(refused).toBe(0);
    const stuck = { ...signer, refresh: () => Promise.resolve(false), headers: () => Promise.resolve({ authorization: 'Bearer old' }) };
    expect((await signedFetch(base, stuck)('https://mcp.example/mcp')).status).toBe(401);
    expect(refused).toBe(1);
  });
});
