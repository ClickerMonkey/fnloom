/**
 * What the approval cards show: a tool use Claude waits on (the command for a shell, a diff for an edit, the content
 * for a new file, else the input as JSON), a question (its words; the form is the card's `ask`), a mode that lets Claude
 * do more on its own, and what an import would add.
 */
import { z } from 'zod';
import type { ApprovalPreview, JsonObject, McpServerConfig, PreviewPart } from '@harness/core';
import { MODE_MEANING, type ClaudePermissionMode, type ClaudeSession } from '../shared/session.ts';
import type { PermitRequest, QuestionRequest } from './driver.ts';

const BashInput = z.object({ command: z.string(), description: z.string().optional() });
const EditInput = z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() });
const MultiEditInput = z.object({ file_path: z.string(), edits: z.array(z.object({ old_string: z.string(), new_string: z.string() })) });
const WriteInput = z.object({ file_path: z.string(), content: z.string() });

/** Text cut to `max` characters, saying how much was left out. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${String(text.length - max)} more characters)`;
}

/** A replacement as a diff: the old lines taken out, the new ones put in. */
export function replacementDiff(file: string, replacements: ReadonlyArray<{ readonly old_string: string; readonly new_string: string }>): string {
  const hunks = replacements.map((r) => ['@@', ...r.old_string.split('\n').map((line) => `-${line}`), ...r.new_string.split('\n').map((line) => `+${line}`)].join('\n'));
  return [`--- ${file}`, `+++ ${file}`, ...hunks].join('\n');
}

/** What the tool would do, as the card's parts. */
function toolParts(tool: string, input: JsonObject, max: number): PreviewPart[] {
  const bash = tool === 'Bash' ? BashInput.safeParse(input) : undefined;
  if (bash?.success === true) {
    return [...(bash.data.description === undefined ? [] : [{ type: 'text' as const, text: bash.data.description }]), { type: 'code', language: 'bash', code: clip(bash.data.command, max) }];
  }
  const edit = tool === 'Edit' ? EditInput.safeParse(input) : undefined;
  if (edit?.success === true) { return [{ type: 'code', language: 'diff', title: edit.data.file_path, code: clip(replacementDiff(edit.data.file_path, [edit.data]), max) }]; }
  const multi = tool === 'MultiEdit' ? MultiEditInput.safeParse(input) : undefined;
  if (multi?.success === true) { return [{ type: 'code', language: 'diff', title: multi.data.file_path, code: clip(replacementDiff(multi.data.file_path, multi.data.edits), max) }]; }
  const write = tool === 'Write' ? WriteInput.safeParse(input) : undefined;
  if (write?.success === true) { return [{ type: 'code', language: languageOf(write.data.file_path), title: write.data.file_path, code: clip(write.data.content, max) }]; }
  return [{ type: 'code', language: 'json', code: clip(JSON.stringify(input, null, 2), max) }];
}

/** A code block language from a file's extension. */
function languageOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot < 0 ? 'text' : file.slice(dot + 1).toLowerCase();
}

/** The card of a tool use Claude waits on. */
export function permitPreview(request: PermitRequest, max: number): ApprovalPreview {
  const why = request.reason === undefined ? [] : [{ type: 'text' as const, text: request.reason }];
  const always = request.canAlways ? [{ type: 'text' as const, text: 'Tick **always** to allow it for the rest of this session.' }] : [];
  return { title: `Claude wants to use ${request.tool}`, parts: [...why, ...toolParts(request.tool, request.input, max), ...always], irreversible: false };
}

/** The card of a question Claude waits on. */
export function questionPreview(request: QuestionRequest): ApprovalPreview {
  return { title: request.title, parts: [{ type: 'text', text: request.text }], irreversible: false };
}

/** The card of a mode that lets Claude do more on its own (`claude/allow_mode`): the mode, what it means, and where. */
export function modePreview(mode: ClaudePermissionMode, session: Pick<ClaudeSession, 'title' | 'folder'> | undefined): ApprovalPreview {
  const where = session === undefined ? [] : [{ type: 'text' as const, text: `Session: ${session.title} (${session.folder})` }];
  return { title: `Let Claude work in ${mode} mode?`, parts: [{ type: 'text', text: MODE_MEANING[mode] }, ...where], irreversible: false };
}

/** What a stdio MCP server would start: its command, args and folder, and its env names (never their values). */
export function mcpServerLines(server: McpServerConfig): string {
  const transport = server.transport;
  if (transport.type !== 'stdio') { return `${transport.type} ${transport.url}`; }
  return [
    `command: ${transport.command}`,
    `args: ${transport.args.length === 0 ? '(none)' : JSON.stringify(transport.args)}`,
    `folder: ${transport.cwd ?? '(the instance’s own)'}`,
    `env: ${Object.keys(transport.env ?? {}).join(', ') || '(none)'}`,
  ].join('\n');
}
