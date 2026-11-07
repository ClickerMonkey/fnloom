/** What the bash card shows, worked out from its view so the component only draws. Pure and browser-safe. */
import { RUN_STATUS_WORDS, type FnError, type RunStatus } from '@harness/core';

/** The tone of the card's status chip. */
export type Tone = 'busy' | 'ok' | 'bad' | 'quiet';

/** The status chip: a short label and its tone. */
export interface Chip {
  readonly label: string;
  readonly tone: Tone;
}

/**
 * The chip for a run: its status in core's words, except that a finished command says its exit code and a failure
 * says when it timed out. Every status is handled, so a new one fails to compile until it is.
 */
export function statusChip(status: RunStatus, exitCode: number | undefined, error: FnError | undefined): Chip {
  const label = RUN_STATUS_WORDS[status];
  switch (status) {
    case 'running': return { label, tone: 'busy' };
    case 'awaiting-approval': case 'queued': case 'waiting': case 'paused': case 'cancelled': case 'undone': return { label, tone: 'quiet' };
    case 'failed': return { label: error?.code === 'timeout' ? 'Timed out' : label, tone: 'bad' };
    case 'done': return exitCode === undefined || exitCode === 0 ? { label, tone: 'ok' } : { label: `Exit ${exitCode}`, tone: 'bad' };
  }
}

/** The output a failed run still carries (a timeout keeps what was printed). */
export function failedOutput(error: FnError | undefined): { stdout: string; stderr: string } | undefined {
  const data = error?.data;
  if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) { return undefined; }
  const stdout = data['stdout'];
  const stderr = data['stderr'];
  return typeof stdout === 'string' && typeof stderr === 'string' ? { stdout, stderr } : undefined;
}

/** A progress fraction as a whole percentage, clamped. */
export function percent(fraction: number | undefined): number {
  return Math.round(Math.min(1, Math.max(0, fraction ?? 0)) * 100);
}

