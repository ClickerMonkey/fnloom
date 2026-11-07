/** What the bash card shows, worked out from its view so the component only draws. Pure and browser-safe. */
import type { DeliveryStatus, FnError, RunStatus } from '@harness/core';

/** The tone of the card's status chip. */
export type Tone = 'busy' | 'ok' | 'bad' | 'quiet';

/** The status chip: a short label and its tone. */
export interface Chip {
  readonly label: string;
  readonly tone: Tone;
}

const WAITING: ReadonlySet<RunStatus> = new Set(['awaiting-approval', 'queued', 'waiting', 'paused']);

/** The chip for a run: running, its exit code, or how it ended. */
export function statusChip(status: RunStatus, exitCode: number | undefined, error: FnError | undefined): Chip {
  if (status === 'running') { return { label: 'Running', tone: 'busy' }; }
  if (status === 'awaiting-approval') { return { label: 'Needs approval', tone: 'quiet' }; }
  if (WAITING.has(status)) { return { label: status === 'paused' ? 'Paused' : 'Waiting', tone: 'quiet' }; }
  if (status === 'cancelled') { return { label: 'Stopped', tone: 'quiet' }; }
  if (status === 'undone') { return { label: 'Undone', tone: 'quiet' }; }
  if (status === 'failed') { return { label: error?.code === 'timeout' ? 'Timed out' : 'Failed', tone: 'bad' }; }
  return exitCode === undefined || exitCode === 0 ? { label: 'Done', tone: 'ok' } : { label: `Exit ${exitCode}`, tone: 'bad' };
}

/** The chip for a "run again" delivery. */
export function deliveryChip(status: DeliveryStatus, exitCode: number | undefined): Chip {
  switch (status) {
    case 'queued': return { label: 'Queued until fs is online', tone: 'quiet' };
    case 'delivered': return { label: 'Running', tone: 'busy' };
    case 'failed': return { label: 'Couldn\'t run', tone: 'bad' };
    case 'expired': return { label: 'Expired', tone: 'quiet' };
    case 'done': return exitCode === undefined || exitCode === 0 ? { label: 'Done', tone: 'ok' } : { label: `Exit ${exitCode}`, tone: 'bad' };
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

