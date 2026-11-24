/**
 * `npx tsx scripts/schedule-live.ts`: a live run of each flow the schedule system describes (docs/plans/schedule-system.md,
 * slice 9), once, with the scenarios' chat model (GPT-6 Luna). Boots a fresh stack (`.harness-test/schedule-live/`,
 * port 4360) with hub, fs (a fake home outside any git repository), input, code, schedule and the embedder when it
 * answers; goes live with every system as an admin does, waits for the index, then plays each flow in a chat of its own
 * as the admin, saying yes to every approval (Approve alone, as a person who doesn't tick "let its runs go ahead"):
 *
 * 1. a fn every weekday morning; 2. a reminder next Tuesday at 3; 3. changing the first to Thursdays; 4. skipping its
 * next run; 5. pausing it; 6. listing them; 7. a reminder a couple of minutes out, then waiting (on the real clock: the
 * test stack has no way to move the timer's clock) for its firing to run and its notification to reach the inbox with a
 * link to its run page.
 *
 * For each flow it records what the model answered, every schedule fn it called (args and outcome), the approvals it
 * waited on and what the turn cost, into `report.md` and `report.json`. `--only=<flow,…>` plays some of them (a rerun);
 * `--seed` then adds a few more schedules by hand (`invoke`, no model), so the calendar has more to draw; `--fire-by-hand`
 * adds a reminder two minutes out by hand and waits for its firing (the timer's side, with no model); `--keep`
 * leaves the stack up afterwards (for the UI shots) until `.harness-test/schedule-live/stop` appears; `--reuse` starts
 * it again on the data folder a run left (nothing wiped; `--only=none` then plays nothing).
 */
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSettled, QualifiedName, type Json, type Notification, type TreeNode } from '@harness/core';
import { goLiveAll } from '../e2e/review.ts';
import { ROOT, startStack, type ComponentName } from './stack.ts';
import { loadSettings } from './scenarios/env.ts';
import { ADMIN, embedderAnswers, homeFolder, portTaken, waitForIndex } from './scenarios/rep.ts';
import { Approver, ask, clientInfo, SessionWatch, textOf } from './session.ts';

const PORT = 4360;
const DATA = join(ROOT, '.harness-test', 'schedule-live');
const STOP = join(DATA, 'stop');
const TURN_TIMEOUT = 300_000;
/** How long the firing flow waits for its run and notice past the planned time. */
const FIRING_WAIT = 4 * 60_000;
/** The person's zone (the scripts' browser facts say New York). */
const ZONE = 'America/New_York';

const log = (line: string): void => { process.stdout.write(`${line}\n`); };

/** A wall-clock time a few minutes from now in the person's zone, as `h:mm am`, and the instant it is. */
function minutesAhead(minutes: number): { words: string; at: number } {
  const at = Math.ceil((Date.now() + minutes * 60_000) / 60_000) * 60_000;
  const words = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' }).format(at).toLowerCase();
  return { words, at };
}

/** One flow: what the person says. */
interface Flow { readonly id: string; readonly text: () => string }

const FLOWS: readonly Flow[] = [
  { id: 'weekday', text: () => 'Every weekday morning at 7:30, list the files in my home folder for me. Please set that up as a schedule.' },
  { id: 'remind', text: () => 'Remind me next Tuesday at 3 pm to call the dentist.' },
  { id: 'thursdays', text: () => 'Change my weekday-morning schedule that lists my home folder so it runs on Thursdays only.' },
  { id: 'skip', text: () => 'Skip the next run of the schedule that lists my home folder.' },
  { id: 'pause', text: () => 'Pause the schedule that lists my home folder.' },
  { id: 'list', text: () => 'What schedules do I have?' },
  { id: 'fire', text: () => `Remind me at ${firing.words} today to stand up and stretch.` },
];
/** The firing flow's time, fixed once (two minutes out when the run starts, moved on before that flow plays). */
let firing = minutesAhead(2);

/** What one flow did. */
interface FlowRecord {
  id: string;
  said: string;
  answer: string;
  status: string;
  calls: Array<{ fn: string; status: string; args?: unknown; result?: unknown; error?: string }>;
  approvals: Array<{ fn: string; title?: string; offered?: string }>;
  cost: number;
  seconds: number;
  notes: string[];
}

/** Every node of a tree, depth first. */
function nodes(node: TreeNode): TreeNode[] {
  return [node, ...node.children.flatMap(nodes)];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const only = argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',');
  const keep = argv.includes('--keep');
  const seeding = argv.includes('--seed');
  const reuse = argv.includes('--reuse');
  const byHand = argv.includes('--fire-by-hand');
  const settings = loadSettings();
  if (settings.OPENROUTER_API_KEY === undefined) throw new Error('no OPENROUTER_API_KEY (process or Windows user environment)');
  if (await portTaken(PORT)) throw new Error(`something already listens on ${PORT}`);
  if (!reuse) rmSync(DATA, { recursive: true, force: true });
  rmSync(STOP, { force: true });
  mkdirSync(DATA, { recursive: true });
  const home = homeFolder({ HARNESS_SCENARIOS_HOME_ROOT: join(tmpdir(), 'harness-schedule-live') }, 'schedule-live', 1, undefined, undefined);
  const embedder = await embedderAnswers(settings.HARNESS_SCENARIOS_EMBEDDER);
  const systems: ComponentName[] = ['web', 'hub', 'fs', 'input', 'code', 'schedule', ...(embedder ? ['embedder' as const] : [])];
  log(`starting ${systems.join(', ')} on ${PORT}; home ${home}`);
  const stackLog = join(DATA, 'stack.log');
  const stack = await startStack({
    port: PORT, data: DATA, admin: ADMIN, build: true, watch: false, timeout: settings.HARNESS_SCENARIOS_START_TIMEOUT, only: new Set(systems),
    systems: {
      fs: { roots: [{ name: 'home', path: home, writable: true, index: 'all' }], self: join(ROOT, 'systems', 'fs') },
      embedder: { url: settings.HARNESS_SCENARIOS_EMBEDDER },
      databases: {},
    },
    hubEnv: { HARNESS_LOG_FILES: 'false', HARNESS_DEFAULT_MODEL: settings.HARNESS_SCENARIOS_MODEL },
    output: (component, line) => { appendFileSync(stackLog, `${component.padEnd(9)} ${line}\n`); },
  });
  const records: FlowRecord[] = [];
  try {
    const { admin } = stack;
    log(`live: ${(await goLiveAll(admin)).join(', ')}`);
    if (embedder) await waitForIndex(admin, settings, log);
    for (const flow of FLOWS) {
      if (only !== undefined && !only.includes(flow.id)) continue;
      if (flow.id === 'fire') firing = minutesAhead(2);
      const said = flow.text();
      log(`\n── ${flow.id}: ${said}`);
      const started = Date.now();
      const session = await admin.hub.call('createSession', { title: `Schedules: ${flow.id}` });
      const watch = new SessionWatch(admin, session.id);
      const approver = new Approver(admin, watch);
      const record: FlowRecord = { id: flow.id, said, answer: '', status: '', calls: [], approvals: [], cost: 0, seconds: 0, notes: [] };
      try {
        const { result, approvals } = await approver.during(ask(admin, watch, said, TURN_TIMEOUT));
        record.answer = textOf(result.answer);
        record.status = result.answer.status;
        record.approvals = approvals.map((approval) => ({ fn: approval.fn, ...(approval.preview === undefined ? {} : { title: approval.preview.title }), ...(approval.ask?.label === undefined ? {} : { offered: approval.ask.label }) }));
        // a moment for the turn's runs to settle
        await new Promise((done) => setTimeout(done, 1_500));
        const tree = await admin.hub.call('tree', { turn: result.turn });
        for (const node of nodes(tree)) {
          record.cost += node.llmCalls.reduce((sum, call) => sum + call.cost, 0);
          if (!node.run.fn.startsWith('schedule/') && node.run.fn !== 'hub/fns_save' && node.run.fn !== 'hub/fns_remove') continue;
          const run = await admin.hub.call('run', { run: node.run.id });
          const outcome = run.outcome;
          record.calls.push({
            fn: run.fn, status: run.status, args: run.args,
            ...(outcome?.status === 'done' ? { result: outcome.result } : {}),
            ...(outcome !== undefined && 'error' in outcome && outcome.error !== undefined ? { error: outcome.error.message } : {}),
            ...(outcome?.status === 'invalid-input' ? { error: JSON.stringify(outcome.invalid.problems) } : {}),
          });
        }
      } catch (error) {
        record.notes.push(`broke: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        watch.stop();
      }
      if (flow.id === 'fire') await waitForFiring(admin, record);
      record.seconds = Math.round((Date.now() - started) / 1000);
      records.push(record);
      log(`   ${record.status} in ${String(record.seconds)}s, $${record.cost.toFixed(4)}; calls: ${record.calls.map((c) => `${c.fn} ${c.status}`).join(', ') || 'none'}`);
      log(`   answer: ${record.answer.replace(/\s+/g, ' ').slice(0, 400)}`);
      for (const note of record.notes) log(`   note: ${note}`);
    }
    if (seeding) await seed(stack.admin);
    if (byHand) await fireByHand(stack.admin, records);
  } finally {
    const total = records.reduce((sum, r) => sum + r.cost, 0);
    writeFileSync(join(DATA, 'report.json'), JSON.stringify({ model: settings.HARNESS_SCENARIOS_MODEL, total, records }, null, 2));
    writeFileSync(join(DATA, 'report.md'), reportOf(settings.HARNESS_SCENARIOS_MODEL, records, total));
    log(`\ntotal $${total.toFixed(4)}; report in ${join(DATA, 'report.md')}`);
    if (keep) {
      log(`stack up at ${stack.url} (admin ${ADMIN.email}); touch ${STOP} to stop it`);
      while (!existsSync(STOP)) await new Promise((done) => setTimeout(done, 2_000));
    }
    await stack.stop();
  }
}

/** More schedules, added by hand as the person (no model): what the calendar and the admin list draw beside the flows'. */
const SEEDS: ReadonlyArray<{ fn: string; args: Json }> = [
  { fn: 'schedule/add', args: { fn: 'schedule/remind', when: { dayOfWeek: [0, 1, 2, 3, 4, 5, 6], times: ['08:15'] }, args: { text: 'Water the plants.' }, name: 'Water the plants' } },
  { fn: 'schedule/add', args: { fn: 'fs/list', when: { dayOfWeek: [1, 3, 5], times: ['12:00', '18:00'] }, args: { path: '.' }, name: 'Midday folder check', notify: 'failed' } },
  // the person's own choice on its page: its runs go ahead without asking
  { fn: 'schedule/allow_runs', args: { schedule: 'schedule/midday_folder_check', allow: true } },
  { fn: 'schedule/add', args: { fn: 'schedule/remind', when: { dayOfMonth: [1], times: ['09:00'] }, args: { text: 'Pay the rent.' }, name: 'Rent reminder', zone: 'Europe/London' } },
];

/** Add the seed schedules by hand (approving each card with Approve alone), each settled before the next. */
async function seed(admin: Awaited<ReturnType<typeof startStack>>['admin']): Promise<void> {
  const session = await admin.hub.call('createSession', { title: 'Schedules: seeded by hand' });
  const watch = new SessionWatch(admin, session.id);
  const approver = new Approver(admin, watch);
  try {
    for (const one of SEEDS) {
      const { run } = await admin.hub.call('invoke', { session: session.id, fn: QualifiedName.parse(one.fn), args: one.args, client: clientInfo() });
      const settled = await approver.during((async () => {
        for (let i = 0; i < 120; i++) {
          const current = await admin.hub.call('run', { run });
          if (isSettled(current.status)) return current.status;
          await new Promise((done) => setTimeout(done, 1_000));
        }
        return 'timed out';
      })());
      log(`seeded ${JSON.stringify(one.args).slice(0, 80)}: ${settled.result}`);
    }
  } finally {
    watch.stop();
  }
}

/** A time a few minutes out as the reminder's `when`: its day and time in the person's zone. */
function whenOf(at: number): { on: string; times: string[] } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((part) => [part.type, part.value]));
  return { on: `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''}`, times: [`${parts['hour'] ?? ''}:${parts['minute'] ?? ''}`] };
}

/** A reminder two minutes out, added by hand (no model), then its firing waited for: its notice, its run, its record. */
async function fireByHand(admin: Awaited<ReturnType<typeof startStack>>['admin'], records: FlowRecord[]): Promise<void> {
  firing = minutesAhead(2);
  const record: FlowRecord = { id: 'fire-by-hand', said: `(by hand) schedule/add of schedule/remind at ${firing.words}`, answer: '', status: '', calls: [], approvals: [], cost: 0, seconds: 0, notes: [] };
  const started = Date.now();
  const session = await admin.hub.call('createSession', { title: 'Schedules: a firing by hand' });
  const watch = new SessionWatch(admin, session.id);
  const approver = new Approver(admin, watch);
  try {
    const { run } = await admin.hub.call('invoke', { session: session.id, fn: QualifiedName.parse('schedule/add'), args: { fn: 'schedule/remind', when: whenOf(firing.at), args: { text: 'Look away from the screen for a minute.' }, name: 'Screen break' }, client: clientInfo() });
    const { result } = await approver.during((async () => {
      for (let i = 0; i < 120; i++) {
        const current = await admin.hub.call('run', { run });
        if (isSettled(current.status)) return current;
        await new Promise((done) => setTimeout(done, 1_000));
      }
      throw new Error('schedule/add did not settle');
    })());
    record.status = result.status;
    record.calls.push({ fn: result.fn, status: result.status, args: result.args, ...(result.outcome?.status === 'done' ? { result: result.outcome.result } : {}) });
  } finally {
    watch.stop();
  }
  await waitForFiring(admin, record);
  const firings = await admin.hub.call('records', { type: QualifiedName.parse('schedule/Firing'), query: { sort: [{ field: 'at', dir: 'desc' }], limit: 5 } });
  record.notes.push(`firing records: ${firings.items.map((item) => JSON.stringify(item.value)).join(' | ') || 'none'}`);
  record.seconds = Math.round((Date.now() - started) / 1000);
  records.push(record);
  for (const note of record.notes) log(`   note: ${note}`);
}

/** Wait for the reminder's firing: its notification in the inbox, linking to its run, and that run done. */
async function waitForFiring(admin: Awaited<ReturnType<typeof startStack>>['admin'], record: FlowRecord): Promise<void> {
  const until = firing.at + FIRING_WAIT;
  record.notes.push(`planned for ${new Date(firing.at).toISOString()} (${firing.words} New York time)`);
  let seen: Notification[] = [];
  while (Date.now() < until) {
    const page = await admin.hub.call('notifications', { limit: 20 });
    seen = page.items.filter((item) => item.reason === 'system-message');
    if (seen.length > 0) break;
    await new Promise((done) => setTimeout(done, 5_000));
  }
  if (seen.length === 0) { record.notes.push('no notification reached the inbox in time'); return; }
  for (const notice of seen) {
    record.notes.push(`notification at ${new Date(notice.createdAt).toISOString()}: "${notice.title}" / "${notice.body}" tone ${notice.tone ?? 'info'}, link ${JSON.stringify(notice.link)}${notice.also === undefined ? '' : `, also ${notice.also.label} ${JSON.stringify(notice.also.link)}`}, key ${notice.key ?? '-'}`);
    if ('run' in notice.link) {
      const run = await admin.hub.call('run', { run: notice.link.run });
      record.notes.push(`its run ${run.id} (${run.fn}) is ${run.status}; run page /run/${run.id}`);
    }
  }
}

/** The report, one section per flow. */
function reportOf(model: string, records: readonly FlowRecord[], total: number): string {
  const lines = [`# Schedule system, live flows (${new Date().toISOString()})`, '', `Model: ${model}. Total cost: $${total.toFixed(4)}.`, ''];
  for (const r of records) {
    lines.push(`## ${r.id}`, '', `> ${r.said}`, '', `Turn: ${r.status}, ${String(r.seconds)} s, $${r.cost.toFixed(4)}.`, '');
    if (r.approvals.length > 0) lines.push(`Approvals: ${r.approvals.map((a) => `${a.fn}${a.title === undefined ? '' : ` ("${a.title}")`}${a.offered === undefined ? '' : `, offering "${a.offered}"`}`).join('; ')}`, '');
    for (const call of r.calls) lines.push(`- \`${call.fn}\` ${call.status}: args \`${JSON.stringify(call.args)}\`${call.error === undefined ? '' : `, error: ${call.error}`}${call.result === undefined ? '' : `\n  result \`${JSON.stringify(call.result).slice(0, 600)}\``}`);
    lines.push('', 'Answer:', '', r.answer.split('\n').map((line) => `> ${line}`).join('\n'), '');
    for (const note of r.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return lines.join('\n');
}

await main();
