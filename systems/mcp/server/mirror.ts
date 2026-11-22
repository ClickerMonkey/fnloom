/**
 * What a server's lists become in the hub, as declarations: each tool a fn of kind `mcp/tool` with its schemas read
 * as gin types, each prompt a context item with a `/command`, and what a tool's annotations may say about it (only
 * for a server the admin marked `trusted`). Pure: the instance (`instance.ts`) sends them as runtime patches and keeps
 * what it sent, so an unchanged entry is never sent twice and nothing is removed when a server stops listing it.
 */
import type { McpPrompt, McpPromptResult, McpTool, McpToolResult } from '@ayepi/mcp';
import {
  Json, mcpRootOf, ResourceUri, mcpToolFnName, type ContextDecl, type FnApproval, type FnDecl, type FnExample, type FnEffects, type FnMode, type InstanceName, type McpServerConfig, type McpToolSpec,
} from '@harness/core';
import { fnDecl, sampleArgs, type GinType } from '@harness/sdk';
import { z } from 'zod';
import { mcp, ToolOutputType, type ToolOutput } from '../shared/index.ts';
import { ginOfJsonSchema } from './schema.ts';

/** The tools a server lists, as fn declarations, with the ones left out past `maxTools` and those whose schema fell back. */
export interface MirroredTools {
  readonly fns: readonly FnDecl[];
  readonly degraded: readonly string[];
  readonly leftOut: number;
}

/** A tool read off the server's declaration: its payload, and its args and result as gin types. */
export interface ReadTool {
  readonly spec: McpToolSpec;
  readonly args: GinType;
  readonly returns: GinType;
}

/** A tool's mirror: its payload, and its args and result types (the plain `ToolOutput` when it declares no usable output schema). */
export function readTool(tool: McpTool): ReadTool {
  const input = ginOfJsonSchema(Json.parse(tool.inputSchema), { object: true });
  const output = tool.outputSchema === undefined ? undefined : ginOfJsonSchema(Json.parse(tool.outputSchema), { object: true });
  const degraded = [input.degraded === undefined ? '' : `input: ${input.degraded}`, output?.degraded === undefined ? '' : `output: ${output.degraded}`]
    .filter((why) => why !== '').join('; ');
  // an output schema that fell back is no better than the plain text result
  const typed = output !== undefined && output.degraded === undefined ? output : undefined;
  const spec: McpToolSpec = {
    tool: tool.name,
    description: tool.description ?? tool.annotations?.title ?? tool.title ?? tool.name,
    inputSchema: Json.parse(tool.inputSchema),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: Json.parse(tool.outputSchema) }),
    args: input.def,
    ...(typed === undefined ? {} : { returns: typed.def }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(degraded === '' ? {} : { degraded }),
  };
  return { spec, args: input.type, returns: typed?.type ?? ToolOutputType };
}

/** The server's tools as fns of this instance, sorted by name and cut at `maxTools`. */
export function mirrorTools(instance: InstanceName, config: Pick<McpServerConfig, 'label' | 'maxTools'>, tools: readonly McpTool[]): MirroredTools {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const read = sorted.slice(0, config.maxTools).map(readTool);
  const fns = read.map(({ spec, args, returns }) => fnDecl(mcpToolFnName(instance, spec.tool), mcp.kinds.tool.fn({
    description: `${config.label}: ${spec.description}`,
    payload: spec,
    args,
    returns,
    routing: { to: 'instance', instance },
    tags: ['mcp', instance],
  })));
  return { fns, degraded: read.filter((tool) => tool.spec.degraded !== undefined).map((tool) => tool.spec.tool), leftOut: sorted.length - read.length };
}

/**
 * What the admin's trust and approval policy make of a tool: its effects and whether its runs ask first. An untrusted
 * server's hints say nothing (every tool may write); a trusted one's read-only tools read, and a tool not marked
 * harmless counts as destructive, as MCP's defaults say.
 */
export function toolFacts(spec: Pick<McpToolSpec, 'annotations'>, config: Pick<McpServerConfig, 'trusted' | 'approval'>): { readonly effects: FnEffects; readonly approval?: FnApproval } {
  const hints = config.trusted ? spec.annotations : undefined;
  const mode: FnMode = hints === undefined ? 'write' : hints.readOnlyHint === true ? 'read' : hints.destructiveHint === false ? 'write' : 'delete';
  const asks = config.approval === 'always' || (config.approval === 'writes' && mode !== 'read');
  // "don't ask again" only for reads: a write or a delete asks every time
  return asks ? { effects: { mode }, approval: { preview: true, remember: mode === 'read', approver: 'person' } } : { effects: { mode } };
}

/** A JSON Schema's own `examples` of whole args objects, when it gives any. */
const SchemaExamples = z.object({ examples: z.array(z.record(z.string(), Json)).min(1) });

/**
 * A tool's examples (`KindDescription.examples`): the ones its input schema gives (JSON Schema `examples`), else its
 * args filled with sample values read off the schema.
 */
export function toolExamples(spec: Pick<McpToolSpec, 'tool' | 'inputSchema' | 'args'>): FnExample[] {
  const given = SchemaExamples.safeParse(spec.inputSchema);
  if (given.success) { return given.data.examples.map((args) => ({ args, note: `An example from the ${spec.tool} tool's input schema.` })); }
  return [{ args: sampleArgs(spec.args), note: `Sample args read off the ${spec.tool} tool's input schema: use real values.` }];
}

/** The `{{name}}` placeholders a prompt's text is fetched with, so the hub fills them when the command is used. */
export function placeholders(prompt: McpPrompt): Record<string, string> {
  return Object.fromEntries((prompt.arguments ?? []).map((arg) => [arg.name, `{{${arg.name}}}`]));
}

/** A filled prompt's messages as markdown: each message's role and text (other content said in words). */
export function promptText(result: McpPromptResult): string {
  return result.messages.map((message) => {
    const content = message.content;
    const body = content.type === 'text' ? content.text
      : content.type === 'resource' ? ('text' in content.resource ? content.resource.text : `[${content.resource.mimeType ?? 'binary'} resource ${content.resource.uri}]`)
        : content.type === 'resource_link' ? `[resource ${content.uri}]` : `[${content.type} ${content.mimeType}]`;
    return `**${message.role}:** ${body}`;
  }).join('\n\n');
}

/** A server's prompt as a context item with a `/command`; `text` is its content (fetched with the placeholders). */
export function promptDecl(instance: InstanceName, label: string, prompt: McpPrompt, text: string): ContextDecl {
  const name = mcpToolFnName(instance, prompt.name);
  const args = (prompt.arguments ?? []).map((arg) => ({ name: arg.name, hint: arg.description ?? arg.name, required: arg.required === true }));
  return {
    name,
    title: `${label}: ${prompt.title ?? prompt.name}`,
    description: prompt.description ?? `The ${prompt.name} prompt of ${label}.`,
    content: text,
    command: { name, args },
    imports: [], fns: [], suggestFns: [],
    suggest: 'user', visible: 'both',
    tags: ['mcp', instance],
  };
}

/** A resource URI on the server as a hub resource address under the instance's root, and back. */
export function hubUri(instance: InstanceName, serverUri: string): ResourceUri {
  return ResourceUri.parse(`${mcpRootOf(instance)}${encodeURIComponent(serverUri)}`);
}

/** The server's URI of a hub resource address under the instance's root; `undefined` for the root or another place. */
export function serverUri(instance: InstanceName, uri: string): string | undefined {
  const root = mcpRootOf(instance);
  if (!uri.startsWith(root) || uri.length === root.length) { return undefined; }
  return decodeURIComponent(uri.slice(root.length));
}

/** A tool's result as the fn's result: its structured content when it declared an output schema, else `ToolOutput`. */
export function toolResult(instance: InstanceName, spec: Pick<McpToolSpec, 'returns'>, result: McpToolResult): Json {
  if (spec.returns !== undefined && result.structuredContent !== undefined) { return Json.parse(result.structuredContent); }
  const resources: NonNullable<ToolOutput['resources']> = [];
  const text = result.content.map((block) => {
    switch (block.type) {
      case 'text': return block.text;
      case 'resource_link':
        resources.push({ uri: hubUri(instance, block.uri), name: block.name, ...(block.mimeType === undefined ? {} : { mime: block.mimeType }) });
        return `[resource ${block.name}]`;
      case 'resource':
        resources.push({ uri: hubUri(instance, block.resource.uri), ...(block.resource.mimeType === undefined ? {} : { mime: block.resource.mimeType }) });
        return 'text' in block.resource ? block.resource.text : `[resource ${block.resource.uri}]`;
      case 'image':
      case 'audio': return `[${block.type} ${block.mimeType}]`;
    }
  }).join('\n');
  const output: ToolOutput = {
    text,
    ...(result.structuredContent === undefined ? {} : { structured: Json.parse(result.structuredContent) }),
    ...(resources.length === 0 ? {} : { resources }),
  };
  return Json.parse(output);
}

/** What was last sent per name, so only changed entries go to the hub. */
export class Sent {
  readonly #by = new Map<string, string>();

  /** The entries that differ from what was last sent (and remembers them as sent). */
  changed<T extends { readonly name: string }>(entries: readonly T[]): T[] {
    return entries.filter((entry) => {
      const text = JSON.stringify(entry);
      if (this.#by.get(entry.name) === text) { return false; }
      this.#by.set(entry.name, text);
      return true;
    });
  }

  /** Forget everything (the hub lost what it had, or the config changed how entries are made). */
  clear(): void {
    this.#by.clear();
  }
}
