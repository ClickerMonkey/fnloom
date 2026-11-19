/**
 * The test server's content: tools, resources and prompts it offers. Every kind has an entry that exercises a
 * different path in a client: a read-only tool, a destructive one (approval gates), one that fails, one that reports
 * who called it (proves the sign-in reached the server), a listed resource, a resource template, a blob, and prompts
 * with required and optional arguments.
 */
import {
  errorResult, jsonResult, textResult,
  type McpCaller, type McpPromptSource, type McpResourceContents, type McpResourceSource, type McpSources, type McpToolSource,
} from '@ayepi/mcp';

const NO_ARGS = { type: 'object', properties: {} } as const;

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, boolean>;
  run(args: Readonly<Record<string, unknown>>, caller: McpCaller): ReturnType<typeof textResult>;
}

const TOOLS: readonly Tool[] = [
  {
    name: 'echo',
    description: 'Returns the text it is given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
    run: (args) => textResult(String(args.text)),
  },
  {
    name: 'add',
    description: 'Adds two numbers and returns structured content.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    annotations: { readOnlyHint: true },
    run: (args) => jsonResult({ sum: Number(args.a) + Number(args.b) }),
  },
  {
    name: 'now',
    description: 'The server clock, as an ISO timestamp.',
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true },
    run: () => textResult(new Date().toISOString()),
  },
  {
    name: 'whoami',
    description: 'Reports the session and the subject the sign-in let in (null when the server has no sign-in).',
    inputSchema: NO_ARGS,
    annotations: { readOnlyHint: true },
    run: (_args, caller) => jsonResult({ session: caller.session, subject: caller.auth?.subject ?? null, scopes: caller.auth?.scopes ?? [] }),
  },
  {
    name: 'delete_note',
    description: 'Pretends to delete a note. Marked destructive, so approval gates should catch it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { destructiveHint: true },
    run: (args) => textResult(`deleted note ${String(args.id)} (pretend)`),
  },
  {
    name: 'boom',
    description: 'Always fails with an error result.',
    inputSchema: NO_ARGS,
    run: () => errorResult('boom: this tool always fails'),
  },
];

const tools: McpToolSource = {
  tools: () => TOOLS.map(({ run: _run, ...tool }) => tool),
  call: async (name, args, _signal, caller) => TOOLS.find((tool) => tool.name === name)?.run(args, caller),
};

const NOTES: Readonly<Record<string, string>> = { '1': 'Buy milk', '2': 'Call the dentist' };

const BLOB = Buffer.from([0, 1, 2, 3, 254, 255]);

const RESOURCE_BODIES: Readonly<Record<string, McpResourceContents>> = {
  'demo://readme': {
    uri: 'demo://readme',
    mimeType: 'text/markdown',
    text: '# Harness test server\n\nTools, resources and prompts for checking an MCP integration.\n',
  },
  'demo://config.json': {
    uri: 'demo://config.json',
    mimeType: 'application/json',
    text: JSON.stringify({ name: 'harness-test', version: '0.1.0', features: ['tools', 'resources', 'prompts'] }, null, 2),
  },
  'demo://blob.bin': { uri: 'demo://blob.bin', mimeType: 'application/octet-stream', blob: BLOB.toString('base64') },
};

const resources: McpResourceSource = {
  list: async () => ({
    resources: [
      { uri: 'demo://readme', name: 'readme', title: 'Readme', mimeType: 'text/markdown', description: 'What this server is.' },
      { uri: 'demo://config.json', name: 'config', title: 'Config', mimeType: 'application/json' },
      { uri: 'demo://blob.bin', name: 'blob', title: 'Binary blob', mimeType: 'application/octet-stream', size: BLOB.length },
    ],
  }),
  templates: () => [{ uriTemplate: 'demo://notes/{id}', name: 'note', title: 'Note', description: 'Notes 1 and 2.', mimeType: 'text/plain' }],
  read: async (uri) => {
    const body = RESOURCE_BODIES[uri];
    if (body !== undefined) { return [body]; }
    const match = /^demo:\/\/notes\/(.+)$/.exec(uri);
    const note = match === null ? undefined : NOTES[match[1] ?? ''];
    return note === undefined ? undefined : [{ uri, mimeType: 'text/plain', text: note }];
  },
};

interface Prompt {
  readonly name: string;
  readonly description: string;
  readonly arguments: { name: string; description?: string; required?: boolean }[];
  render(args: Readonly<Record<string, string>>): string;
}

const PROMPTS: readonly Prompt[] = [
  {
    name: 'greet',
    description: 'A greeting for someone.',
    arguments: [
      { name: 'name', description: 'Who to greet.', required: true },
      { name: 'tone', description: 'casual or formal (optional).' },
    ],
    render: (args) => (args.tone === 'formal' ? `Good day, ${args.name}. It is a pleasure to meet you.` : `Hey ${args.name}!`),
  },
  {
    name: 'summarize',
    description: 'Asks for a summary of a text.',
    arguments: [{ name: 'text', description: 'The text to summarize.', required: true }],
    render: (args) => `Summarize in one sentence:\n\n${args.text}`,
  },
];

const prompts: McpPromptSource = {
  prompts: () => PROMPTS.map(({ render: _render, ...prompt }) => prompt),
  get: async (name, args) => {
    const prompt = PROMPTS.find((candidate) => candidate.name === name);
    if (prompt === undefined) { return undefined; }
    return {
      description: prompt.description,
      messages: [{ role: 'user', content: { type: 'text', text: prompt.render(args) } }],
    };
  },
};

/** Everything the server offers, for `mcpSourceServer`. */
export const SOURCES: McpSources = { tools, resources, prompts };

/** The implementation info and instructions the server reports on `initialize`. */
export const SERVER_INFO = {
  serverInfo: { name: 'harness-test-mcp', version: '0.1.0' },
  instructions: 'Test server for the harness MCP integration: tools, resources and prompts.',
} as const;
