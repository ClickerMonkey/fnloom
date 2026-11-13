/**
 * The real stdio dialer: a server process started with its environment, spoken to over its stdin and stdout, and its
 * exit noticed with the last thing it wrote to stderr.
 */
import { fileURLToPath } from 'node:url';
import { McpClient } from '@ayepi/mcp';
import { describe, expect, it } from 'vitest';
import { NodeDialers, UNSIGNED } from './dial.ts';

const SERVER = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));

describe('the stdio dialer', () => {
  it('starts the server with its env, calls it, and says why it exited', async () => {
    const opened = await new NodeDialers().dialer({ type: 'stdio', command: process.execPath, args: [SERVER], env: { GREETER: 'stdio' } }, UNSIGNED).open();
    const client = await McpClient.connect(opened.transport, { clientInfo: { name: 'test', version: '1' } });
    expect((await client.callTool('hello', {})).content).toEqual([{ type: 'text', text: 'hello from stdio' }]);
    await client.callTool('exit', {}).catch(() => undefined);
    expect(await opened.ended).toMatch(/exited \(code 3\): stopping on request$/);
    await opened.close();
  });
});
