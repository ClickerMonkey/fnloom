/**
 * Claude's stored messages as transcript items. A stored message's body is the Messages API's (`content` a string or
 * blocks), read with zod; blocks the harness doesn't show (images, documents, redacted thinking) are left out. One
 * message can hold several blocks: the first item keeps the message's uuid, the next ones add `#2`, `#3`, ….
 */
import { jsonOf, type Json } from '@harness/core';
import type { ClaudeTranscriptItem } from '../shared/session.ts';
import { z } from 'zod';
import { clip } from './preview.ts';

/** A stored message as the SDK reads it (`SessionMessage`, its body untyped). */
export interface StoredMessage {
  readonly type: 'user' | 'assistant' | 'system';
  readonly uuid: string;
  readonly message: unknown;
}

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const Block = z.discriminatedUnion('type', [
  TextBlock,
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal('tool_result'), tool_use_id: z.string(), is_error: z.boolean().optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
  }),
]);
const Body = z.object({ content: z.union([z.string(), z.array(z.unknown())]) });

/** A tool result's text: its string, or its text blocks joined. */
function resultText(content: string | readonly unknown[] | undefined): string {
  if (content === undefined) { return ''; }
  if (typeof content === 'string') { return content; }
  return content.flatMap((block) => {
    const text = TextBlock.safeParse(block);
    return text.success ? [text.data.text] : [];
  }).join('\n');
}

/** A tool's input for the page: as it is, or cut to `max` characters of its JSON when it is longer. */
function inputOf(input: unknown, max: number): Json {
  const json = jsonOf(input);
  const text = JSON.stringify(json);
  return text.length <= max ? json : { clipped: clip(text, max) };
}

/** One stored message's items. */
export function itemsOf(message: StoredMessage, max: number): ClaudeTranscriptItem[] {
  const body = Body.safeParse(message.message);
  if (!body.success) { return []; }
  const role = message.type;
  if (typeof body.data.content === 'string') { return [{ type: role, uuid: message.uuid, text: clip(body.data.content, max) }]; }
  const items: ClaudeTranscriptItem[] = [];
  for (const raw of body.data.content) {
    const block = Block.safeParse(raw);
    if (!block.success) { continue; }
    const uuid = items.length === 0 ? message.uuid : `${message.uuid}#${String(items.length + 1)}`;
    switch (block.data.type) {
      case 'text':
        items.push({ type: role, uuid, text: clip(block.data.text, max) });
        break;
      case 'thinking':
        items.push({ type: 'thinking', uuid, text: clip(block.data.thinking, max) });
        break;
      case 'tool_use':
        items.push({ type: 'tool-use', uuid, id: block.data.id, tool: block.data.name, input: inputOf(block.data.input, max) });
        break;
      case 'tool_result':
        items.push({ type: 'tool-result', uuid, id: block.data.tool_use_id, ok: block.data.is_error !== true, text: clip(resultText(block.data.content), max) });
        break;
    }
  }
  return items;
}

/** One line saying what a tool use does, for a run's progress (`Bash: npm test`, `Edit: src/cart.ts`). */
export function toolLine(tool: string, input: unknown, max = 120): string {
  const fields = z.record(z.string(), z.unknown()).safeParse(input);
  const keys = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];
  const value = fields.success ? keys.map((key) => fields.data[key]).find((v) => typeof v === 'string') : undefined;
  const line = typeof value === 'string' ? `${tool}: ${value.replace(/\s+/g, ' ')}` : tool;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
