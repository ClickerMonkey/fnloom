/**
 * Between aeye's in-memory LLM shapes and their JSON projections in core (`LlmMessage`, `LlmRequest`, `LlmChunk`,
 * `LlmUsage`, `LlmResponse`). Saved transcripts, saved interactions and forwarded requests all go through here, so
 * there is one mapping each way. Zod schemas can't cross the wire: tool and output schemas travel as JSON schema and
 * are rebuilt with zod's `fromJSONSchema`.
 */
import type { Chunk, Message, MessageContent, Request, Resource, Response, ToolCall, ToolDefinition, Usage } from '@aeye/core';
import {
  Json, type FinishReason, type LlmChunk, type LlmContentPart, type LlmMessage, type LlmRequest, type LlmResponse, type LlmToolCall,
  type LlmToolSpec, type LlmUsage, type QualifiedName,
} from '@harness/core';
import { z } from 'zod';

// ─── Tool names ───────────────────────────────────────────────────────────────

/**
 * A fn's name as an LLM tool name. Providers allow only letters, digits, `_` and `-` (at most 64), so `/` becomes
 * `__` and `.` (methods) becomes `--`. The prompt keeps a map back to the fn, so the encoding never needs reversing.
 */
export function toolName(fn: QualifiedName): string {
  return fn.replaceAll('/', '__').replaceAll('.', '--').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

// ─── Messages ─────────────────────────────────────────────────────────────────

/** A content resource as text: strings as they are, URLs as their address, bytes as a data URL. */
function resourceText(resource: Resource, format: string | undefined): string {
  if (typeof resource === 'string') return resource;
  if (resource instanceof URL) return resource.href;
  if (resource instanceof Uint8Array) return `data:${format === undefined ? 'application/octet-stream' : mimeOf(format)};base64,${Buffer.from(resource).toString('base64')}`;
  return '[binary content]';
}

/** A MIME type for a short format name (`png` → `image/png`); a format that already is one stays. */
function mimeOf(format: string): string {
  if (format.includes('/')) return format;
  const known: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav' };
  return known[format] ?? `application/${format}`;
}

function partToWire(part: MessageContent): LlmContentPart {
  return {
    type: part.type,
    content: resourceText(part.content, part.format),
    ...(part.format === undefined ? {} : { format: part.format }),
    ...(part.name === undefined ? {} : { name: part.name }),
  };
}

function partFromWire(part: LlmContentPart): MessageContent {
  return {
    type: part.type,
    content: part.content,
    ...(part.format === undefined ? {} : { format: part.format }),
    ...(part.name === undefined ? {} : { name: part.name }),
  };
}

function callToWire(call: ToolCall): LlmToolCall {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

/** An aeye message as it is saved. Provider caches and reasoning details stay behind. */
export function messageToWire(message: Message): LlmMessage {
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content.map(partToWire),
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map(callToWire) }),
    ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
    ...(message.tokens === undefined ? {} : { tokens: message.tokens }),
  };
}

/** A saved message as an aeye message. */
export function messageFromWire(message: LlmMessage): Message {
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content.map(partFromWire),
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map(callToWire) }),
    ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
    ...(message.tokens === undefined ? {} : { tokens: message.tokens }),
  };
}

/** The text of a tool reply the model reads: strings as they are, anything else as JSON (as aeye writes them). */
export function replyText(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// ─── Usage, chunks and responses ─────────────────────────────────────────────

/** aeye usage as the hub meters it. */
export function usageToWire(usage: Usage | undefined): LlmUsage {
  const text = usage?.text;
  const reasoning = usage?.reasoning?.output;
  return {
    input: text?.input ?? 0,
    output: text?.output ?? 0,
    ...(text?.cached === undefined ? {} : { cached: text.cached }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** The tokens a call used, for the ledger. */
export function tokensOf(usage: LlmUsage): number {
  return usage.input + usage.output + (usage.reasoning ?? 0);
}

/** One streamed aeye chunk as it travels to a system. */
export function chunkToWire(chunk: Chunk): LlmChunk {
  const reasoning = chunk.reasoning?.content;
  return {
    ...(chunk.content === undefined ? {} : { content: chunk.content }),
    ...(typeof reasoning === 'string' ? { reasoning } : {}),
    ...(chunk.toolCallNamed === undefined ? {} : { toolCallNamed: callToWire(chunk.toolCallNamed) }),
    ...(chunk.toolCallArguments === undefined ? {} : { toolCallArguments: callToWire(chunk.toolCallArguments) }),
    ...(chunk.toolCall === undefined ? {} : { toolCall: callToWire(chunk.toolCall) }),
    ...(chunk.finishReason === undefined ? {} : { finishReason: chunk.finishReason }),
    ...(chunk.refusal === undefined ? {} : { refusal: chunk.refusal }),
    ...(chunk.usage === undefined ? {} : { usage: usageToWire(chunk.usage) }),
  };
}

/** A streamed chunk from the wire as an aeye chunk. */
export function chunkFromWire(chunk: LlmChunk): Chunk {
  return {
    ...(chunk.content === undefined ? {} : { content: chunk.content }),
    ...(chunk.reasoning === undefined ? {} : { reasoning: { content: chunk.reasoning } }),
    ...(chunk.toolCallNamed === undefined ? {} : { toolCallNamed: chunk.toolCallNamed }),
    ...(chunk.toolCallArguments === undefined ? {} : { toolCallArguments: chunk.toolCallArguments }),
    ...(chunk.toolCall === undefined ? {} : { toolCall: chunk.toolCall }),
    ...(chunk.finishReason === undefined ? {} : { finishReason: chunk.finishReason }),
    ...(chunk.refusal === undefined ? {} : { refusal: chunk.refusal }),
    ...(chunk.usage === undefined ? {} : { usage: usageFromWire(chunk.usage) }),
  };
}

function usageFromWire(usage: LlmUsage): Usage {
  return {
    text: { input: usage.input, output: usage.output, ...(usage.cached === undefined ? {} : { cached: usage.cached }) },
    ...(usage.reasoning === undefined ? {} : { reasoning: { output: usage.reasoning } }),
  };
}

/** A whole response as it is saved with its interaction. */
export function responseToWire(response: Response, finished: boolean): LlmResponse {
  const reasoning = response.reasoning?.content;
  const finishReason: FinishReason = finished ? response.finishReason : 'stop';
  return {
    content: response.content,
    ...(typeof reasoning === 'string' && reasoning !== '' ? { reasoning } : {}),
    ...(response.toolCalls === undefined || response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls.map(callToWire) }),
    finishReason,
    ...(response.refusal === undefined ? {} : { refusal: response.refusal }),
  };
}

// ─── Requests ─────────────────────────────────────────────────────────────────

/** A zod schema as JSON schema (the form saved and forwarded). Parts JSON schema can't express become `{}`. */
export function jsonSchemaOf(schema: z.ZodType): Json {
  return Json.parse(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));
}

/** A strict policy as the wire carries it: on, or off. aeye's numeric preference counts as on. */
function strictToWire(strict: boolean | number | undefined): boolean | undefined {
  return strict === undefined ? undefined : typeof strict === 'boolean' ? strict : strict > 0;
}

function toolToWire(tool: ToolDefinition): LlmToolSpec {
  const strict = strictToWire(tool.strict);
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: jsonSchemaOf(tool.parameters),
    ...(strict === undefined ? {} : { strict }),
  };
}

function toolChoiceToWire(choice: Request['toolChoice']): LlmRequest['toolChoice'] {
  if (choice === undefined || typeof choice === 'string' || 'tool' in choice) return choice;
  return choice.required === true ? 'required' : 'auto';
}

function formatToWire(format: Request['responseFormat']): LlmRequest['responseFormat'] {
  if (format === undefined || typeof format === 'string') return format;
  return { schema: jsonSchemaOf(format.type), strict: strictToWire(format.strict) ?? false };
}

/** An aeye request as it is saved with its interaction. */
export function requestToWire(request: Request): LlmRequest {
  const toolChoice = toolChoiceToWire(request.toolChoice);
  const responseFormat = formatToWire(request.responseFormat);
  const stop = request.stop === undefined ? undefined : typeof request.stop === 'string' ? [request.stop] : request.stop;
  return {
    messages: request.messages.map(messageToWire),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(stop === undefined ? {} : { stop }),
    ...(request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools.map(toolToWire) }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
  };
}

/** The outer shape of a JSON schema object; zod's `fromJSONSchema` checks the rest. */
const JsonSchemaObject = z.custom<z.core.JSONSchema.JSONSchema>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), {
  message: 'Expected a JSON schema object.',
});

/**
 * Whether a zod schema describes objects. It reads the schema's definition rather than using `instanceof`, so it
 * holds for schemas made by another copy of zod (gin's).
 */
export function isObjectSchema(schema: z.ZodType): schema is z.ZodType<object, object> {
  return schema._zod.def.type === 'object';
}

/** A JSON schema rebuilt as a zod schema of objects; refused when it doesn't describe an object. */
function objectSchemaFromWire(schema: Json, what: string): z.ZodType<object, object> {
  const rebuilt = z.fromJSONSchema(JsonSchemaObject.parse(schema));
  if (!isObjectSchema(rebuilt)) throw new Error(`${what} must be a JSON schema of an object`);
  return rebuilt;
}

/** A forwarded request rebuilt as an aeye request: tool and output schemas back to zod. */
export function requestFromWire(request: LlmRequest): Request {
  const format = request.responseFormat;
  return {
    messages: request.messages.map(messageFromWire),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    ...(request.tools === undefined ? {} : {
      tools: request.tools.map((tool): ToolDefinition => ({
        name: tool.name,
        parameters: objectSchemaFromWire(tool.parameters, `the parameters of tool ${tool.name}`),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      })),
    }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(format === undefined ? {} : {
      responseFormat: typeof format === 'string' ? format : { type: objectSchemaFromWire(format.schema, 'the response format'), strict: format.strict },
    }),
  };
}

/** The strict-mode descriptor ids the provider chose while building a request, so the system decodes the same way. */
export function descriptorsOf(request: Request): { tools: Record<string, string>; output?: string } {
  const tools: Record<string, string> = {};
  for (const tool of request.tools ?? []) {
    if (tool.descriptor !== undefined) tools[tool.name] = tool.descriptor;
  }
  const format = request.responseFormat;
  const output = format === undefined || typeof format === 'string' ? undefined : format.descriptor;
  return output === undefined ? { tools } : { tools, output };
}
