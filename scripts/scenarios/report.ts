/**
 * The iteration's report, rebuilt from what each repetition saved (`rep-<n>/cases/*.json`): per case its
 * repetitions' verdicts and scores side by side, how consistent they were and what they cost; tables of the causes
 * and layers the judge named; the worst cases first. Written as `report.md` and `report.json` in the iteration's
 * folder; `npm run scenarios -- --report-only --iteration <name>` writes it again without running anything.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CASES } from './cases.ts';
import { JudgedCase, Verdict, type Cause, type Layer } from './records.ts';
import { SCENARIOS_DIR } from './rep.ts';
import { usd } from './transcript.ts';

/** What a repetition says about itself. */
export const RepMeta = z.object({
  rep: z.number().int(),
  systems: z.array(z.string()),
  skipped: z.array(z.string()),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  model: z.string(),
  /** How the wait for the hub's index went before the cases played (absent: no embedder ran). */
  index: z.object({
    caughtUp: z.boolean(), waitedMs: z.number(), items: z.number(), pending: z.number(), meaning: z.boolean(), lastError: z.string().optional(),
  }).optional(),
});
export type RepMeta = z.infer<typeof RepMeta>;

/** One case across its repetitions. */
export const CaseSummary = z.object({
  case: z.number().int(),
  title: z.string(),
  good: z.string(),
  reps: z.array(z.object({
    rep: z.number().int(), verdict: Verdict.nullable(), score: z.number().nullable(), summary: z.string(), cause: z.string().nullable(), layer: z.string().nullable(), fix: z.string(),
    cost: z.number(), wallMs: z.number(), ended: z.string(), checksFailed: z.array(z.string()), sessions: z.array(z.string()), file: z.string(),
  })),
  meanScore: z.number().nullable(),
  /** Every judged repetition gave the same verdict. */
  consistent: z.boolean(),
  cost: z.number(),
});
export type CaseSummary = z.infer<typeof CaseSummary>;

export const Report = z.object({
  iteration: z.string(),
  writtenAt: z.string(),
  reps: z.array(RepMeta),
  cases: z.array(CaseSummary),
  causes: z.record(z.string(), z.number()),
  layers: z.record(z.string(), z.number()),
  cost: z.object({ hub: z.number(), person: z.number(), judge: z.number(), total: z.number() }),
});
export type Report = z.infer<typeof Report>;

/** The folder of an iteration. */
export function iterationFolder(iteration: string): string {
  return join(SCENARIOS_DIR, iteration);
}

/** Every judged case saved for an iteration, by repetition. */
export function loadIteration(iteration: string): { reps: RepMeta[]; cases: JudgedCase[] } {
  const folder = iterationFolder(iteration);
  if (!existsSync(folder)) { throw new Error(`no iteration ${iteration} at ${folder}`); }
  const reps: RepMeta[] = [];
  const cases: JudgedCase[] = [];
  for (const name of readdirSync(folder).filter((n) => /^rep-\d+$/.test(n)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))) {
    const meta = join(folder, name, 'rep.json');
    if (existsSync(meta)) { reps.push(RepMeta.parse(JSON.parse(readFileSync(meta, 'utf8')))); }
    const dir = join(folder, name, 'cases');
    if (!existsSync(dir)) { continue; }
    for (const file of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      cases.push(JudgedCase.parse(JSON.parse(readFileSync(join(dir, file), 'utf8'))));
    }
  }
  return { reps, cases };
}

/** Where a case's readable file is, from the iteration folder. */
export function caseFile(rep: number, caseId: number): string {
  return `rep-${rep}/cases/case-${String(caseId).padStart(2, '0')}.md`;
}

const costOf = (judged: JudgedCase): number => judged.stats.hubCost + judged.stats.personCost + judged.judgeCost;

/** Summarize an iteration. */
export function buildReport(iteration: string): Report {
  const { reps, cases } = loadIteration(iteration);
  const byCase = new Map<number, JudgedCase[]>();
  for (const judged of cases) { byCase.set(judged.case, [...(byCase.get(judged.case) ?? []), judged]); }
  const causes: Partial<Record<Cause, number>> = {};
  const layers: Partial<Record<Layer, number>> = {};
  const summaries: CaseSummary[] = [...byCase.entries()].sort(([a], [b]) => a - b).map(([id, runs]) => {
    const sorted = [...runs].sort((a, b) => a.rep - b.rep);
    for (const judged of sorted) {
      const j = judged.judgement;
      if (j === null || j.verdict === 'pass') { continue; }
      if (j.cause !== null) { causes[j.cause] = (causes[j.cause] ?? 0) + 1; }
      if (j.layer !== null) { layers[j.layer] = (layers[j.layer] ?? 0) + 1; }
    }
    const scores = sorted.flatMap((judged) => (judged.judgement === null ? [] : [judged.judgement.score]));
    const verdicts = new Set(sorted.flatMap((judged) => (judged.judgement === null ? [] : [judged.judgement.verdict])));
    return {
      case: id, title: sorted[0]?.title ?? CASES.find((c) => c.id === id)?.title ?? '', good: sorted[0]?.good ?? '',
      reps: sorted.map((judged) => ({
        rep: judged.rep, verdict: judged.judgement?.verdict ?? null, score: judged.judgement?.score ?? null, summary: judged.judgement?.summary ?? judged.judgeError ?? '',
        cause: judged.judgement?.cause ?? null, layer: judged.judgement?.layer ?? null, fix: judged.judgement?.fix ?? '',
        cost: costOf(judged), wallMs: judged.stats.wallMs, ended: judged.ending.by, checksFailed: judged.checks.filter((c) => !c.ok).map((c) => c.name),
        sessions: judged.sessions.map((s) => s.url), file: caseFile(judged.rep, id),
      })),
      meanScore: scores.length === 0 ? null : scores.reduce((sum, s) => sum + s, 0) / scores.length,
      consistent: verdicts.size <= 1,
      cost: sorted.reduce((sum, judged) => sum + costOf(judged), 0),
    };
  });
  const sum = (pick: (judged: JudgedCase) => number): number => cases.reduce((total, judged) => total + pick(judged), 0);
  const cost = { hub: sum((j) => j.stats.hubCost), person: sum((j) => j.stats.personCost), judge: sum((j) => j.judgeCost), total: 0 };
  cost.total = cost.hub + cost.person + cost.judge;
  return { iteration, writtenAt: new Date().toISOString(), reps, cases: summaries, causes, layers, cost };
}

const VERDICT_MARK = { pass: 'pass', weak: 'WEAK', fail: 'FAIL' } as const;

/** The report as markdown. */
export function reportMarkdown(report: Report): string {
  const worst = [...report.cases].sort((a, b) => (a.meanScore ?? -1) - (b.meanScore ?? -1));
  const count = (verdict: Verdict): number => report.cases.flatMap((c) => c.reps).filter((r) => r.verdict === verdict).length;
  const table = (counts: Record<string, number>): string => {
    const rows = Object.entries(counts).sort(([, a], [, b]) => b - a);
    return rows.length === 0 ? '_none_' : ['| | count |', '|---|---|', ...rows.map(([name, n]) => `| ${name} | ${n} |`)].join('\n');
  };
  const indexNote = (r: RepMeta): string => (r.index === undefined ? '' : r.index.caughtUp
    ? `; index embedded (${r.index.items} items) in ${Math.round(r.index.waitedMs / 1000)}s`
    : `; **index NOT caught up** after ${Math.round(r.index.waitedMs / 1000)}s: ${r.index.pending} of ${r.index.items} waiting${r.index.meaning ? '' : ', no embedder set up'}${r.index.lastError === undefined ? '' : ` (last failure: ${r.index.lastError})`}`);
  const repsLine = report.reps.map((r) => `rep ${r.rep}: ${r.systems.join(', ')}${r.skipped.length === 0 ? '' : ` (not run: ${r.skipped.join('; ')})`}${indexNote(r)}`).join('\n- ');
  const behind = report.reps.filter((r) => r.index?.caughtUp === false).map((r) => r.rep);
  return [
    `# Scenarios: ${report.iteration}`,
    `Written ${report.writtenAt}. ${report.cases.length} cases × ${report.reps.length} rep(s). Verdicts: ${count('pass')} pass, ${count('weak')} weak, ${count('fail')} fail. Cost: ${usd(report.cost.total)} (hub ${usd(report.cost.hub)}, person ${usd(report.cost.person)}, judge ${usd(report.cost.judge)}). Model: ${report.reps[0]?.model ?? '—'}.`,
    ...(behind.length === 0 ? [] : [`**The index never caught up in rep(s) ${behind.join(', ')}: suggestions and search by meaning were off or partial there, so read those verdicts with that in mind.**`]),
    `Stacks:\n- ${repsLine || '—'}`,
    'Open a rep\'s chats: `npm run scenarios -- --view ' + report.iteration + ' --rep <n>`, then the session links below (sign in as the case\'s person, password `scenario-person-password`).',
    '## Causes (weak and fail reps)',
    table(report.causes),
    '## Layers to fix',
    table(report.layers),
    '## Cases, worst first',
    ['| case | reps | mean | same? | cost |', '|---|---|---|---|---|', ...worst.map((c) => `| ${c.case}. ${c.title} | ${c.reps.map((r) => (r.verdict === null ? '—' : `${VERDICT_MARK[r.verdict]} ${r.score}`)).join(' · ')} | ${c.meanScore === null ? '—' : c.meanScore.toFixed(1)} | ${c.consistent ? 'yes' : 'no'} | ${usd(c.cost)} |`)].join('\n'),
    ...worst.map((c) => [
      `### ${c.case}. ${c.title}`,
      `Good: ${c.good}`,
      ...c.reps.map((r) => `- **rep ${r.rep}: ${r.verdict === null ? 'not judged' : `${r.verdict} ${r.score}/10`}** — ${r.summary}${r.cause === null ? '' : ` _(cause ${r.cause}, layer ${r.layer ?? '—'}; fix: ${r.fix})_`}${r.checksFailed.length === 0 ? '' : ` **Checks failed: ${r.checksFailed.join(', ')}.**`} Ended ${r.ended}, ${Math.round(r.wallMs / 1000)}s, ${usd(r.cost)}. [transcript](${r.file}) · chat: ${r.sessions.join(' , ')}`),
    ].join('\n\n')),
  ].join('\n\n');
}

/** Write `report.md` and `report.json`; gives the markdown's path. */
export function writeReport(iteration: string): { path: string; report: Report } {
  const report = buildReport(iteration);
  const folder = iterationFolder(iteration);
  writeFileSync(join(folder, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const path = join(folder, 'report.md');
  writeFileSync(path, `${reportMarkdown(report)}\n`);
  return { path, report };
}
