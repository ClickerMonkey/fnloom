/** Restarting and exiting the real process, through its Node seams. */
import { describe, expect, it } from 'vitest';
import { NodeProcess, type ProcessSeams } from './process.ts';

/** Seams that record what the process would do; `exit` throws so "never returns" holds. */
class RecordingSeams implements ProcessSeams {
  readonly copies: number[] = [];
  readonly exits: number[] = [];

  spawnCopy(): void {
    this.copies.push(this.exits.length);
  }

  exit(code: number): never {
    this.exits.push(code);
    throw new Exited(code);
  }
}

class Exited extends Error {
  override readonly name = 'Exited';
  readonly code: number;
  constructor(code: number) {
    super(`exited ${String(code)}`);
    this.code = code;
  }
}

describe('NodeProcess', () => {
  it('under the hub\'s supervisor, restarts by exiting with the restart code and starts no copy', () => {
    const seams = new RecordingSeams();
    expect(() => new NodeProcess({ supervised: true, restartCode: 75 }, seams).restart()).toThrow(Exited);
    expect(seams.copies).toEqual([]);
    expect(seams.exits).toEqual([75]);
  });

  it('started by hand, starts a copy of itself before exiting cleanly', () => {
    const seams = new RecordingSeams();
    expect(() => new NodeProcess({ supervised: false, restartCode: 75 }, seams).restart()).toThrow(Exited);
    expect(seams.copies).toEqual([0]);
    expect(seams.exits).toEqual([0]);
  });

  it('exits with the code it is given', () => {
    const seams = new RecordingSeams();
    expect(() => new NodeProcess({ supervised: true, restartCode: 75 }, seams).exit(3)).toThrow(Exited);
    expect(seams.exits).toEqual([3]);
  });
});
