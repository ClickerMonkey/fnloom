/**
 * `npm run prompt:memory`: the hub's memory over a run of planned prompts. Boots the same fresh stack as
 * `prompt:render` (`.harness-test/prompt-memory/`, port 4362: hub, fs on a fake home, a new SQLite database, input,
 * widgets, code, api, and the embedder when one answers), goes live with every system, then plans the chat agents'
 * prompts over and over (`previewPrompt`: the planner, the aeye request with every tool's and the output's schema
 * bound, rendered and fitted for the model, no model called), alternating `hub/chat` (tools mode, the scenarios'
 * model) and `hub/chat_small` (static mode, a 16,384-token Ollama model and the scenarios' model; 2,048 refuses this message), with a fresh session
 * every 10 rounds. It samples the hub process's working set (the process listening on the port) before the first
 * round and after every 10, and prints the samples, the time per prompt and the growth per prompt after the first 10
 * (the warm-up: caches filling). `ROUNDS` (default 200) sets how many prompts. Stops the stack after.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QualifiedName, type SessionId } from '@harness/core';
import { goLiveAll } from '../e2e/review.ts';
import { ROOT, startStack, type ComponentName } from './stack.ts';
import { loadSettings } from './scenarios/env.ts';
import { ADMIN, embedderAnswers, homeFolder, portTaken, waitForIndex } from './scenarios/rep.ts';
import type { DatabaseConfig } from '../systems/database/shared/shapes.ts';

const PORT = 4362;
const DATA = join(ROOT, '.harness-test', 'prompt-memory');
const MESSAGE = 'Can you help me keep track of what I spend each month?';
const SMALL = { model: 'qwen2.5:3b', limits: { contextWindow: 16_384, maxOutputTokens: 512, reasoningTokens: 0, charsPerToken: 3.5 } } as const;
const ROUNDS = Number(process.env['ROUNDS'] ?? 200);
const SCRATCH: DatabaseConfig = {
  label: 'Household', connection: { kind: 'sqlite-new', path: 'household.db' },
  data: 'read-write', schema: 'allowed', enrich: { on: false }, audience: { visibility: 'public', with: [] },
};

const log = (line: string): void => { process.stdout.write(`${line}\n`); };

/** The pid listening on a TCP port (Windows `netstat`, else `lsof`). */
function pidOn(port: number): number {
  if (process.platform === 'win32') {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    const line = out.split(/\r?\n/).find((row) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING`).test(row));
    const pid = Number(line?.trim().split(/\s+/).at(-1));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no process listens on ${port}`);
    return pid;
  }
  return Number(execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]);
}

/** A process's working set (resident memory), in MB. */
function residentMb(pid: number): number {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' });
    return Number(out.trim()) / 1024 / 1024;
  }
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
}

async function main(): Promise<void> {
  const settings = loadSettings();
  if (await portTaken(PORT)) throw new Error(`something already listens on ${PORT}`);
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const home = homeFolder({ HARNESS_SCENARIOS_HOME_ROOT: join(tmpdir(), 'harness-prompt-memory') }, 'prompt-memory', 1, undefined, undefined);
  const embedder = await embedderAnswers(settings.HARNESS_SCENARIOS_EMBEDDER);
  const systems: ComponentName[] = ['hub', 'fs', 'database', 'input', 'widgets', 'code', 'api', ...(embedder ? ['embedder' as const] : [])];
  log(`starting ${systems.join(', ')} on ${PORT}`);
  const stack = await startStack({
    port: PORT, data: DATA, admin: ADMIN, build: false, watch: false, timeout: settings.HARNESS_SCENARIOS_START_TIMEOUT, only: new Set(systems),
    systems: {
      fs: { roots: [{ name: 'home', path: home, writable: true, index: 'all' }], self: join(ROOT, 'systems', 'fs') },
      embedder: { url: settings.HARNESS_SCENARIOS_EMBEDDER },
      databases: { main: SCRATCH },
    },
    hubEnv: { HARNESS_LOG_FILES: 'false', HARNESS_DEFAULT_MODEL: settings.HARNESS_SCENARIOS_MODEL },
    output: () => undefined,
  });
  try {
    const { admin } = stack;
    log(`live: ${(await goLiveAll(admin)).join(', ')}`);
    if (embedder) await waitForIndex(admin, settings, log);
    await admin.hub.call('setModelLimits', SMALL);
    const pid = pidOn(PORT);
    const targets = [
      { agent: QualifiedName.parse('hub/chat'), model: undefined },
      { agent: QualifiedName.parse('hub/chat_small'), model: SMALL.model },
      { agent: QualifiedName.parse('hub/chat_small'), model: undefined },
    ] as const;
    const samples: Array<{ round: number; mb: number; ms: number }> = [{ round: 0, mb: residentMb(pid), ms: 0 }];
    log(`hub pid ${pid}: ${samples[0]?.mb.toFixed(1)} MB before the first prompt`);
    const sessions = new Map<string, SessionId>();
    let since = performance.now();
    for (let round = 1; round <= ROUNDS; round++) {
      const target = targets[round % targets.length] ?? targets[0];
      const key = `${target.agent}|${target.model ?? ''}|${Math.floor(round / 10)}`;
      let session = sessions.get(key);
      if (session === undefined) {
        session = (await admin.hub.call('createSession', { agent: target.agent })).id;
        sessions.set(key, session);
      }
      await admin.hub.call('previewPrompt', { session, text: `${MESSAGE} (${round})`, ...(target.model === undefined ? {} : { model: target.model }) });
      if (round % 10 === 0) {
        const now = performance.now();
        samples.push({ round, mb: residentMb(pid), ms: (now - since) / 10 });
        since = now;
        const last = samples.at(-1);
        if (last !== undefined) log(`round ${round}: ${last.mb.toFixed(1)} MB, ${last.ms.toFixed(0)} ms per prompt`);
      }
    }
    const warm = samples.find((s) => s.round === 10);
    const last = samples.at(-1);
    const growth = warm === undefined || last === undefined || last.round === warm.round ? 0 : (last.mb - warm.mb) / (last.round - warm.round);
    const report = [
      `# Hub memory over ${ROUNDS} planned prompts`,
      '',
      '| after prompt | working set (MB) | ms per prompt (last 10) |',
      '|---:|---:|---:|',
      ...samples.map((s) => `| ${s.round} | ${s.mb.toFixed(1)} | ${s.round === 0 ? '' : s.ms.toFixed(0)} |`),
      '',
      `Growth after the first 10: ${(growth * 1024).toFixed(1)} KB per prompt.`,
    ].join('\n');
    writeFileSync(join(DATA, 'memory.md'), `${report}\n`);
    log(report);
  } finally {
    await stack.stop();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
