/**
 * The MCP system's own shapes, zod first (the gin types in `index.ts` are read off these with `ginAs`). The config,
 * the status and the tool payload are core's (`mcp-servers.ts`); these are the args and results of its own fns.
 */
import { InstanceName, Json, JsonObject } from '@harness/core';
import { z } from 'zod';

/** Which server a status or refresh is about: this instance when absent. */
export const ServerTarget = z.object({
  instance: InstanceName.optional().describe('The MCP server instance (`linear`); the one answering when empty.'),
});
export type ServerTarget = z.infer<typeof ServerTarget>;

/** The work `at_server` does on the instance that holds the server. */
export const ServerOp = z.object({ op: z.enum(['status', 'refresh']).describe('`status` reads where it is; `refresh` lists everything again and mirrors it.') });
export type ServerOp = z.infer<typeof ServerOp>;

/** `answer_elicitation`'s args: the waiting question, and the person's answer (set from the approval card's form). */
export const ElicitationReply = z.object({
  request: z.string().min(1).describe('The waiting question\'s id.'),
  content: JsonObject.optional().describe('What the person filled in, by field.'),
});
export type ElicitationReply = z.infer<typeof ElicitationReply>;

/** What `answer_elicitation` says once the answer went to the server. */
export const ElicitationSent = z.object({ sent: z.boolean().describe('False when the question was no longer waiting (the call ended).') });
export type ElicitationSent = z.infer<typeof ElicitationSent>;

/** A resource a tool's result named or held, as a hub resource address. */
export const ToolResource = z.object({ uri: z.string(), name: z.string().optional(), mime: z.string().optional() });
export type ToolResource = z.infer<typeof ToolResource>;

/**
 * A tool's result when the tool declares no output schema: its text blocks joined, its structured content if any,
 * and the resources it named. Images and audio are said in the text (`[image image/png]`).
 */
export const ToolOutput = z.object({
  text: z.string(),
  structured: Json.optional(),
  resources: z.array(ToolResource).optional(),
});
export type ToolOutput = z.infer<typeof ToolOutput>;
