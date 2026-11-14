/**
 * The one mapping between aeye's in-memory LLM shapes (`Message`, `Request`, `Chunk`, `Usage`, `Response`) and their
 * JSON projections in core (`LlmMessage`, `LlmRequest`, `LlmChunk`, `LlmUsage`, `LlmResponse`). A system forwarding a
 * request to the hub, the hub rebuilding it, and the hub saving transcripts and interactions all go through here.
 *
 * Zod schemas can't cross the wire: tool and output schemas travel as JSON schema and are rebuilt with zod's
 * `fromJSONSchema`. The one real difference between callers is what happens to something the wire can't carry (a
 * schema part JSON schema can't express, a streamed or `Blob` message part): `LlmWire`'s `unrepresentable` option.
 */
import type { Chunk, Message, MessageContent, Request, Resource, Response, ToolCall, ToolChoice, ToolDefinition, Usage } from '@aeye/core';
import {
  Json,
  type FinishReason, type LlmChunk, type LlmContentPart, type LlmForwardChunk, type LlmMessage, type LlmRequest, type LlmResponse, type LlmToolCall,
  type LlmToolSpec, type LlmUsage,
} from '@harness/core';
import { z } from 'zod';
import { LinkGap } from './wire.ts';

/** How `LlmWire` treats what the wire can't carry. */
export interface LlmWireOptions {
  /**
   * `refuse` throws a `LinkGap`, for requests that will be sent on (a lossy request would reach the model changed).
   * `placeholder` keeps going, for records: a schema part becomes `{}` (any value) and an unsendable part's content
   * becomes `[binary content]`.
   */
  readonly unrepresentable: 'refuse' | 'placeholder';
}

/** The strict-mode descriptors the provider chose while building a request, as they travel back to the system. */
export type LlmDescriptors = Omit<Extract<LlmForwardChunk, { type: 'descriptors' }>, 'type'>;

/** What stands in for message content the wire can't carry, when placeholders are allowed. */
export const UNSENDABLE_CONTENT = '[binary content]';

/** A MIME type for a short format name (`png` → `image/png`); a format that already is one stays. */
function mimeOf(format: string | undefined): string {
  if (format === undefined) { return 'application/octet-stream'; }
  if (format.includes('/')) { return format; }
  const known: Readonly<Record<string, string>> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav',
  };
  return known[format] ?? `application/${format}`;
}

/** The bytes of a resource held in memory, or `undefined` for one that isn't (a stream or a `Blob`). */
function bytesOf(resource: Exclude<Resource, string | URL>): Uint8Array | undefined {
  if (resource instanceof Uint8Array) { return resource; }
  if (resource instanceof ArrayBuffer) { return new Uint8Array(resource); }
  if (resource instanceof DataView) { return new Uint8Array(resource.buffer, resource.byteOffset, resource.byteLength); }
  return undefined;
}

function callToWire(call: ToolCall): LlmToolCall {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

function partFromWire(part: LlmContentPart): MessageContent {
  return {
    type: part.type,
    content: part.content,
    ...(part.format === undefined ? {} : { format: part.format }),
    ...(part.name === undefined ? {} : { name: part.name }),
  };
}

/** The parts of a message both directions copy as they are. */
function messageFields(message: Message | LlmMessage): Pick<Message, 'role' | 'name' | 'toolCallId' | 'toolCalls' | 'refusal' | 'tokens'> {
  return {
    role: message.role,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map(callToWire) }),
    ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
    ...(message.tokens === undefined ? {} : { tokens: message.tokens }),
  };
}

/** aeye → wire for the parts where callers differ in what the wire can't carry. */
export class LlmWire {
  readonly #options: LlmWireOptions;

  constructor(options: LlmWireOptions) {
    this.#options = options;
  }

  /** An aeye message as it crosses the wire or is saved. Provider caches and reasoning details stay behind. */
  message(message: Message): LlmMessage {
    return {
      ...messageFields(message),
      content: typeof message.content === 'string' ? message.content : message.content.map((part) => this.#part(part)),
    };
  }

  /** An aeye request as JSON: zod schemas become JSON schema; an empty tool list is left out. */
  request(request: Request): LlmRequest {
    const toolChoice = toolChoiceToWire(request.toolChoice);
    const format = request.responseFormat;
    const stop = request.stop === undefined ? undefined : typeof request.stop === 'string' ? [request.stop] : request.stop;
    return {
      messages: request.messages.map((message) => this.message(message)),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      ...(stop === undefined ? {} : { stop }),
      ...(request.tools === undefined || request.tools.length === 0 ? {} : { tools: request.tools.map((tool) => this.#tool(tool)) }),
      ...(toolChoice === undefined ? {} : { toolChoice }),
      ...(format === undefined ? {} : { responseFormat: typeof format === 'string' ? format : { schema: this.jsonSchema(format.type), strict: format.strict } }),
    };
  }

  /** A zod schema as JSON schema (its input side). */
  jsonSchema(schema: z.ZodType): Json {
    return Json.parse(z.toJSONSchema(schema, { io: 'input', unrepresentable: this.#options.unrepresentable === 'refuse' ? 'throw' : 'any' }));
  }

  #tool(tool: ToolDefinition): LlmToolSpec {
    return {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: this.jsonSchema(tool.parameters),
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    };
  }

  #part(part: MessageContent): LlmContentPart {
    return {
      type: part.type,
      content: this.#content(part.content, part.format),
      ...(part.format === undefined ? {} : { format: part.format }),
      ...(part.name === undefined ? {} : { name: part.name }),
    };
  }

  /** A content resource as text: strings as they are, URLs as their address, bytes in memory as a data URL. */
  #content(resource: Resource, format: string | undefined): string {
    if (typeof resource === 'string') { return resource; }
    if (resource instanceof URL) { return resource.href; }
    const bytes = bytesOf(resource);
    if (bytes !== undefined) { return `data:${mimeOf(format)};base64,${Buffer.from(bytes).toString('base64')}`; }
    if (this.#options.unrepresentable === 'refuse') { throw new LinkGap('Only text, URL and in-memory byte message parts can cross the wire.'); }
    return UNSENDABLE_CONTENT;
  }
}

/** aeye's tool choice on the wire. The wire has no "only these" choice yet: the model picks among all, or must pick one. */
function toolChoiceToWire(choice: ToolChoice | undefined): LlmRequest['toolChoice'] {
  if (choice === undefined || typeof choice === 'string' || 'tool' in choice) { return choice; }
  return choice.required === true ? 'required' : 'auto';
}

/** A message from the wire as an aeye message. */
export function messageFromWire(message: LlmMessage): Message {
  return {
    ...messageFields(message),
    content: typeof message.content === 'string' ? message.content : message.content.map(partFromWire),
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

/**
 * A JSON schema without `propertyNames: { type: 'string' }`, which every JSON object's keys already meet: zod writes it
 * for each record, and `fromJSONSchema` reads it back as a key check piped after the object, which hides the record from
 * the provider's strict dialect (it then reaches the model as an object it can only fill with `{}`). Other key rules
 * (a pattern, an enum) are kept.
 */
function withoutStringKeys(schema: Json): Json {
  if (Array.isArray(schema)) { return schema.map(withoutStringKeys); }
  if (schema === null || typeof schema !== 'object') { return schema; }
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'propertyNames' && isStringOnly(value)) { continue; }
    out[key] = withoutStringKeys(value);
  }
  return out;
}

/** Whether a key schema says only "a string". */
function isStringOnly(value: Json): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && value['type'] === 'string';
}

/** A JSON schema from the wire rebuilt as zod, its records kept records for the provider's strict dialect. */
export function schemaFromWire(schema: Json): z.ZodType {
  return z.fromJSONSchema(JsonSchemaObject.parse(withoutStringKeys(schema)));
}

/** A JSON schema rebuilt as a zod schema of objects; refused when it doesn't describe an object. */
function objectSchemaFromWire(schema: Json, what: string): z.ZodType<object, object> {
  const rebuilt = schemaFromWire(schema);
  if (!isObjectSchema(rebuilt)) { throw new Error(`${what} must be a JSON schema of an object`); }
  return rebuilt;
}

/** A request from the wire rebuilt as an aeye request: tool and output schemas back to zod. */
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
export function descriptorsOf(request: Request): LlmDescriptors {
  const tools: Record<string, string> = {};
  for (const tool of request.tools ?? []) {
    if (tool.descriptor !== undefined) { tools[tool.name] = tool.descriptor; }
  }
  const format = request.responseFormat;
  const output = format === undefined || typeof format === 'string' ? undefined : format.descriptor;
  return output === undefined ? { tools } : { tools, output };
}

/** Write the descriptors the hub chose into the request a prompt holds, so it decodes the strict wire shape. */
export function applyDescriptors(request: Request, descriptors: LlmDescriptors): void {
  for (const tool of request.tools ?? []) {
    const id = descriptors.tools[tool.name];
    if (id !== undefined) { tool.descriptor = id; }
  }
  if (descriptors.output !== undefined && typeof request.responseFormat === 'object') {
    request.responseFormat.descriptor = descriptors.output;
  }
}

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

/** Metered usage as aeye usage, with the call's real cost when it is known. */
export function usageFromWire(usage: LlmUsage, cost?: number): Usage {
  return {
    text: { input: usage.input, output: usage.output, ...(usage.cached === undefined ? {} : { cached: usage.cached }) },
    ...(usage.reasoning === undefined ? {} : { reasoning: { output: usage.reasoning } }),
    ...(cost === undefined ? {} : { cost }),
  };
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

/** A whole response as it is saved with its interaction. An unfinished response is saved as stopped. */
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
