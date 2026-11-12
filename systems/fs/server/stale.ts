/**
 * Hosted processes left behind by an fs that crashed. Each spawn's pid is kept beside its `host.json`
 * (`process.json`); when fs starts again it looks the pid up, and only when that process still runs the recorded
 * bundle entry (pids are reused) is it killed, with everything it started, before the system starts again. Without
 * this a hosted system could run twice, or stay orphaned holding its folders.
 */
import { z } from 'zod';
import type { Exec } from './index.ts';

/** What `process.json` keeps of a hosted spawn. */
export const HostedProcess = z.object({
  pid: z.number().int().positive(),
  /** The bundle's server file it ran; a process at this pid running anything else is not ours. */
  entry: z.string().min(1),
});
export type HostedProcess = z.infer<typeof HostedProcess>;

/** Looks a process up by pid and kills it with what it started. One per platform; tests use a fake. */
export interface ProcessProbe {
  /** The process's command line, or `undefined` when no process has that pid. */
  commandLine(pid: number): Promise<string | undefined>;
  /** Kill the process and everything it started. */
  kill(pid: number): Promise<void>;
}

/** Windows: the command line from CIM, killed with its tree by taskkill. */
export class WindowsProbe implements ProcessProbe {
  readonly #exec: Exec;
  readonly #timeout: number;

  constructor(exec: Exec, timeout: number) {
    this.#exec = exec;
    this.#timeout = timeout;
  }

  async commandLine(pid: number): Promise<string | undefined> {
    const query = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${String(pid)}').CommandLine`;
    const run = await this.#exec.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { timeout: this.#timeout });
    const line = run.stdout.trim();
    return run.exitCode === 0 && line.length > 0 ? line : undefined;
  }

  async kill(pid: number): Promise<void> {
    await this.#exec.exec('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: this.#timeout });
  }
}

/** POSIX: the command line from `ps`; the hosted process leads its own group, so the group is killed. */
export class PosixProbe implements ProcessProbe {
  readonly #exec: Exec;
  readonly #timeout: number;

  constructor(exec: Exec, timeout: number) {
    this.#exec = exec;
    this.#timeout = timeout;
  }

  async commandLine(pid: number): Promise<string | undefined> {
    const run = await this.#exec.exec('ps', ['-o', 'args=', '-p', String(pid)], { timeout: this.#timeout });
    const line = run.stdout.trim();
    return run.exitCode === 0 && line.length > 0 ? line : undefined;
  }

  kill(pid: number): Promise<void> {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ }
    }
    return Promise.resolve();
  }
}

/** The probe for this platform. */
export function platformProbe(exec: Exec, platform: NodeJS.Platform, timeout: number): ProcessProbe {
  return platform === 'win32' ? new WindowsProbe(exec, timeout) : new PosixProbe(exec, timeout);
}

/**
 * Kill the process `kept` names if it is still the hosted one (its command line names the recorded entry).
 * Resolves to whether one was killed.
 */
export async function killStale(probe: ProcessProbe, kept: HostedProcess): Promise<boolean> {
  const line = await probe.commandLine(kept.pid);
  if (line === undefined || !sameEntry(line, kept.entry)) { return false; }
  await probe.kill(kept.pid);
  return true;
}

/** Whether a command line runs `entry` (separators and case are compared loosely, as Windows writes either). */
function sameEntry(line: string, entry: string): boolean {
  const plain = (text: string) => text.replaceAll('\\', '/').toLowerCase();
  return plain(line).includes(plain(entry));
}
