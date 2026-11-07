/**
 * The outcome journal: how a run settles exactly once. A run's reply can be lost when the link drops; the hub then
 * sends the same run (same `RunId`) again on the next connection, and the system answers from the journal instead of
 * running it twice.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OutcomeWire, RunId } from '@harness/core';
import { z } from 'zod';
import { isMissing } from './keys.ts';

/** Where settled outcomes are kept. */
export interface OutcomeJournal {
  /** The outcome a run settled with, if it did. */
  get(run: RunId): Promise<OutcomeWire | undefined>;
  /** Record a run's outcome. */
  put(run: RunId, outcome: OutcomeWire): Promise<void>;
}

/** A bounded map from run to outcome: the newest `size` entries are kept. */
class Recent {
  readonly #entries = new Map<RunId, OutcomeWire>();
  readonly #size: number;

  constructor(size: number) {
    this.#size = size;
  }

  get(run: RunId): OutcomeWire | undefined {
    return this.#entries.get(run);
  }

  /** Add an entry; true when older ones were dropped. */
  put(run: RunId, outcome: OutcomeWire): boolean {
    this.#entries.delete(run);
    this.#entries.set(run, outcome);
    let dropped = false;
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#size) { break; }
      this.#entries.delete(key);
      dropped = true;
    }
    return dropped;
  }

  entries(): IterableIterator<[RunId, OutcomeWire]> {
    return this.#entries.entries();
  }
}

/** A journal in memory. For tests and systems that don't need to survive a restart. */
export class MemoryJournal implements OutcomeJournal {
  readonly #recent: Recent;

  constructor(size: number) {
    this.#recent = new Recent(size);
  }

  get(run: RunId): Promise<OutcomeWire | undefined> {
    return Promise.resolve(this.#recent.get(run));
  }

  put(run: RunId, outcome: OutcomeWire): Promise<void> {
    this.#recent.put(run, outcome);
    return Promise.resolve();
  }
}

const Line = z.object({ run: RunId, outcome: OutcomeWire });

/**
 * A journal in `journal.jsonl` in the system's state folder: one line per outcome, rewritten to the newest `size`
 * entries when it grows past that. A line that doesn't parse (a torn write) is skipped.
 */
export class FileJournal implements OutcomeJournal {
  readonly #file: string;
  readonly #recent: Recent;
  #loaded: Promise<void> | undefined;
  #writes: Promise<void> = Promise.resolve();

  constructor(stateFolder: string, size: number) {
    this.#file = join(stateFolder, 'journal.jsonl');
    this.#recent = new Recent(size);
  }

  async get(run: RunId): Promise<OutcomeWire | undefined> {
    await this.#load();
    return this.#recent.get(run);
  }

  async put(run: RunId, outcome: OutcomeWire): Promise<void> {
    await this.#load();
    const dropped = this.#recent.put(run, outcome);
    const line = `${JSON.stringify({ run, outcome })}\n`;
    this.#writes = this.#writes.then(() => (dropped ? this.#rewrite() : appendFile(this.#file, line)));
    await this.#writes;
  }

  #load(): Promise<void> {
    this.#loaded ??= this.#read();
    return this.#loaded;
  }

  async #read(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    let text = '';
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (!isMissing(error)) { throw error; }
    }
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') { continue; }
      const line = Line.safeParse(safeJson(raw));
      if (line.success) { this.#recent.put(line.data.run, line.data.outcome); }
    }
  }

  async #rewrite(): Promise<void> {
    const lines = [...this.#recent.entries()].map(([run, outcome]) => `${JSON.stringify({ run, outcome })}\n`);
    await writeFile(this.#file, lines.join(''));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
