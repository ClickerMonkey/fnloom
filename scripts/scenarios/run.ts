/**
 * `npm run scenarios`: plays the 40 everyday requests (docs/plans/scenarios-2026-11-21.md) against a fresh harness,
 * judges each, and writes the iteration's report. Each repetition boots its own stack on a clean slate (a new data
 * folder, hub database, scratch database and fake home folder); within it each case runs as its own new person, a few
 * at a time. Results stay in `.harness-test/scenarios/<iteration>/` (kept, so `--view` can open them).
 *
 *   --cases 1,5,12        which cases (default: all 40)
 *   --reps 3              repetitions of each case, each on its own fresh stack (default 3)
 *   --iteration <name>    the results folder's name (default: the date and time); a rerun of a name replaces its reps
 *   --concurrency 3       cases played at once in a repetition (default 3)
 *   --report-only         rebuild report.md / report.json of --iteration from what it saved, run nothing
 *   --publish             write the hitl review (on by default after a run of all 40 cases); --no-publish to skip
 *   --view <iteration> --rep <n>   serve that repetition's saved hub (and the web app) on the view port (4351) to
 *                         the network, systems offline, until Ctrl+C, listing each case's sign-in and chats
 *   --fixtures            make the fixtures again first
 *
 * Settings (environment): HARNESS_SCENARIOS_PORT (4350), HARNESS_SCENARIOS_VIEW_PORT (4351), HARNESS_SCENARIOS_MODEL,
 * _PERSON_MODEL and _JUDGE_MODEL (openai/gpt-6-luna), HARNESS_SCENARIOS_EMBEDDER, OPENROUTER_API_KEY and
 * TAVILY_API_KEY (on Windows read from the user environment when missing). See `env.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CASES, pickCases, type Case } from './cases.ts';
import { loadSettings, type ScenariosSettings } from './env.ts';
import { fixturesReady, makeFixtures } from './fixtures/make.ts';
import { judgeCase } from './judge.ts';
import { OpenRouter } from './openrouter.ts';
import { playCase, type PlayContext } from './play.ts';
import { publish } from './publish.ts';
import { RepPeople, type JudgedCase } from './records.ts';
import { iterationFolder, writeReport, type RepMeta } from './report.ts';
import { ADMIN, FIXTURES_DIR, portTaken, repFolder, startRep, tailscaleBase, viewBase, viewRep } from './rep.ts';
import { caseMarkdown, usd } from './transcript.ts';

const Flags = z.object({
  cases: z.string().optional().transform((list) => (list === undefined ? undefined : list.split(',').map((id) => z.coerce.number().int().min(1).parse(id.trim())))),
  reps: z.coerce.number().int().min(1).max(10).default(3),
  iteration: z.string().regex(/^[\w.-]+$/, 'letters, digits, dots, dashes and underscores').optional(),
  concurrency: z.coerce.number().int().min(1).max(8).default(3),
  'report-only': z.boolean().default(false),
  publish: z.boolean().optional(),
  'no-publish': z.boolean().default(false),
  view: z.string().optional(),
  rep: z.coerce.number().int().min(1).optional(),
  fixtures: z.boolean().default(false),
});
type Flags = z.infer<typeof Flags>;

function flags(): Flags {
  const { values } = parseArgs({
    options: {
      cases: { type: 'string' }, reps: { type: 'string' }, iteration: { type: 'string' }, concurrency: { type: 'string' },
      'report-only': { type: 'boolean' }, publish: { type: 'boolean' }, 'no-publish': { type: 'boolean' }, view: { type: 'string' }, rep: { type: 'string' }, fixtures: { type: 'boolean' },
    },
  });
  return Flags.parse(values);
}

const log = (line: string): void => { console.log(`[scenarios ${new Date().toISOString().slice(11, 19)}] ${line}`); };

/** Run `work` over `items`, `limit` at a time. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) { await work(item); }
  }));
}

/** Play and judge every case of one repetition on its own fresh stack. */
async function runRep(settings: ScenariosSettings, router: OpenRouter, iteration: string, rep: number, cases: readonly Case[], concurrency: number): Promise<JudgedCase[]> {
  const started = new Date().toISOString();
  const handle = await startRep(settings, iteration, rep, log);
  const folder = repFolder(iteration, rep);
  const meta: RepMeta = {
    rep, systems: [...handle.systems], skipped: [...handle.skipped], startedAt: started, model: settings.HARNESS_SCENARIOS_MODEL,
    ...(handle.index === undefined ? {} : { index: handle.index }),
  };
  writeFileSync(join(folder, 'rep.json'), `${JSON.stringify(meta, null, 2)}\n`);
  const people: RepPeople = { admin: { ...ADMIN }, cases: [] };
  const judged: JudgedCase[] = [];
  mkdirSync(join(folder, 'cases'), { recursive: true });
  const stop = (): void => { void handle.stop().finally(() => process.exit(130)); };
  process.once('SIGINT', stop);
  try {
    const context: PlayContext = {
      rep: handle, iteration, repNumber: rep, router, personModel: settings.HARNESS_SCENARIOS_PERSON_MODEL,
      turnTimeout: settings.HARNESS_SCENARIOS_TURN_TIMEOUT, viewPort: settings.HARNESS_SCENARIOS_VIEW_PORT, log,
    };
    await pool(cases, concurrency, async (played) => {
      log(`rep ${rep}: case ${played.id} (${played.title}) starts`);
      const record = await playCase(context, played);
      const result = await judgeCase(router, settings.HARNESS_SCENARIOS_JUDGE_MODEL, record);
      const name = `case-${String(played.id).padStart(2, '0')}`;
      writeFileSync(join(folder, 'cases', `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(folder, 'cases', `${name}.md`), `${caseMarkdown(result)}\n`);
      people.cases.push({ case: played.id, ...result.person, sessions: result.sessions.map((s) => s.id) });
      writeFileSync(join(folder, 'people.json'), `${JSON.stringify(people, null, 2)}\n`);
      judged.push(result);
      const j = result.judgement;
      log(`rep ${rep}: case ${played.id} ${j === null ? 'not judged' : `${j.verdict} ${j.score}/10`} · ended ${result.ending.by} · ${Math.round(result.stats.wallMs / 1000)}s · ${usd(result.stats.hubCost + result.stats.personCost + result.judgeCost)}`);
    });
  } finally {
    process.off('SIGINT', stop);
    await handle.stop();
    writeFileSync(join(folder, 'rep.json'), `${JSON.stringify({ ...meta, endedAt: new Date().toISOString() }, null, 2)}\n`);
  }
  return judged;
}

/** Serve a saved repetition until Ctrl+C. */
async function view(settings: ScenariosSettings, iteration: string, rep: number): Promise<void> {
  if (await portTaken(settings.HARNESS_SCENARIOS_VIEW_PORT)) { throw new Error(`port ${settings.HARNESS_SCENARIOS_VIEW_PORT} is taken`); }
  const stack = await viewRep(settings, iteration, rep);
  const people = RepPeople.parse(JSON.parse(readFileSync(join(repFolder(iteration, rep), 'people.json'), 'utf8')));
  const base = viewBase(settings.HARNESS_SCENARIOS_VIEW_PORT);
  const tailscale = tailscaleBase(settings.HARNESS_SCENARIOS_VIEW_PORT);
  console.log(`\n${iteration} rep ${rep} is open at ${base}${tailscale === undefined ? '' : ` (Tailscale ${tailscale})`}; systems are offline.\n`);
  for (const person of [...people.cases].sort((a, b) => a.case - b.case)) {
    const title = CASES.find((c) => c.id === person.case)?.title ?? '';
    console.log(`case ${person.case}. ${title}: sign in as ${person.email} / ${person.password}\n  ${person.sessions.map((s) => `${base}/chat/${s}`).join('\n  ')}`);
  }
  console.log(`\nadmin: ${people.admin.email} / ${people.admin.password}. Ctrl+C to stop.`);
  const shutdown = (): void => { void stack.stop().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => undefined);
}

async function main(): Promise<void> {
  const options = flags();
  const settings = loadSettings();
  if (options.view !== undefined) {
    await view(settings, options.view, options.rep ?? 1);
    return;
  }
  if (options['report-only']) {
    if (options.iteration === undefined) { throw new Error('--report-only needs --iteration <name>'); }
    const { path, report } = writeReport(options.iteration);
    log(`report: ${path} (${usd(report.cost.total)})`);
    if (options.publish === true) { const { file, links } = publish(options.iteration); log(`hitl review: ${file}\n  ${links.join('\n  ')}`); }
    return;
  }
  if (settings.OPENROUTER_API_KEY === undefined) { throw new Error('OPENROUTER_API_KEY is not set (nor in the Windows user environment)'); }
  if (await portTaken(settings.HARNESS_SCENARIOS_PORT)) { throw new Error(`port ${settings.HARNESS_SCENARIOS_PORT} is taken; stop what runs there or set HARNESS_SCENARIOS_PORT`); }
  if (options.fixtures || !fixturesReady(FIXTURES_DIR)) {
    log(`making fixtures in ${FIXTURES_DIR}`);
    await makeFixtures(FIXTURES_DIR);
  }
  const cases = pickCases(options.cases);
  const iteration = options.iteration ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  mkdirSync(iterationFolder(iteration), { recursive: true });
  const router = new OpenRouter(settings.OPENROUTER_API_KEY);
  log(`iteration ${iteration}: cases ${cases.map((c) => c.id).join(',')} × ${options.reps} rep(s), ${options.concurrency} at a time, model ${settings.HARNESS_SCENARIOS_MODEL}`);
  for (let rep = 1; rep <= options.reps; rep++) {
    await runRep(settings, router, iteration, rep, cases, options.concurrency);
  }
  const { path, report } = writeReport(iteration);
  log(`report: ${path}`);
  log(`cost: ${usd(report.cost.total)} (hub ${usd(report.cost.hub)}, person ${usd(report.cost.person)}, judge ${usd(report.cost.judge)})`);
  const full = cases.length === CASES.length;
  if (!options['no-publish'] && (options.publish === true || full)) {
    const { file, links } = publish(iteration);
    log(`hitl review: ${file}\n  ${links.join('\n  ')}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
