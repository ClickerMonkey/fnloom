/**
 * LLM traffic on the wire: a system's LLM request forwarded to the hub (the hub is an aeye provider for systems),
 * and what streams back. These are JSON projections of aeye's `Request` / `Chunk` / `Usage`: zod schemas can't
 * cross the wire, so tool and output schemas travel as JSON schema.
 */
import { z } from 'zod';
import { Json, LlmInteractionId, RunId, Usd } from './primitives.ts';

/** Which model to use: a model id, a named category, or automatic selection by weights. */
export const ModelChoice = z.union([
  z.object({ model: z.string().min(1) }),
  z.object({ category: z.string().min(1) }),
  z.object({ auto: z.object({ cost: z.number().min(0).optional(), speed: z.number().min(0).optional(), accuracy: z.number().min(0).optional() }) }),
]);
export type ModelChoice = z.infer<typeof ModelChoice>;

/**
 * Whether a model a provider serves is the one a model name means: its own id (`deepseek-r1:7b`), or its id under its
 * provider (`ollama/deepseek-r1:7b`, how the hub names a model pinned to a provider).
 */
export function namesModel(name: string, model: { readonly id: string; readonly provider: string }): boolean {
  return model.id === name || `${model.provider}/${model.id}` === name;
}

/** A tool call the model asked for. `arguments` is the JSON text the model wrote. */
export const LlmToolCall = z.object({ id: z.string(), name: z.string(), arguments: z.string() });
export type LlmToolCall = z.infer<typeof LlmToolCall>;

/** One part of a multi-part message. `content` is text, a URL or a data URL. */
export const LlmContentPart = z.object({
  type: z.enum(['text', 'image', 'file', 'audio', 'video']),
  content: z.string(),
  format: z.string().optional(),
  name: z.string().optional(),
});
export type LlmContentPart = z.infer<typeof LlmContentPart>;

/** A conversation message, as aeye's `Message` minus provider caches. */
export const LlmMessage = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(LlmContentPart)]),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(LlmToolCall).optional(),
  refusal: z.string().optional(),
  tokens: z.number().int().optional(),
});
export type LlmMessage = z.infer<typeof LlmMessage>;

/** Token use of one call, as aeye's `Usage` text section (the parts harness meters). */
export const LlmUsage = z.object({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cached: z.number().int().min(0).optional(),
  reasoning: z.number().int().min(0).optional(),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

/** Why a response stopped. */
export const FinishReason = z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'refusal']);
export type FinishReason = z.infer<typeof FinishReason>;

/** One streamed piece of a response. */
export const LlmChunk = z.object({
  content: z.string().optional(),
  reasoning: z.string().optional(),
  /** A tool call whose name is known (arguments may still stream). */
  toolCallNamed: LlmToolCall.optional(),
  /** A tool call's arguments so far, whole (what aeye's chunk holds; a stream sends `toolCallMore` instead). */
  toolCallArguments: LlmToolCall.optional(),
  /**
   * More of a tool call's arguments: `arguments` is only the text that came since its last chunk, for the reader to
   * add on (`ChunkReader`). Sending the whole so far on every chunk made a long call quadratic on the link: a model
   * looping on a 130 KB argument sent gigabytes and ran the hub out of memory.
   */
  toolCallMore: LlmToolCall.optional(),
  /** A tool call that is complete. */
  toolCall: LlmToolCall.optional(),
  finishReason: FinishReason.optional(),
  refusal: z.string().optional(),
  usage: LlmUsage.optional(),
});
export type LlmChunk = z.infer<typeof LlmChunk>;

/**
 * A strict-mode policy, as aeye's: `true` requires strict schemas, `false` forces lenient ones, and a positive number
 * prefers strict with that priority when a model has fewer strict slots than are asked for.
 */
export const LlmStrict = z.union([z.boolean(), z.number().positive()]);
export type LlmStrict = z.infer<typeof LlmStrict>;

/** A tool offered to the model, with its input as JSON schema. */
export const LlmToolSpec = z.object({ name: z.string(), description: z.string().optional(), parameters: Json, strict: LlmStrict.optional() });
export type LlmToolSpec = z.infer<typeof LlmToolSpec>;

/** What the model should produce: text, any JSON, or JSON matching a schema. */
export const LlmResponseFormat = z.union([z.literal('text'), z.literal('json'), z.object({ schema: Json, strict: LlmStrict })]);
export type LlmResponseFormat = z.infer<typeof LlmResponseFormat>;

/** An LLM request as it crosses the wire. */
export const LlmRequest = z.object({
  messages: z.array(LlmMessage),
  temperature: z.number().optional(),
  maxTokens: z.number().int().optional(),
  stop: z.array(z.string()).optional(),
  tools: z.array(LlmToolSpec).optional(),
  toolChoice: z.union([z.enum(['auto', 'none', 'required']), z.object({ tool: z.string() })]).optional(),
  responseFormat: LlmResponseFormat.optional(),
});
export type LlmRequest = z.infer<typeof LlmRequest>;

/** An LLM request forwarded from a system (behind `ctx.llm` and the aeye provider systems use). */
export const LlmForward = z.object({
  run: RunId.optional(),
  request: LlmRequest,
  model: ModelChoice.optional(),
  stream: z.boolean(),
});
export type LlmForward = z.infer<typeof LlmForward>;

/** What streams back: chunks, the schema descriptors the provider used (so strict output decodes), then the cost. */
export const LlmForwardChunk = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chunk'), chunk: LlmChunk }),
  z.object({ type: z.literal('descriptors'), tools: z.record(z.string(), z.string()), output: z.string().optional() }),
  z.object({ type: z.literal('done'), usage: LlmUsage, cost: Usd, interaction: LlmInteractionId, model: z.string() }),
  z.object({ type: z.literal('error'), message: z.string(), kind: z.enum(['model', 'tool', 'limit', 'provider']) }),
]);
export type LlmForwardChunk = z.infer<typeof LlmForwardChunk>;
