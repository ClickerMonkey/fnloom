/**
 * The one mapping between aeye's in-memory LLM shapes (`Message`, `Request`, `Chunk`, `Usage`, `Response`) and their
 * JSON projections in core (`LlmMessage`, `LlmRequest`, `LlmChunk`, `LlmUsage`, `LlmResponse`). A system forwarding a
 * request to the hub, the hub rebuilding it, and the hub saving transcripts and interactions all go through here.
 *
 * Tool and output schemas (`@aeye/schema` bounds) travel as their lenient JSON schema, the code shape, and the hub rebuilds
 * them with `a.fromJSONSchema` (`requestFromWire`). The hub's provider plans the rebuilt request for the real model, and
 * `AnswerDecoder` decodes what the model wrote through that plan back to the code shape (a dispatched call under its
 * tool's own name, a call that doesn't fit with `invalid`), which the system's prompt decodes with its own schemas as
 * they are. What a caller does with what the wire can't carry (a streamed or `Blob` message part) is `LlmWire`'s
 * `unrepresentable` option; whether a record keeps the schemas as sent to the model is its `schemas` option.
 */
import {
  a, extractJSONObject, LENIENT, requestPlan, sentTools,
  type Bound, type Chunk, type ErrorFormatInput, type RequestPlan, type Message, type MessageContent, type Request, type Resource, type Response, type ToolCall, type ToolChoice, type ToolDefinition, type Usage,
} from '@aeye/core';
import {
  Json,
  type DecisionInput, type FinishReason, type LlmChunk, type LlmContentPart, type LlmErrorFormat, type LlmMessage, type LlmRequest, type LlmResponse, type LlmToolCall,
  type LlmToolSpec, type LlmUsage,
} from '@harness/core';
import type { AnySchema } from '@aeye/schema';
import { env } from '@ayepi/env';
import { z } from 'zod';
import { LinkGap } from './wire.ts';

/** The wire's tunables. */
export const llmWireEnv = env({
  /**
   * How many tool and output schemas rebuilt from the wire are kept, by their JSON (`schemaFromWire`). An authoring
   * agent sends the same few large schemas (a gin program's, 50 KB of JSON schema) every round, and rebuilding one
   * took 10 to 20 ms of the hub's event loop each time (iteration 1, rep 3); the rebuilt bound schema is kept instead
   * (and with it the renderings it memoizes per model dialect).
   */
  HARNESS_WIRE_SCHEMA_CACHE: z.coerce.number().int().min(0).default(64),
});

/** How `LlmWire` treats what the wire can't carry. */
export interface LlmWireOptions {
  /**
   * `refuse` throws a `LinkGap`, for requests that will be sent on (a lossy request would reach the model changed).
   * `placeholder` keeps going, for records: an unsendable part's content becomes `[binary content]`.
   */
  readonly unrepresentable: 'refuse' | 'placeholder';
  /**
   * `lenient` (default) writes each schema as its lenient JSON schema, the code shape: what a forwarded request carries.
   * `sent`, for records: a request a provider planned is written as the model was sent it (its tools in the model's
   * dialect, the dispatcher in place of the tools behind it, the output as rendered for it); one not planned, lenient.
   */
  readonly schemas?: 'lenient' | 'sent';
}

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

/** A tool call copied either way (aeye's `ToolCall`, the wire's `LlmToolCall`). */
function callToWire(call: Pick<ToolCall, 'id' | 'name' | 'arguments'> & { readonly invalid?: string | undefined }): ToolCall & LlmToolCall {
  return { id: call.id, name: call.name, arguments: call.arguments, ...(call.invalid === undefined ? {} : { invalid: call.invalid }) };
}

/** A JSON schema `@aeye/schema` rendered, as the wire's JSON (checked once per schema object). */
const jsonOf = new WeakMap<object, Json>();
function schemaJson(schema: object): Json {
  const known = jsonOf.get(schema);
  if (known !== undefined) { return known; }
  const made = Json.parse(schema);
  jsonOf.set(schema, made);
  return made;
}

/** A bound schema's lenient JSON schema (the code shape), as it crosses the wire. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any bound (a bound is invariant in its value type)
export function lenientJson(schema: Bound<any>): Json {
  return schemaJson(schema.render(LENIENT).jsonSchema);
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

  /**
   * An aeye request as JSON: each schema as its lenient JSON schema (or as sent, `schemas: 'sent'`); an empty tool
   * list is left out.
   */
  request(request: Request): LlmRequest {
    const toolChoice = toolChoiceToWire(request.toolChoice);
    const stop = request.stop === undefined ? undefined : typeof request.stop === 'string' ? [request.stop] : request.stop;
    const plan = this.#options.schemas === 'sent' ? plannedOf(request) : undefined;
    const tools = request.tools === undefined || request.tools.length === 0 ? undefined
      : plan === undefined ? request.tools.map(toolToWire) : sentTools(request).map((tool): LlmToolSpec => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: schemaJson(tool.parameters),
        strict: tool.strict,
      }));
    const format = request.responseFormat;
    const sent = plan === undefined ? undefined : plan.output;
    const responseFormat: LlmRequest['responseFormat'] = format === undefined || typeof format === 'string' ? format
      : sent === undefined ? formatToWire(format)
      : { schema: schemaJson(sent.rendered.jsonSchema), strict: sent.strict, schemaDelivery: sent.delivery === 'prompt' ? 'prompt' : 'structured' };
    return {
      messages: request.messages.map((message) => this.message(message)),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      ...(stop === undefined ? {} : { stop }),
      ...(tools === undefined ? {} : { tools }),
      ...(toolChoice === undefined ? {} : { toolChoice }),
      ...(responseFormat === undefined ? {} : { responseFormat }),
      ...(request.errorFormat === undefined ? {} : { errorFormat: request.errorFormat }),
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

/** A tool as a forwarded request carries it: its schema lenient (the code shape). */
function toolToWire(tool: ToolDefinition): LlmToolSpec {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: lenientJson(tool.parameters),
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    ...(tool.errorFormat === undefined ? {} : { errorFormat: tool.errorFormat }),
  };
}

/** A structured output as a forwarded request carries it: its schema lenient (the code shape). */
function formatToWire(format: Extract<Request['responseFormat'], object>): Extract<LlmRequest['responseFormat'], object> {
  return {
    schema: lenientJson(format.type),
    strict: format.strict,
    ...(format.errorFormat === undefined ? {} : { errorFormat: format.errorFormat }),
    ...(format.schemaDelivery === undefined ? {} : { schemaDelivery: format.schemaDelivery }),
  };
}

/** The plan a provider pinned on a request, if one did (`requestPlan` would make a lenient one). */
export function plannedOf(request: Request): RequestPlan | undefined {
  const format = request.responseFormat;
  return request.plan ?? request.tools?.find((tool) => tool.plan !== undefined)?.plan ?? (typeof format === 'object' ? format.plan : undefined);
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

/**
 * A decision call's input as it crosses the wire (`model` and `providerDecide`): text as it is, a conversation as wire
 * messages (refused when a part can't cross).
 */
export function decisionInputToWire(input: string | Message[]): DecisionInput {
  return typeof input === 'string' ? input : input.map((message) => decisionWire.message(message));
}

/** A decision call's input from the wire, as aeye's `DecisionRequest.input`. */
export function decisionInputFromWire(input: DecisionInput): string | Message[] {
  return typeof input === 'string' ? input : input.map(messageFromWire);
}

/** What a decision input's conversation can't carry is refused, so the model never reads something else. */
const decisionWire = new LlmWire({ unrepresentable: 'refuse' });

/**
 * Whether a schema describes objects, as a tool's parameters must: an `a` bound whose root (through its refs) is an
 * object, a record or an intersection (of objects).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any bound (a bound is invariant in its value type)
export function isObjectSchema(schema: Bound<any>): schema is Bound<object> {
  let node: AnySchema | undefined = schema.root;
  for (let hops = 0; node !== undefined && node.kind === 'ref' && hops < 32; hops += 1) {
    const name: unknown = 'name' in node ? node.name : undefined;
    node = typeof name === 'string' ? schema.env.get(name) : undefined;
  }
  return node !== undefined && (node.kind === 'object' || node.kind === 'record' || node.kind === 'intersection');
}

/** Schemas rebuilt from the wire by their JSON, least recently used first (`HARNESS_WIRE_SCHEMA_CACHE`). */
const rebuilt = new Map<string, Bound<unknown>>();

/**
 * A (lenient) JSON schema from the wire rebuilt as a bound `a` schema (`a.fromJSONSchema`), for the provider to plan
 * for its model. The same JSON gives the same bound (kept, `HARNESS_WIRE_SCHEMA_CACHE`), so a schema sent every round
 * is rebuilt once and rendered once per model dialect (a bound memoizes its renderings).
 */
export function schemaFromWire(schema: Json): Bound<unknown> {
  const size = llmWireEnv.get('HARNESS_WIRE_SCHEMA_CACHE');
  const key = size === 0 ? undefined : JSON.stringify(schema);
  const known = key === undefined ? undefined : rebuilt.get(key);
  if (key !== undefined && known !== undefined) {
    rebuilt.delete(key);
    rebuilt.set(key, known);
    return known;
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) { throw new Error('Expected a JSON schema object.'); }
  const made = a.fromJSONSchema(schema).bind();
  if (key !== undefined) {
    rebuilt.set(key, made);
    while (rebuilt.size > size) { const oldest = rebuilt.keys().next().value; if (oldest === undefined) break; rebuilt.delete(oldest); }
  }
  return made;
}

/** A JSON schema rebuilt as a bound schema of objects; refused when it doesn't describe an object. */
function objectSchemaFromWire(schema: Json, what: string): Bound<object> {
  const bound = schemaFromWire(schema);
  if (!isObjectSchema(bound)) { throw new Error(`${what} must be a JSON schema of an object`); }
  return bound;
}

/** An error format from the wire as aeye's (the wire's parse leaves no `undefined` fields). */
function errorFormatFromWire(format: LlmErrorFormat): ErrorFormatInput {
  if (typeof format === 'string') { return format; }
  const defined = Object.entries(format).filter(([, value]) => value !== undefined);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the same fields, those left out absent
  return Object.fromEntries(defined) as ErrorFormatInput;
}

/** A request from the wire rebuilt as an aeye request: tool and output schemas as bound `a` schemas. */
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
        ...(tool.errorFormat === undefined ? {} : { errorFormat: errorFormatFromWire(tool.errorFormat) }),
      })),
    }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(format === undefined ? {} : {
      responseFormat: typeof format === 'string' ? format : {
        type: objectSchemaFromWire(format.schema, 'the response format'),
        strict: format.strict,
        ...(format.errorFormat === undefined ? {} : { errorFormat: errorFormatFromWire(format.errorFormat) }),
        ...(format.schemaDelivery === undefined ? {} : { schemaDelivery: format.schemaDelivery }),
      },
    }),
    ...(request.errorFormat === undefined ? {} : { errorFormat: errorFormatFromWire(request.errorFormat) }),
  };
}

/** A structured answer's text as JSON, as aeye's prompt reads it: the whole text, else the JSON object in it. */
function answerJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const extracted = extractJSONObject(text);
    if (extracted === '' || extracted === trimmed) { throw error; }
    return JSON.parse(extracted);
  }
}

/** A chunk without some of its parts; `undefined` when nothing is left. */
function without(chunk: Chunk, ...keys: ReadonlyArray<keyof Chunk>): Chunk | undefined {
  const rest: Chunk = { ...chunk };
  for (const key of keys) { delete rest[key]; }
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/** An error's message. */
function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decodes what a model wrote through the plan its request was sent with (the one the provider pinned, else a lenient
 * one) as the stream passes, so a system reads every answer in the code shape and decodes it with its own schemas:
 *
 * - a finished tool call (`toolCall`) is decoded (`plan.decodeCall`: strict `null`s back to absent, pairs back to
 *   records, JSON text parsed): its arguments become the decoded value's JSON, under the tool's own name. One that
 *   doesn't fit keeps the model's arguments and says why in `invalid`, the message the model is told; arguments that
 *   aren't JSON at all go as they are (the system's prompt reports them). A call that already has `invalid` (decoded
 *   by a provider further along) goes as it is.
 * - a call to the dispatcher (more tools than the provider takes) names its tool only in its arguments, so it is held
 *   back until it's complete and goes as one chunk, named and finished, under the tool it reached.
 * - a structured answer's text is held until the answer ends (its `finishReason`, or the stream's end) and goes as one
 *   chunk of its decoded value's JSON, or as the model wrote it when it doesn't decode.
 *
 * Partial arguments (`toolCallArguments`) of other calls stream as they come, in the model's shape. One decoder per
 * stream; its first chunk is read after the provider planned the request.
 */
export class AnswerDecoder {
  readonly #request: Request;
  /** The structured answer's text so far; `undefined` when the request asks for none, or it already went. */
  #held: string | undefined;
  /** The dispatcher calls being held back, by id. */
  readonly #dispatched = new Set<string>();

  constructor(request: Request) {
    this.#request = request;
    const format = request.responseFormat;
    this.#held = typeof format === 'object' && format.type.root.kind !== 'string' ? '' : undefined;
  }

  /** What to send for one chunk the model streamed: nothing, the chunk (decoded), or at the answer's end the answer first. */
  chunk(chunk: Chunk): Chunk[] {
    let out: Chunk | undefined = chunk;
    const named = chunk.toolCallNamed;
    if (named !== undefined && named.name === requestPlan(this.#request).dispatcher?.name) {
      this.#dispatched.add(named.id);
      out = without(out, 'toolCallNamed');
    }
    if (out?.toolCallArguments !== undefined && this.#dispatched.has(out.toolCallArguments.id)) { out = without(out, 'toolCallArguments'); }
    if (out?.toolCall !== undefined) {
      const call = this.call(out.toolCall);
      const held = this.#dispatched.delete(call.id);
      out = { ...out, toolCall: call, ...(held ? { toolCallNamed: call } : {}) };
    }
    if (this.#held !== undefined && out?.content !== undefined) {
      this.#held += out.content;
      out = without(out, 'content');
    }
    const answer = out?.finishReason === undefined ? [] : this.end();
    return out === undefined ? answer : [...answer, out];
  }

  /** What is still held when the stream ends: the structured answer, decoded. */
  end(): Chunk[] {
    const held = this.#held;
    this.#held = undefined;
    return held === undefined || held === '' ? [] : [{ content: this.answer(held) }];
  }

  /** A finished tool call, decoded (see the class). */
  call(call: ToolCall): ToolCall {
    if (call.invalid !== undefined) { return call; }
    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments.trim() === '' ? '{}' : call.arguments);
    } catch {
      return call;
    }
    const plan = requestPlan(this.#request);
    const decoded = plan.decodeCall(call.name, raw);
    if (decoded.ok) {
      try {
        return { id: call.id, name: decoded.tool, arguments: JSON.stringify(decoded.value) ?? '{}' };
      } catch (error) {
        return { ...call, invalid: messageOfError(error) };
      }
    }
    // a dispatcher call to no tool goes by the name it gave, so the system's prompt says which tools there are
    const asked: unknown = plan.dispatcher?.name === call.name && typeof raw === 'object' && raw !== null && 'tool' in raw ? raw.tool : undefined;
    return { id: call.id, name: decoded.tool ?? (typeof asked === 'string' ? asked : call.name), arguments: call.arguments, invalid: decoded.message };
  }

  /** A structured answer's text, decoded: its value's JSON, or the text as it is when it doesn't decode. */
  answer(text: string): string {
    const output = requestPlan(this.#request).output;
    if (output === undefined) { return text; }
    let raw: unknown;
    try {
      raw = answerJson(text);
    } catch {
      return text;
    }
    const decoded = output.parse(raw);
    return decoded.ok ? JSON.stringify(decoded.value) ?? text : text;
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
    ...(chunk.toolCallNamed === undefined ? {} : { toolCallNamed: callToWire(chunk.toolCallNamed) }),
    ...(chunk.toolCallArguments === undefined ? {} : { toolCallArguments: callToWire(chunk.toolCallArguments) }),
    ...(chunk.toolCall === undefined ? {} : { toolCall: callToWire(chunk.toolCall) }),
    ...(chunk.finishReason === undefined ? {} : { finishReason: chunk.finishReason }),
    ...(chunk.refusal === undefined ? {} : { refusal: chunk.refusal }),
    ...(chunk.usage === undefined ? {} : { usage: usageFromWire(chunk.usage) }),
  };
}

/**
 * A stream's chunks as they travel, one writer per stream: a tool call's growing arguments go as `toolCallMore`, only
 * the text since the call's last chunk, so a call of n bytes costs n on the link, not n² (aeye's `toolCallArguments`
 * holds the whole so far on every chunk). Arguments that don't extend what was sent go whole, as `toolCallArguments`.
 */
export class ChunkWriter {
  /** How much of each call's arguments went out, by call id. */
  readonly #sent = new Map<string, number>();

  write(chunk: Chunk): LlmChunk {
    const { toolCallArguments: growing, ...rest } = chunk;
    const wire = chunkToWire(rest);
    if (chunk.toolCallNamed !== undefined) this.#sent.set(chunk.toolCallNamed.id, chunk.toolCallNamed.arguments.length);
    if (growing === undefined) return wire;
    const sent = this.#sent.get(growing.id);
    this.#sent.set(growing.id, growing.arguments.length);
    if (sent === undefined || sent > growing.arguments.length) return { ...wire, toolCallArguments: callToWire(growing) };
    return { ...wire, toolCallMore: { id: growing.id, name: growing.name, arguments: growing.arguments.slice(sent) } };
  }
}

/**
 * A stream's chunks from the wire as aeye's, one reader per stream: `toolCallMore` is added onto the call's
 * arguments, and every chunk of a call holds the same call object (as aeye's providers do), so the chunks a stream
 * keeps share one copy of the arguments.
 */
export class ChunkReader {
  readonly #calls = new Map<string, ToolCall>();

  read(wire: LlmChunk): Chunk {
    const { toolCallMore, ...rest } = wire;
    const chunk = chunkFromWire(rest);
    if (chunk.toolCallNamed !== undefined) chunk.toolCallNamed = this.#call(chunk.toolCallNamed, chunk.toolCallNamed.arguments);
    if (chunk.toolCallArguments !== undefined) chunk.toolCallArguments = this.#call(chunk.toolCallArguments, chunk.toolCallArguments.arguments);
    if (toolCallMore !== undefined) {
      const call = this.#calls.get(toolCallMore.id);
      chunk.toolCallArguments = this.#call(toolCallMore, (call?.arguments ?? '') + toolCallMore.arguments);
    }
    return chunk;
  }

  /** The stream's one object for a call, holding `args`. */
  #call(wire: LlmToolCall, args: string): ToolCall {
    const call = this.#calls.get(wire.id) ?? { id: wire.id, name: wire.name, arguments: '' };
    call.name = wire.name || call.name;
    call.arguments = args;
    this.#calls.set(wire.id, call);
    return call;
  }
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
