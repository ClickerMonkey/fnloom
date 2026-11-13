/** A tiny MCP server over stdio for the dial test: one tool that greets with `GREETER`, and one that exits. */
import { createInterface } from 'node:readline';
import { McpToolSet, mcpToolServer, serveStdio, textResult } from '@ayepi/mcp';

const tools = new McpToolSet()
  .define({ name: 'hello', inputSchema: { type: 'object' }, run: () => textResult(`hello from ${process.env['GREETER'] ?? 'nobody'}`) })
  .define({ name: 'exit', inputSchema: { type: 'object' }, run: () => { process.stderr.write('stopping on request\n'); process.exit(3); } });
await serveStdio(mcpToolServer(tools), { input: createInterface({ input: process.stdin }), output: { write: (line) => { process.stdout.write(`${line}\n`); } } });
