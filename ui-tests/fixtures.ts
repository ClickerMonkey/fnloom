/**
 * The fixture session the UI features look at, made through the API: an agent turn that reads README.md (a real free
 * model) and a fs/bash run invoked by hand and approved. It is kept in `ui-tests/shots/fixtures.json` per base URL and
 * reused while the hub still has it, so only the first run waits for the model.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageId, QualifiedName, RunId, SessionId, TurnId } from '@harness/core';
import { z } from 'zod';
import { settle, type SignedIn } from '../scripts/hub-client.ts';
import { Approver, ask, clientInfo, finished, SessionWatch } from '../scripts/session.ts';
import type { Fixtures } from './kit.ts';

/** Where fixtures are remembered between runs. */
const FILE = fileURLToPath(new URL('./shots/fixtures.json', import.meta.url));

/** The remembered fixtures, by base URL. One schema, so a stale or hand-edited file is simply ignored. */
const Stored = z.record(z.string(), z.object({
  session: SessionId, readTurn: TurnId, userMessage: MessageId, answer: MessageId, bashRun: RunId, bashTurn: TurnId,
}));

/** The fixtures remembered for `base`, if the hub still has them. */
async function remembered(api: SignedIn, base: string): Promise<Fixtures | undefined> {
  if (!existsSync(FILE)) { return undefined; }
  const parsed = Stored.safeParse(JSON.parse(readFileSync(FILE, 'utf8')));
  const found = parsed.success ? parsed.data[base] : undefined;
  if (found === undefined) { return undefined; }
  try {
    const run = await api.hub.call('run', { run: found.bashRun });
    return run.status === 'done' ? found : undefined;
  } catch {
    return undefined;
  }
}

/** Make (or reuse) the fixture session. */
export async function fixtures(api: SignedIn, base: string, turnTimeout: number): Promise<Fixtures> {
  const known = await remembered(api, base);
  if (known !== undefined) { return known; }
  await settle(api);
  const session = await api.hub.call('createSession', { title: 'UI tests' });
  const watch = new SessionWatch(api, session.id);
  const approver = new Approver(api, watch);
  try {
    await settle(api);
    const read = await ask(api, watch, 'Use the fs/read tool to read README.md, then summarise it in two sentences. Do not run shell commands.', turnTimeout);
    if (read.answer.status !== 'done') { throw new Error(`the fixture turn ended ${read.answer.status}`); }
    const userMessage = watch.of('message').find((e) => e.message.turn === read.turn && e.message.role === 'user')?.message.id;
    if (userMessage === undefined) { throw new Error('the fixture turn has no user message'); }
    const { result: bash } = await approver.during((async () => {
      const invoked = await api.hub.call('invoke', { session: session.id, fn: QualifiedName.parse('fs/bash'), args: { command: 'echo ui-tests' }, client: clientInfo() });
      await watch.next('run', (e) => e.run === invoked.run && finished(e.update), 60_000);
      return invoked;
    })());
    const made: Fixtures = { session: session.id, readTurn: read.turn, userMessage, answer: read.answer.id, bashRun: bash.run, bashTurn: bash.turn };
    const all = existsSync(FILE) ? Stored.safeParse(JSON.parse(readFileSync(FILE, 'utf8'))) : undefined;
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ ...(all?.success === true ? all.data : {}), [base]: made }, null, 2));
    return made;
  } finally {
    watch.stop();
  }
}
