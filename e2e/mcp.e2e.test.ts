/**
 * Hub MCPs on the real stack: an admin makes an MCP over fs (shell excluded), an MCP client (`@ayepi/mcp`'s own, over
 * Streamable HTTP) lists its tools and reads a file through it, and the read is a real run the hub recorded,
 * attributed to the MCP's actor, with its metrics folded. A rotated secret stops the old one working.
 */
import { McpClient, McpHttpClientTransport } from '@ayepi/mcp';
import { McpSlug, SystemName } from '@harness/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import type { SignedIn } from '../scripts/hub-client.ts';
import { admin, settle } from './kit.ts';

let me: SignedIn;
const slug = McpSlug.parse(`e2e-${Date.now().toString(36)}`);

/** A client of the MCP with a bearer. */
function connect(secret: string): Promise<McpClient> {
  const transport = new McpHttpClientTransport(`${inject('e2eHub').url}/mcp/${slug}`, { headers: { authorization: `Bearer ${secret}` } });
  return McpClient.connect(transport, { clientInfo: { name: 'harness-e2e', version: '1' } });
}

beforeAll(async () => {
  me = await admin();
  await settle(me);
});

afterAll(() => { me.close(); });

describe('hub MCPs', () => {
  let secret = '';
  let mcpId = '';

  it('are made by an admin, with the secret shown once', async () => {
    const user = await me.hub.call('me');
    const made = await me.hub.call('createMcp', {
      slug, name: 'e2e', instructions: 'Read files.', toolMode: 'each', user: user.id, grantees: [], origins: [], enabled: true,
      rules: { include: { systems: [SystemName.parse('fs')] }, exclude: { fns: [{ fn: 'fs/bash' }] } },
    });
    secret = made.secret;
    mcpId = made.mcp.id;
    expect(secret.startsWith('hmcp_')).toBe(true);
    expect(made.mcp).not.toHaveProperty('secretDigest');
    const preview = await me.hub.call('previewMcp', { rules: made.mcp.rules });
    expect(preview.fns).toContain('fs/read');
    expect(preview.fns).not.toContain('fs/bash');
  });

  it('serve the exposed fns to an MCP client, and run a call as a real run', async () => {
    const client = await connect(secret);
    const tools = (await client.listTools()).map((t) => t.name);
    expect(tools).toContain('fs_read');
    expect(tools).not.toContain('fs_bash');
    const result = await client.callTool('fs_read', { path: 'README.md' });
    expect(result.isError).not.toBe(true);
    const mcp = await me.hub.call('mcp', { mcp: mcpId });
    const runs = await me.hub.call('runs', { query: { filters: [{ field: 'fn', op: 'is' as const, value: 'fs/read' }], limit: 20 } });
    expect(runs.items.some((run) => run.caller === mcp.actor && run.status === 'done')).toBe(true);
    expect(mcp.callsToday).toBeGreaterThanOrEqual(1);
    const sessions = await me.hub.call('mcpSessions', { mcp: mcp.id });
    expect(sessions.some((s) => s.client?.name === 'harness-e2e')).toBe(true);
    await client.close();
  });

  it('refuse the old secret once it is rotated', async () => {
    const { secret: fresh } = await me.hub.call('rotateMcpSecret', { mcp: mcpId });
    await expect(connect(secret)).rejects.toThrow();
    const client = await connect(fresh);
    expect((await client.listTools()).length).toBeGreaterThan(0);
    await client.close();
    await me.hub.call('deleteMcp', { mcp: mcpId });
  });
});
