/**
 * The claude system's tunables, an `@ayepi/env` slice.
 */
import { env } from '@ayepi/env';
import { systemFields, systemState } from '@harness/sdk/server';
import { z } from 'zod';

export const claudeEnv = env({
  ...systemFields(),
  /** How long a session's record changes wait to be written together (status, tasks, last text), in ms. */
  CLAUDE_RECORD_DEBOUNCE: z.number().int().min(0).max(60_000).default(1_000),
  /** The longest tool result or tool input a transcript page carries, in characters (the rest is cut with a note). */
  CLAUDE_TRANSCRIPT_TEXT_MAX: z.number().int().min(200).default(4_000),
  /** The longest last-text line kept on a session's record, in characters. */
  CLAUDE_LAST_TEXT_MAX: z.number().int().min(40).max(2_000).default(240),
  /** The longest diff or command an approval card shows, in characters. */
  CLAUDE_PREVIEW_MAX: z.number().int().min(200).default(8_000),
  /**
   * The user dialog kinds (`request_user_dialog`) the harness answers with a form, comma-separated. Claude only asks
   * dialogs of kinds named here; empty asks none, and any other kind is answered `cancelled`.
   */
  CLAUDE_DIALOG_KINDS: z.string().default(''),
  /** The Claude Code executable to run; absent, the one bundled with the Agent SDK. */
  CLAUDE_EXECUTABLE: z.string().min(1).optional(),
}).add(systemState('claude'));

/** The claude system's settings, resolved. */
export type ClaudeSettings = ReturnType<typeof claudeEnv.parse>;

/** The dialog kinds named in the settings. */
export function dialogKinds(settings: Pick<ClaudeSettings, 'CLAUDE_DIALOG_KINDS'>): string[] {
  return settings.CLAUDE_DIALOG_KINDS.split(',').map((kind) => kind.trim()).filter((kind) => kind !== '');
}
