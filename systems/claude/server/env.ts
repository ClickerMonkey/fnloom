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
  /**
   * More environment variables a session's Claude Code inherits, comma-separated names, past the ones it needs to run
   * (`SESSION_ENV`). Nothing else of this process's environment (API keys, the pairing token) reaches it.
   */
  CLAUDE_ENV_PASS: z.string().default(''),
  /** The Claude Code executable to run; absent, the one bundled with the Agent SDK. */
  CLAUDE_EXECUTABLE: z.string().min(1).optional(),
}).add(systemState('claude'));

/** The claude system's settings, resolved. */
export type ClaudeSettings = ReturnType<typeof claudeEnv.parse>;

/**
 * The variables of this process's environment a session's Claude Code runs with: its system basics (paths, home, the
 * shell, locale, proxies), its own `ANTHROPIC_` and `CLAUDE_` settings and `CLAUDE_ENV_PASS`. The harness's keys never
 * pass, so an approved `env` or `echo` puts none of them in a transcript.
 */
export const SESSION_ENV = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'USERNAME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
] as const;

/** The name prefixes of Claude Code's own settings, which a session inherits. */
const SESSION_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'] as const;

/** A session's environment: what `SESSION_ENV`, its prefixes and `CLAUDE_ENV_PASS` keep of `parent` (names match in any case). */
export function sessionEnv(parent: Readonly<Record<string, string | undefined>>, settings: Pick<ClaudeSettings, 'CLAUDE_ENV_PASS'>): Record<string, string> {
  const named = new Set<string>([...SESSION_ENV, ...settings.CLAUDE_ENV_PASS.split(',').map((name) => name.trim().toUpperCase()).filter((name) => name !== '')]);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    const upper = name.toUpperCase();
    if (value !== undefined && (named.has(upper) || SESSION_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix)))) { kept[name] = value; }
  }
  return kept;
}

/** The dialog kinds named in the settings. */
export function dialogKinds(settings: Pick<ClaudeSettings, 'CLAUDE_DIALOG_KINDS'>): string[] {
  return settings.CLAUDE_DIALOG_KINDS.split(',').map((kind) => kind.trim()).filter((kind) => kind !== '');
}
