/**
 * Each system's recent output for the admin page: the lines it logs over the link and the hub's notes about it
 * (connected, disconnected), kept in memory per system up to a cap, oldest dropped first. Every new line is
 * published as `system.output`, which the web API relays to admins watching that system.
 */
import type { JsonObject, LogLine, OutputLine, SystemName } from '@harness/core';
import type { EventBus } from '../bus.ts';

/** How many lines are kept per system. */
export const OUTPUT_LINES = 2_000;

/** A system's recent output. */
export interface SystemOutput {
  /** The last `limit` lines, oldest first. */
  tail(system: SystemName, limit: number): OutputLine[];
  /** A line the system logged over the link. */
  logged(system: SystemName, line: LogLine): void;
  /** A note the hub writes about the system. */
  note(system: SystemName, text: string): void;
}

/** A structured log line as one line of text: `level key k=v, k=v`. */
export function renderLogLine(line: LogLine): string {
  const fields: JsonObject = line.fields;
  const rendered = Object.entries(fields).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return [line.level, line.key, rendered.join(', ')].filter((part) => part !== '').join(' ');
}

/** Output kept in memory. */
export class MemorySystemOutput implements SystemOutput {
  readonly #lines = new Map<SystemName, OutputLine[]>();
  readonly #options: { bus: EventBus; clock: () => number; max?: number };

  constructor(options: { bus: EventBus; clock: () => number; max?: number }) {
    this.#options = options;
  }

  /** Note connects and disconnects as they happen; returns the stop. */
  start(): () => void {
    return this.#options.bus.subscribe('system.status', ({ system, status }) => { this.note(system, `status ${status}`); });
  }

  tail(system: SystemName, limit: number): OutputLine[] {
    return (this.#lines.get(system) ?? []).slice(-limit);
  }

  logged(system: SystemName, line: LogLine): void {
    this.#add(system, { at: this.#options.clock(), stream: line.level === 'warn' || line.level === 'error' ? 'stderr' : 'stdout', text: renderLogLine(line) });
  }

  note(system: SystemName, text: string): void {
    this.#add(system, { at: this.#options.clock(), stream: 'hub', text });
  }

  #add(system: SystemName, line: OutputLine): void {
    const lines = this.#lines.get(system) ?? [];
    lines.push(line);
    const max = this.#options.max ?? OUTPUT_LINES;
    if (lines.length > max) { lines.splice(0, lines.length - max); }
    this.#lines.set(system, lines);
    this.#options.bus.publish('system.output', { system, line });
  }
}
