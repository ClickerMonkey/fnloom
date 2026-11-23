/**
 * Running `ollama serve` as a supervised child, with fake child processes and a fake "does it answer" (nothing runs):
 * the start waits for an answer, runs with a bare environment and Ollama's own settings, refuses a port something
 * already answers on, restarts after a crash with a growing wait, gives up after too many crashes, and stops politely
 * or by force.
 */
import { describe, expect, it } from 'vitest';
import { FakeRunner, type FakeChild } from './fakes.ts';
import { localUrl, OllamaProcess, serveEnv, type ServeLimits, type ServeSpec } from './serve.ts';

const SPEC: ServeSpec = { binary: '/data/ollama/0.12.3/bin/ollama', host: '127.0.0.1', port: 11_435, modelsDir: '/data/models', cwd: '/data', contextLength: 8_192, keepAlive: '10m' };
const LIMITS: ServeLimits = { startTimeout: 1_000, healthEvery: 10, stopGrace: 500, restartDelay: 100, restartMax: 300, restartsPerHour: 4, outputLines: 3 };

/** A supervisor over fakes: the server answers while `up`; `waits` are the sleeps it asked for, resolved at once. */
function rig(options: { answersAtStart?: boolean; up?: (child: FakeChild) => boolean } = {}) {
  const runner = new FakeRunner();
  let now = 1_000;
  // another server already there, and the children that are alive and answer
  let outside = options.answersAtStart ?? false;
  const alive = new Set<FakeChild>();
  runner.started = (child) => {
    if (options.up?.(child) === false) { return; }
    alive.add(child);
    void child.exited.then(() => { alive.delete(child); });
  };
  const waits: number[] = [];
  const events: string[] = [];
  const process = new OllamaProcess({
    runner, answers: () => Promise.resolve(outside || alive.size > 0), env: { PATH: '/usr/bin', HOME: '/home/me', SECRET_TOKEN: 'x', CUDA_VISIBLE_DEVICES: '0' }, passEnv: ['CUDA_VISIBLE_DEVICES'],
    limits: LIMITS, clock: () => now, sleep: (ms, signal) => { waits.push(ms); now += ms; return signal?.aborted === true ? Promise.reject(new Error('aborted')) : Promise.resolve(); },
    log: (event) => { events.push(event); },
  });
  return { runner, process, waits, events, setOutside: (value: boolean) => { outside = value; }, advance: (ms: number) => { now += ms; } };
}

describe('ollama serve', () => {
  it('runs the program with a bare environment and Ollama\'s settings, and waits until it answers', async () => {
    const { runner, process } = rig();
    const states: string[] = [];
    process.onState((state) => { states.push(state); });
    const status = await process.start(SPEC);
    expect(status).toMatchObject({ state: 'running', pid: 1_000, restartsLastHour: 0 });
    expect(states).toEqual(['starting', 'running']);
    const [child] = runner.children;
    expect(child?.command).toBe(SPEC.binary);
    expect(child?.args).toEqual(['serve']);
    expect(child?.options.env).toEqual({
      PATH: '/usr/bin', HOME: '/home/me', CUDA_VISIBLE_DEVICES: '0',
      OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: '/data/models', OLLAMA_CONTEXT_LENGTH: '8192', OLLAMA_KEEP_ALIVE: '10m',
    });
    expect(process.runs(SPEC)).toBe(true);
    // starting it again as it is changes nothing
    await process.start(SPEC);
    expect(runner.children).toHaveLength(1);
  });

  it('keeps the last lines it printed', async () => {
    const { runner, process } = rig();
    await process.start(SPEC);
    for (const line of ['a', 'b', 'c', 'd']) { runner.children[0]?.print(line); }
    expect(process.status().output).toEqual(['b', 'c', 'd']);
  });

  it('refuses to start while something already answers on its port, leaving that server alone', async () => {
    const { runner, process } = rig({ answersAtStart: true });
    await expect(process.start(SPEC)).rejects.toThrow(/Something already answers at http:\/\/127\.0\.0\.1:11435/);
    expect(runner.children).toEqual([]);
    expect(process.status().state).toBe('stopped');
    expect(process.status().problem).toContain('another port');
  });

  it('gives up on a start that never answers, and stops what it started', async () => {
    const { runner, process } = rig({ up: () => false });
    await expect(process.start(SPEC)).rejects.toThrow(/didn't answer at http:\/\/127\.0\.0\.1:11435 within 1 s/);
    expect(runner.children[0]?.kills).toEqual([false]);
    expect(process.status().state).toBe('stopped');
  });

  it('restarts after a crash with a growing wait, and stays down after too many in an hour', async () => {
    const { runner, process, waits, events } = rig();
    await process.start(SPEC);
    const crash = async (): Promise<void> => {
      const child = runner.children.at(-1);
      child?.exit(1);
      await expect.poll(() => runner.children.at(-1) !== child || process.status().state === 'failed').toBe(true);
      await expect.poll(() => process.status().state === 'running' || process.status().state === 'failed').toBe(true);
    };
    await crash();
    await crash();
    await crash();
    expect(runner.children).toHaveLength(4);
    // the restart waits double each time, up to the most
    expect(waits.filter((ms) => ms >= 100)).toEqual([100, 200, 300]);
    expect(process.status()).toMatchObject({ state: 'running', restartsLastHour: 3, lastExit: { code: 1 } });
    await crash();
    expect(process.status().state).toBe('failed');
    expect(process.status().problem).toContain('crashed 4 times in an hour');
    expect(runner.children).toHaveLength(4);
    expect(events).toContain('ollama.server.failed');
  });

  it('stops politely, or kills a server that doesn\'t exit, and never restarts a stopped one', async () => {
    const { runner, process } = rig();
    await process.start(SPEC);
    expect(await process.stop()).toMatchObject({ state: 'stopped', lastExit: { signal: 'SIGTERM' } });
    expect(runner.children[0]?.kills).toEqual([false]);
    await process.start(SPEC);
    const stuck = runner.children[1];
    if (stuck !== undefined) { stuck.politeExit = false; }
    await process.stop();
    expect(stuck?.kills).toEqual([false, true]);
    expect(runner.children).toHaveLength(2);
  });

  it('starts again with a new spec, and reads addresses for this machine', async () => {
    const { runner, process } = rig();
    await process.start(SPEC);
    await process.start({ ...SPEC, port: 11_500 });
    expect(runner.children).toHaveLength(2);
    expect(runner.children[0]?.kills).toEqual([false]);
    expect(localUrl('0.0.0.0', 1)).toBe('http://127.0.0.1:1');
    expect(localUrl('::', 1)).toBe('http://[::1]:1');
    expect(localUrl('fe80::1', 1)).toBe('http://[fe80::1]:1');
    expect(serveEnv({ ...SPEC, host: '::', contextLength: undefined, keepAlive: undefined }, {}, [])).toEqual({ OLLAMA_HOST: '[::]:11435', OLLAMA_MODELS: '/data/models' });
  });
});
