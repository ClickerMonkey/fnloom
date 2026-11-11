/**
 * The chat agent makes a system, end to end: given only the generated authoring guide as context (`/new-system`, fs's
 * `fs/system-authoring`: the guide's parts and the template's whereabouts; the parts load by name), a free model copies
 * the template with fs and fills in a system with one fn. Then the CLI builds and packs it (typecheck included), the
 * hub installs the zip and runs it beside itself, and its fn runs. A failed build is told to the agent, which may fix
 * it twice. The made folder (`systems/<name>`, where the template's paths work) and the install are removed after.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nodeIo, runCli } from '@harness/cli';
import { QualifiedName, SystemName, type SessionId } from '@harness/core';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { waitFor, type SignedIn } from '../scripts/hub-client.ts';
import { ROOT } from '../scripts/stack.ts';
import { admin, Approver, ask, invoke, SessionWatch, settings, settle, textOf } from './kit.ts';
import { goLive } from './review.ts';

const NAME = SystemName.parse('reverser');
const FOLDER = join(ROOT, 'systems', NAME);
const ZIP = resolve(ROOT, settings.HARNESS_E2E_DATA, `${NAME}.zip`);
/** Tries the agent gets: the first, then one per failed build. */
const TRIES = 3;
/** A packed system starts quickly, but the first start pairs and imports its contract. */
const START = 180_000;
/**
 * Root files the CLI's `next:` hint tells a person to edit (workspaces, project references). The agent may follow it;
 * a reference to the removed folder would break every later suite's transform, so they are put back as they were.
 */
const ROOT_FILES = ['tsconfig.json', 'package.json'].map((file) => join(ROOT, file));
const kept = new Map(ROOT_FILES.map((file) => [file, readFileSync(file, 'utf8')]));

let me: SignedIn;
let session: SessionId;
let watch: SessionWatch;
let approver: Approver;

/** Run the CLI as a person would against the hub under test, keeping what it printed. */
async function cli(...argv: string[]): Promise<{ code: number; printed: string }> {
  const hub = inject('e2eHub');
  const io = nodeIo(ROOT, { HARNESS_URL: hub.url, HARNESS_ADMIN_EMAIL: hub.email, HARNESS_ADMIN_PASSWORD: hub.password });
  const lines: string[] = [];
  const code = await runCli(argv, { ...io, out: { line: (text) => { lines.push(text); }, warn: (text) => { lines.push(text); } } });
  return { code, printed: lines.join('\n') };
}

/** Remove what an earlier run left: the made folder, its install, and any change to the root files. */
async function clean(): Promise<void> {
  rmSync(FOLDER, { recursive: true, force: true });
  for (const [file, text] of kept) { if (readFileSync(file, 'utf8') !== text) { writeFileSync(file, text); } }
  if ((await me.hub.call('systems')).some((s) => s.name === NAME && s.status !== 'removed')) { await cli('system', 'uninstall', NAME); }
}

beforeAll(async () => {
  me = await admin();
  await settle(me);
  await clean();
  session = (await me.hub.call('createSession', { title: 'e2e authoring' })).id;
  watch = new SessionWatch(me, session);
  approver = new Approver(me, watch);
}, START);

afterAll(async () => {
  watch.stop();
  await clean().catch(() => undefined);
  me.close();
}, START);

describe('the chat agent writes a system from the guide', () => {
  it('makes it from the template with fs, and the CLI builds and packs it', async () => {
    const asks = [
      [
        `/new-system Make a new harness system named ${NAME}. First copy the template with fs/bash: \`npx harness system new ${NAME}\` (it goes to systems/${NAME}).`,
        `Then give it exactly one fn named \`reverse\`: its args are an object with one text field \`text\`, it returns text, and it returns the text reversed (\`abc\` → \`cba\`).`,
        'Declare it in shared/index.ts and implement it in server/impl.ts with fs/write or fs/edit, following the guide. Keep the TODO comments for the parts you leave out, or delete them.',
        'Change nothing outside its folder (not the root package.json or tsconfig.json). Do not build, pack, install or test it: I will. Tell me when the files are written.',
      ].join(' '),
    ];
    let packed = { code: 1, printed: '' };
    for (let attempt = 0; attempt < TRIES; attempt += 1) {
      const text = asks[attempt] ?? `\`harness system pack systems/${NAME}\` failed:\n\n${packed.printed.slice(-4_000)}\n\nFix the files with fs/read and fs/edit so it typechecks and builds, then tell me.`;
      const { result } = await approver.during(ask(me, watch, text, settings.HARNESS_E2E_TURN_TIMEOUT * 2));
      expect(result.answer.status, textOf(result.answer)).toBe('done');
      packed = await cli('system', 'pack', FOLDER, '--out', ZIP);
      if (packed.code === 0) { break; }
    }
    expect(packed.code, packed.printed).toBe(0);
    expect(packed.printed).toContain(`packed ${NAME}`);
  }, settings.HARNESS_E2E_TURN_TIMEOUT * 2 * TRIES + START);

  it('installs into the hub, which runs it, and its fn runs', async () => {
    const installed = await cli('system', 'install', ZIP, '--wait', String(START));
    expect(installed.code, installed.printed).toBe(0);
    await waitFor(`${NAME} connected`, async () => ((await me.hub.call('systems')).find((s) => s.name === NAME)?.status === 'connected' ? true : undefined), { timeout: START });
    const fns = await me.hub.call('systemFns', { system: NAME });
    expect(fns.map((f) => f.name)).toContain(`${NAME}/reverse`);
    // it offers nothing until the admin reviews it and goes live
    await goLive(me, NAME);
    const { result: run } = await approver.during(invoke(me, session, QualifiedName.parse(`${NAME}/reverse`), { text: 'harness' }));
    expect(run.status).toBe('done');
    expect(run.outcome?.status === 'done' ? run.outcome.result : undefined).toBe('ssenrah');
  }, START * 2);
});
