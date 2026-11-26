/**
 * `npm run scenarios`: plays everyday requests against a fresh harness: by default the first 40
 * (docs/plans/scenarios-2026-11-21.md, cases 1-40); the second 40 (docs/plans/scenarios-2-2026-11-26.md, cases 41-80)
 * only when asked (`--cases 41-80` or `--cases second`). It
 * judges and diagnoses each, and writes the iteration's report. Each repetition boots its own stack on a clean slate
 * (a new data folder, hub database, scratch database and fake home folder); within it each case runs as its own new
 * person, a few at a time. Results stay in `.harness-test/scenarios/<iteration>/` (kept, so `--view` can open them).
 *
 * A hub that stops answering never takes the run down: the cases it was playing are saved as `harness-crash` (with
 * the end of the stack's log), what finished stays, the crash goes in `rep.json` and the report's header, and the
 * rep's unplayed cases go on on a fresh stack in `rep-<n>/restart-<k>/` (at most two restarts a rep; past that they
 * are marked `harness-crash` too and the next rep starts).
 *
 *   --cases 1,5,12        which cases: ids, ranges and sets, comma separated (`41-80`, `1-40,45`, `first`, `second`, `all`);
 *                         default: the first set (1-40), so a plain run is the original 40. A run of one whole set is
 *                         published by default. A rep runs the schedule system only when one of its cases needs it (59-62)
 *   --variants off,on     the household variants (`variants.ts`: off, on, load; default `off`): with more than one, each rep of each
 *                         variant gets its own fresh stack, in `<iteration>/<variant>/rep-<n>/`, reps interleaved
 *                         (rep 1 off, rep 1 on, rep 2 off, …), and the report compares them case by case
 *   --variant <name>      with --diagnose or --view: the variant folder to read (a run of several variants)
 *   --reps 3              repetitions of each case, each on its own fresh stack (default 3)
 *   --iteration <name>    the results folder's name (default: the date and time); a rerun of a name replaces its reps
 *   --concurrency 3       cases played (or diagnosed) at once (default 3)
 *   --no-diagnose         don't diagnose each case after its judge (`diagnose.ts`)
 *   --diagnose            diagnose the saved cases of --iteration (only --cases, only --rep), run nothing; a case rep
 *                         already diagnosed is kept unless --force; then diagnosis.md and the report are written again
 *   --report-only         rebuild report.md / report.json (and diagnosis.md from saved diagnoses) of --iteration
 *   --publish             write the hitl review (on by default after a run of all 40 cases); --no-publish to skip
 *   --view <iteration> --rep <n> [--variant <v>]   serve that repetition's saved hub (and the web app) on the view port (4351) to
 *                         the network, systems offline, until Ctrl+C, listing each case's sign-in and chats
 *   --fixtures            make the fixtures again first
 *
 * Settings (environment): HARNESS_SCENARIOS_PORT (4350), HARNESS_SCENARIOS_VIEW_PORT (4351), HARNESS_SCENARIOS_MODEL,
 * _PERSON_MODEL, _JUDGE_MODEL and _DIAGNOSE_MODEL (openai/gpt-6-luna), HARNESS_SCENARIOS_DECISION_MODEL (the `on`
 * variant's, typesafe/jev-1.14), HARNESS_SCENARIOS_BUSY_* (patience with a hub that sheds load, `busy.ts`),
 * HARNESS_SCENARIOS_HOME_ROOT (the fake home folders, outside any git repository), HARNESS_SCENARIOS_EMBEDDER, OPENROUTER_API_KEY
 * and TAVILY_API_KEY (on Windows read from the user environment when missing). See `env.ts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CASES, neededSystems, parseCaseIds, pickCases, wholeSet, type Case } from './cases.ts';
import { aggregate, diagnoseCase, diagnosisMarkdown, loadDiagnoses, loadDiagnosis, type CaseDiagnosis } from './diagnose.ts';
import { loadSettings, type ScenariosSettings } from './env.ts';
import { fixturesReady, makeFixtures } from './fixtures/make.ts';
import { judgeCase } from './judge.ts';
import { OpenRouter } from './openrouter.ts';
import { playCase, type PlayContext } from './play.ts';
import { publish } from './publish.ts';
import { RepPeople, type Ending, type JudgedCase } from './records.ts';
import { iterationFolder, loadIteration, savedVariants, writeReport, type RepCrash, type RepMeta } from './report.ts';
import { ADMIN, FIXTURES_DIR, PERSON_PASSWORD, portTaken, repFolder, startRep, tailscaleBase, viewBase, viewRep, type Rep } from './rep.ts';
import { caseMarkdown, usd } from './transcript.ts';
import { noShedding, shedOf, type Shedding } from './busy.ts';
import { checkVariantSupport, parseVariants, proveDecisionModel, VARIANT_LABELS, VariantName, type VariantRecord } from './variants.ts';

const Flags = z.object({
  variants: z.string().optional(),
  variant: VariantName.optional(),
  cases: z.string().optional().transform((list) => (list === undefined ? undefined : parseCaseIds(list))),
  reps: z.coerce.number().int().min(1).max(10).default(3),
  iteration: z.string().regex(/^[\w.-]+$/, 'letters, digits, dots, dashes and underscores').optional(),
  concurrency: z.coerce.number().int().min(1).max(8).default(3),
  'report-only': z.boolean().default(false),
  publish: z.boolean().optional(),
  'no-publish': z.boolean().default(false),
  diagnose: z.boolean().default(false),
  'no-diagnose': z.boolean().default(false),
  force: z.boolean().default(false),
  view: z.string().optional(),
  rep: z.coerce.number().int().min(1).optional(),
  fixtures: z.boolean().default(false),
});
type Flags = z.infer<typeof Flags>;

function flags(): Flags {
  const { values } = parseArgs({
    options: {
      variants: { type: 'string' }, variant: { type: 'string' }, cases: { type: 'string' }, reps: { type: 'string' }, iteration: { type: 'string' }, concurrency: { type: 'string' },
      'report-only': { type: 'boolean' }, publish: { type: 'boolean' }, 'no-publish': { type: 'boolean' }, view: { type: 'string' }, rep: { type: 'string' }, fixtures: { type: 'boolean' },
      diagnose: { type: 'boolean' }, 'no-diagnose': { type: 'boolean' }, force: { type: 'boolean' },
    },
  });
  return Flags.parse(values);
}

const log = (line: string): void => { console.log(`[scenarios ${new Date().toISOString().slice(11, 19)}] ${line}`); };

/** How many fresh stacks a rep may start after its hub crashed. */
const MAX_RESTARTS = 2;

/** Run `work` over `items`, `limit` at a time; `work` must not throw. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try { await work(item); } catch (error) { log(`a worker failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }));
}

/** Whether the hub still answers (one that sheds load, HTTP 503, is busy, not dead). */
async function hubAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(10_000) });
    return response.ok || response.status === 503;
  } catch {
    return false;
  }
}

/** Several stacks' shedding as one. */
function sumShedding(tallies: readonly Shedding[]): Shedding {
  const total = noShedding();
  for (const t of tallies) {
    total.calls += t.calls; total.sheds += t.sheds; total.gaveUp += t.gaveUp; total.waitedMs += t.waitedMs;
    if (t.first !== undefined && (total.first === undefined || t.first < total.first)) { total.first = t.first; }
    if (t.last !== undefined && (total.last === undefined || t.last > total.last)) { total.last = t.last; }
    for (const [call, n] of Object.entries(t.byCall)) { total.byCall[call] = (total.byCall[call] ?? 0) + n; }
  }
  return total;
}

/** Where one rep of one variant goes. */
interface RepPlace {
  readonly iteration: string;
  readonly rep: number;
  readonly variant: VariantName;
  /** Whether it has its variant's folder (`<iteration>/<variant>/rep-<n>/`): the run has several variants. */
  readonly variantFolder: boolean;
}

/** The variant folder a rep's records name, or undefined for a run of one variant. */
const folderVariant = (place: RepPlace): string | undefined => (place.variantFolder ? place.variant : undefined);

/** The folder a saved case rep lives in. */
function folderOf(judged: { iteration: string; rep: number; variant?: string | undefined }): string {
  return repFolder(judged.iteration, judged.rep, judged.variant);
}

/** The last lines of a stack's log. */
function logTail(stackFolder: string, lines = 40): string[] {
  const file = join(stackFolder, 'stack.log');
  if (!existsSync(file)) { return []; }
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '').slice(-lines).map((line) => line.slice(0, 600));
}

/** Stop a stack that may already be dead, without waiting on it forever. */
async function stopQuietly(handle: Rep): Promise<void> {
  await Promise.race([handle.stop().catch(() => undefined), new Promise((done) => setTimeout(done, 30_000))]);
}

/** A case that never got a transcript (the hub crashed, or the runner failed on it), saved as such. */
function unplayed(place: RepPlace, played: Case, ending: Ending, detail: string[], stack: string | undefined): JudgedCase {
  const now = new Date().toISOString();
  const variant = folderVariant(place);
  return {
    iteration: place.iteration, rep: place.rep, ...(variant === undefined ? {} : { variant }), case: played.id, title: played.title, good: played.good,
    person: { email: `case-${String(played.id).padStart(2, '0')}@parker.family`, password: PERSON_PASSWORD },
    sessions: [], ...(stack === undefined ? {} : { stack }), entries: [], ending,
    stats: { personTurns: 0, turns: 0, toolRuns: 0, modelCalls: 0, hubCost: 0, personCost: 0, wallMs: 0 },
    errors: [ending.reason], stackErrors: detail, checks: [], startedAt: now, endedAt: now,
    judgement: null, judgeCost: 0, judgeError: ending.by === 'harness-crash' ? 'not judged: the harness crashed' : 'not judged: the runner failed on it',
  };
}

/** Write a case rep's json and markdown (with its diagnosis, when it has one). */
function saveCase(folder: string, judged: JudgedCase, diagnosis: CaseDiagnosis | undefined): void {
  const name = `case-${String(judged.case).padStart(2, '0')}`;
  writeFileSync(join(folder, 'cases', `${name}.json`), `${JSON.stringify(judged, null, 2)}\n`);
  writeFileSync(join(folder, 'cases', `${name}.md`), `${caseMarkdown(judged)}${diagnosis === undefined ? '' : `\n\n${diagnosisMarkdown(diagnosis)}`}\n`);
}

/** Play, judge and (unless told not to) diagnose every case of one repetition, starting fresh stacks after a crash. */
async function runRep(settings: ScenariosSettings, router: OpenRouter, place: RepPlace, cases: readonly Case[], concurrency: number, diagnose: boolean): Promise<void> {
  const { iteration, rep } = place;
  const folder = repFolder(iteration, rep, folderVariant(place));
  const people: RepPeople = { admin: { ...ADMIN }, cases: [] };
  const crashes: RepCrash[] = [];
  /** Each stack's shedding (a restart has its own), summed into rep.json. */
  const sheddings: Shedding[] = [];
  const homes: string[] = [];
  let variantRecord: VariantRecord | undefined;
  let meta: RepMeta | undefined;
  const writeMeta = (ended: boolean): void => {
    if (meta === undefined) { return; }
    const saved: RepMeta = {
      ...meta, crashes, shedding: sumShedding(sheddings), homes,
      ...(variantRecord === undefined ? {} : { variant: variantRecord }), ...(ended ? { endedAt: new Date().toISOString() } : {}),
    };
    writeFileSync(join(folder, 'rep.json'), `${JSON.stringify(saved, null, 2)}\n`);
  };
  const keep = (judged: JudgedCase, diagnosis: CaseDiagnosis | undefined): void => {
    saveCase(folder, judged, diagnosis);
    const others = (judged.others ?? []).map((o) => ({ ...o, sessions: judged.sessions.filter((s) => s.as === o.name).map((s) => s.id) }));
    people.cases.push({
      case: judged.case, email: judged.person.email, password: judged.person.password, sessions: judged.sessions.filter((s) => s.as === undefined).map((s) => s.id),
      ...(judged.stack === undefined ? {} : { stack: judged.stack }), ...(others.length === 0 ? {} : { others }),
    });
    writeFileSync(join(folder, 'people.json'), `${JSON.stringify(people, null, 2)}\n`);
  };
  let remaining = [...cases];
  for (let restart = 0; remaining.length > 0; restart++) {
    const stackName = restart === 0 ? undefined : `restart-${restart}`;
    const stackFolder = stackName === undefined ? folder : join(folder, stackName);
    if (restart > 0) {
      // the dead hub's port has to be free before a new one binds it
      for (let waited = 0; waited < 30_000 && await portTaken(settings.HARNESS_SCENARIOS_PORT); waited += 1_000) { await new Promise((done) => setTimeout(done, 1_000)); }
    }
    let handle: Rep;
    try {
      handle = await startRep(settings, iteration, rep, log, { variant: place.variant, variantFolder: place.variantFolder, needs: neededSystems(remaining), ...(stackName === undefined ? {} : { stack: stackName }) });
    } catch (error) {
      const reason = `the stack didn't start: ${error instanceof Error ? error.message : String(error)}`;
      log(`rep ${rep}: ${reason}`);
      mkdirSync(join(folder, 'cases'), { recursive: true });
      meta ??= { rep, systems: [], skipped: [], startedAt: new Date().toISOString(), model: settings.HARNESS_SCENARIOS_MODEL, crashes: [], homes: [] };
      const tail = logTail(stackFolder);
      for (const played of remaining) { keep(unplayed(place, played, { by: 'harness-crash', reason }, tail, stackName), undefined); }
      crashes.push({ at: new Date().toISOString(), error: reason, cases: remaining.map((c) => c.id), logTail: tail });
      writeMeta(true);
      return;
    }
    if (meta === undefined) {
      meta = {
        rep, systems: [...handle.systems], skipped: [...handle.skipped], startedAt: new Date().toISOString(), model: settings.HARNESS_SCENARIOS_MODEL, crashes: [], homes: [],
        ...(handle.index === undefined ? {} : { index: handle.index }),
      };
      mkdirSync(join(folder, 'cases'), { recursive: true });
    }
    variantRecord ??= handle.variant;
    sheddings.push(handle.shedding);
    homes.push(handle.home);
    writeMeta(false);
    const url = handle.stack.url;
    let crash: { at: string; error: string } | undefined;
    const crashed: number[] = [];
    const finished = new Set<number>();
    const stop = (): void => { void handle.stop().finally(() => process.exit(130)); };
    process.once('SIGINT', stop);
    try {
      const context: PlayContext = {
        rep: handle, iteration, repNumber: rep, ...(place.variantFolder ? { variant: place.variant } : {}), router, personModel: settings.HARNESS_SCENARIOS_PERSON_MODEL,
        turnTimeout: settings.HARNESS_SCENARIOS_TURN_TIMEOUT, viewPort: settings.HARNESS_SCENARIOS_VIEW_PORT, log,
      };
      /** Save a case the hub took down, and note the crash. */
      const lost = (played: Case, error: string): void => {
        crash ??= { at: new Date().toISOString(), error };
        crashed.push(played.id);
        finished.add(played.id);
        keep(unplayed(place, played, { by: 'harness-crash', reason: `the hub stopped answering: ${error}`.slice(0, 400) }, logTail(stackFolder), stackName), undefined);
        log(`rep ${rep}: case ${played.id} lost to a harness crash (${error.slice(0, 200)})`);
      };
      await pool(remaining, concurrency, async (played) => {
        if (crash !== undefined) { return; }
        if (!(await hubAnswers(url))) { crash = { at: new Date().toISOString(), error: 'the hub stopped answering between cases' }; return; }
        log(`rep ${rep}: case ${played.id} (${played.title}) starts`);
        let record;
        try {
          record = await playCase(context, played);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (!(await hubAnswers(url))) { lost(played, text); return; }
          finished.add(played.id);
          // still shed when the patience ran out: the hub's load shedding failed the case (a finding: rep.json's shedding)
          const busy = shedOf(error) !== undefined;
          keep(unplayed(place, played, { by: 'error', reason: `${busy ? 'the hub stayed busy (HTTP 503) past the runner\'s patience' : 'the runner failed'}: ${text}`.slice(0, 400) }, [], stackName), undefined);
          log(`rep ${rep}: case ${played.id} failed in the runner${busy ? ' (the hub stayed busy)' : ''}: ${text.slice(0, 200)}`);
          return;
        }
        // a case that ended badly because the hub died is the crash's, not the agent's
        if ((record.ending.by === 'error' || record.ending.by === 'timeout') && !(await hubAnswers(url))) { lost(played, record.ending.reason); return; }
        const placed = stackName === undefined ? record : { ...record, stack: stackName };
        const result = await judgeCase(router, settings.HARNESS_SCENARIOS_JUDGE_MODEL, placed);
        const diagnosis = diagnose ? await diagnoseCase(router, settings.HARNESS_SCENARIOS_DIAGNOSE_MODEL, folder, result) : undefined;
        finished.add(played.id);
        keep(result, diagnosis);
        const j = result.judgement;
        log(`rep ${rep}: case ${played.id} ${j === null ? 'not judged' : `${j.verdict} ${j.score}/10`} · ended ${result.ending.by} · ${Math.round(result.stats.wallMs / 1000)}s · ${usd(result.stats.hubCost + result.stats.personCost + result.judgeCost + (diagnosis?.cost ?? 0))}${diagnosis === undefined ? '' : diagnosis.diagnosis === null ? ' · diagnosis failed' : ` · ${diagnosis.diagnosis.fixes.length} fixes`}${(result.stats.shed ?? 0) === 0 ? '' : ` · ${result.stats.shed} call(s) shed by a busy hub`}`);
      });
    } finally {
      process.off('SIGINT', stop);
      await stopQuietly(handle);
    }
    remaining = remaining.filter((c) => !finished.has(c.id));
    if (crash === undefined) { break; }
    const again = remaining.length > 0 && restart < MAX_RESTARTS;
    if (!again) {
      const tail = logTail(stackFolder);
      for (const played of remaining) { crashed.push(played.id); keep(unplayed(place, played, { by: 'harness-crash', reason: `not played: the hub crashed (${crash.error})`.slice(0, 400) }, tail, stackName), undefined); }
      remaining = [];
    }
    crashes.push({ at: crash.at, error: crash.error, cases: crashed, logTail: logTail(stackFolder), ...(again ? { restartedIn: `restart-${restart + 1}` } : {}) });
    log(`rep ${rep}: the hub crashed (${crash.error.slice(0, 200)}); ${again ? `${remaining.length} case(s) go on on a fresh stack` : 'the rest of the rep is marked harness-crash'}`);
    writeMeta(false);
  }
  writeMeta(true);
}

/** Serve a saved repetition until Ctrl+C. */
async function view(settings: ScenariosSettings, iteration: string, rep: number, variant: VariantName | undefined): Promise<void> {
  if (await portTaken(settings.HARNESS_SCENARIOS_VIEW_PORT)) { throw new Error(`port ${settings.HARNESS_SCENARIOS_VIEW_PORT} is taken`); }
  // a run of several variants keeps its reps in variant folders: one has to be named
  const variants = savedVariants(iteration);
  if (variant === undefined && variants.length > 0 && !existsSync(repFolder(iteration, rep))) { throw new Error(`${iteration} ran variants ${variants.join(', ')}: add --variant <name>`); }
  const stack = await viewRep(settings, iteration, rep, variant);
  const people = RepPeople.parse(JSON.parse(readFileSync(join(repFolder(iteration, rep, variant), 'people.json'), 'utf8')));
  const base = viewBase(settings.HARNESS_SCENARIOS_VIEW_PORT);
  const tailscale = tailscaleBase(settings.HARNESS_SCENARIOS_VIEW_PORT);
  console.log(`\n${iteration}${variant === undefined ? '' : ` (${VARIANT_LABELS[variant]})`} rep ${rep} is open at ${base}${tailscale === undefined ? '' : ` (Tailscale ${tailscale})`}; systems are offline.\n`);
  for (const person of [...people.cases].sort((a, b) => a.case - b.case)) {
    const title = CASES.find((c) => c.id === person.case)?.title ?? '';
    if (person.stack !== undefined) { console.log(`case ${person.case}. ${title}: ran on the stack in ${person.stack} after a crash, not served here`); continue; }
    console.log(`case ${person.case}. ${title}: sign in as ${person.email} / ${person.password}\n  ${person.sessions.map((s) => `${base}/chat/${s}`).join('\n  ')}`);
    for (const other of person.others ?? []) { console.log(`  ${other.name}: sign in as ${other.email} / ${other.password}\n    ${other.sessions.map((s) => `${base}/chat/${s}`).join('\n    ')}`); }
  }
  console.log(`\nadmin: ${people.admin.email} / ${people.admin.password}. Ctrl+C to stop.`);
  const shutdown = (): void => { void stack.stop().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => undefined);
}

/** Diagnose saved case reps of an iteration (`--diagnose`), then write diagnosis.md and the report again. */
async function diagnoseSaved(settings: ScenariosSettings, router: OpenRouter, iteration: string, options: Flags): Promise<void> {
  const { cases } = loadIteration(iteration);
  const targets = cases.filter((c) => (options.cases === undefined || options.cases.includes(c.case)) && (options.rep === undefined || c.rep === options.rep) && (options.variant === undefined || c.variant === options.variant));
  if (targets.length === 0) { throw new Error(`no saved case reps of ${iteration} match --cases / --rep / --variant`); }
  const model = settings.HARNESS_SCENARIOS_DIAGNOSE_MODEL;
  let cost = 0;
  log(`diagnosing ${targets.length} case rep(s) of ${iteration} with ${model}`);
  await pool(targets, options.concurrency, async (judged) => {
    const folder = folderOf(judged);
    const kept = options.force ? undefined : loadDiagnosis(folder, judged.case);
    const diagnosis = kept?.diagnosis === null || kept === undefined ? await diagnoseCase(router, model, folder, judged) : kept;
    if (diagnosis !== kept) { cost += diagnosis.cost; }
    saveCase(folder, judged, diagnosis);
    log(`case ${judged.case}${judged.variant === undefined ? '' : ` ${judged.variant}`} rep ${judged.rep}: ${diagnosis === kept ? 'kept' : `diagnosed (${diagnosis.modelSteps} steps, ${Math.round(diagnosis.promptChars / 1000)}k chars, ${usd(diagnosis.cost)})`} ${diagnosis.diagnosis === null ? `failed: ${diagnosis.error ?? '—'}` : `${diagnosis.diagnosis.fixes.length} fixes`}`);
  });
  const { path, result } = await aggregate(iterationFolder(iteration), iteration, router, model, options.force);
  log(`diagnosis: ${path} (${result.fixes.length} fixes from ${result.diagnosed} case reps; this run ${usd(cost)}, merging ${usd(result.cost.merge)})`);
  const report = writeReport(iteration);
  log(`report: ${report.path}`);
  if (options.publish === true) { const { file, links } = publish(iteration); log(`hitl review: ${file}\n  ${links.join('\n  ')}`); }
}

async function main(): Promise<void> {
  const options = flags();
  const settings = loadSettings();
  // a stray rejection (a watch on a dead hub) is logged, never the end of the run
  process.on('unhandledRejection', (error: unknown) => { log(`unhandled: ${error instanceof Error ? error.message : String(error)}`); });
  if (options.view !== undefined) {
    await view(settings, options.view, options.rep ?? 1, options.variant);
    return;
  }
  if (options['report-only']) {
    if (options.iteration === undefined) { throw new Error('--report-only needs --iteration <name>'); }
    const folder = iterationFolder(options.iteration);
    if (loadDiagnoses(folder).length > 0) {
      for (const judged of loadIteration(options.iteration).cases) { const d = loadDiagnosis(folderOf(judged), judged.case); if (d !== undefined) { saveCase(folderOf(judged), judged, d); } }
      const router = settings.OPENROUTER_API_KEY === undefined ? undefined : new OpenRouter(settings.OPENROUTER_API_KEY);
      const { path } = await aggregate(folder, options.iteration, router, settings.HARNESS_SCENARIOS_DIAGNOSE_MODEL, options.force);
      log(`diagnosis: ${path}`);
    }
    const { path, report } = writeReport(options.iteration);
    log(`report: ${path} (${usd(report.cost.total)})`);
    if (options.publish === true) { const { file, links } = publish(options.iteration); log(`hitl review: ${file}\n  ${links.join('\n  ')}`); }
    return;
  }
  if (settings.OPENROUTER_API_KEY === undefined) { throw new Error('OPENROUTER_API_KEY is not set (nor in the Windows user environment)'); }
  const router = new OpenRouter(settings.OPENROUTER_API_KEY);
  if (options.diagnose) {
    if (options.iteration === undefined) { throw new Error('--diagnose needs --iteration <name>'); }
    await diagnoseSaved(settings, router, options.iteration, options);
    return;
  }
  if (await portTaken(settings.HARNESS_SCENARIOS_PORT)) { throw new Error(`port ${settings.HARNESS_SCENARIOS_PORT} is taken; stop what runs there or set HARNESS_SCENARIOS_PORT`); }
  const variants = parseVariants(options.variants);
  // a variant the hub can't set up, or a decision model that doesn't answer, stops the run before anything boots
  checkVariantSupport(variants);
  if (variants.some((name) => name !== 'off')) {
    const proof = await proveDecisionModel(settings.OPENROUTER_API_KEY, settings.HARNESS_SCENARIOS_DECISION_MODEL);
    log(`decision model ${proof.model} answers (${proof.ms}ms, ${proof.cost === undefined ? 'cost not reported' : usd(proof.cost)}): ${JSON.stringify(proof.answers)}`);
  }
  if (options.fixtures || !fixturesReady(FIXTURES_DIR)) {
    log(`making fixtures in ${FIXTURES_DIR}`);
    await makeFixtures(FIXTURES_DIR, options.fixtures);
  }
  const cases = pickCases(options.cases);
  const iteration = options.iteration ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  mkdirSync(iterationFolder(iteration), { recursive: true });
  const diagnose = !options['no-diagnose'];
  const variantFolder = variants.length > 1;
  log(`iteration ${iteration}: cases ${cases.map((c) => c.id).join(',')} × ${options.reps} rep(s)${variantFolder ? ` × variants ${variants.join(', ')}` : variants[0] === 'off' ? '' : ` (variant ${variants[0]})`}, ${options.concurrency} at a time, model ${settings.HARNESS_SCENARIOS_MODEL}${diagnose ? '' : ', no diagnosis'}`);
  // reps interleave the variants (rep 1 off, rep 1 on, rep 2 off, …) so both see the same hours of the providers
  for (let rep = 1; rep <= options.reps; rep++) {
    for (const variant of variants) {
      if (variantFolder) { log(`rep ${rep}, ${VARIANT_LABELS[variant]}`); }
      await runRep(settings, router, { iteration, rep, variant, variantFolder }, cases, options.concurrency, diagnose);
    }
  }
  if (diagnose) {
    const { path, result } = await aggregate(iterationFolder(iteration), iteration, router, settings.HARNESS_SCENARIOS_DIAGNOSE_MODEL);
    log(`diagnosis: ${path} (${result.fixes.length} fixes; ${usd(result.cost.cases + result.cost.merge)})`);
  }
  const { path, report } = writeReport(iteration);
  log(`report: ${path}`);
  log(`cost: ${usd(report.cost.total)} (hub ${usd(report.cost.hub)}, person ${usd(report.cost.person)}, judge ${usd(report.cost.judge)})`);
  const full = wholeSet(cases);
  if (!options['no-publish'] && (options.publish === true || full)) {
    const { file, links } = publish(iteration);
    log(`hitl review: ${file}\n  ${links.join('\n  ')}`);
  }
}

/**
 * The run is over: every rep's stack and clients are stopped, so exit, saying what (if anything) was still open.
 * Iteration 1 kept running after its report, a client renewing against a dead hub forever; never again.
 */
function finish(code: number): never {
  // sockets and child processes are what kept iteration 1 alive; stdio writes and timers end with the process
  const open = process.getActiveResourcesInfo().filter((kind) => /TCP|Process|UDP|Socket/.test(kind));
  if (open.length > 0) { log(`exiting with ${open.length} handle(s) still open: ${[...new Set(open)].join(', ')}`); }
  process.exit(code);
}

main().then(() => finish(0), (error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  finish(1);
});
