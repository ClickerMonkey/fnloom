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
import { Shedding } from './busy.ts';
import { JudgedCase, Verdict, type Cause, type Layer } from './records.ts';
import { SCENARIOS_DIR } from './rep.ts';
import { usd } from './transcript.ts';
import { VARIANT_LABELS, VARIANT_NAMES, VariantRecord, type VariantName } from './variants.ts';

/** The hub stopping in the middle of a rep. */
export const RepCrash = z.object({
  at: z.string(),
  error: z.string(),
  /** The cases marked harness-crash. */
  cases: z.array(z.number().int()),
  logTail: z.array(z.string()),
  /** The stack folder (from the rep's) the remaining cases went on in, or absent when they didn't. */
  restartedIn: z.string().optional(),
});
export type RepCrash = z.infer<typeof RepCrash>;

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
  /** Each time the hub stopped answering during the rep: when, the cases it took down, the log's end, and the stack folder the rest went on in. */
  crashes: z.array(RepCrash).default([]),
  /** The household variant (`variants.ts`): what was set and how the hub read it back (absent: before variants, 2026-11-22). */
  variant: VariantRecord.optional(),
  /** The calls the hub shed (HTTP 503, "the hub is busy") during the rep, which the runner tried again (`busy.ts`). */
  shedding: Shedding.optional(),
  /** The fake home folder of each stack the rep ran (outside the repository). */
  homes: z.array(z.string()).default([]),
});
export type RepMeta = z.infer<typeof RepMeta>;

const VERDICT_MARK = { pass: 'pass', weak: 'WEAK', fail: 'FAIL' } as const;

/** One case across its repetitions (of every variant). */
export const CaseSummary = z.object({
  case: z.number().int(),
  title: z.string(),
  good: z.string(),
  reps: z.array(z.object({
    rep: z.number().int(),
    /** The variant folder it ran in (absent: a run of one variant). */
    variant: z.string().optional(),
    verdict: Verdict.nullable(), score: z.number().nullable(), summary: z.string(), cause: z.string().nullable(), layer: z.string().nullable(), fix: z.string(),
    cost: z.number(), wallMs: z.number(), ended: z.string(), checksFailed: z.array(z.string()), sessions: z.array(z.string()), file: z.string(),
    /** The hub's model calls and the tool runs of the case (its steps), and the calls the hub shed. */
    modelCalls: z.number().int().default(0), toolRuns: z.number().int().default(0), shed: z.number().int().default(0),
  })),
  meanScore: z.number().nullable(),
  /** Every judged repetition gave the same verdict. */
  consistent: z.boolean(),
  cost: z.number(),
});
export type CaseSummary = z.infer<typeof CaseSummary>;

/** One case under one variant: its reps in short. */
export const VariantCell = z.object({
  variant: z.string(),
  verdicts: z.array(Verdict.nullable()),
  meanScore: z.number().nullable(),
  /** Mean cost, model calls and tool runs per rep. */
  cost: z.number(),
  modelCalls: z.number(),
  toolRuns: z.number(),
});
export type VariantCell = z.infer<typeof VariantCell>;

/** The variants side by side: per variant in all, and per case. */
export const Comparison = z.object({
  variants: z.array(z.object({
    variant: z.string(),
    reps: z.number().int(),
    pass: z.number().int(), weak: z.number().int(), fail: z.number().int(), unjudged: z.number().int(),
    meanScore: z.number().nullable(),
    cost: z.number(),
    meanModelCalls: z.number(), meanToolRuns: z.number(),
    shed: z.number().int(),
  })),
  cases: z.array(z.object({
    case: z.number().int(), title: z.string(),
    cells: z.array(VariantCell),
    /** The second variant's mean score minus the first's (null when either has none). */
    delta: z.number().nullable(),
    /** The variants' verdict sets differ. */
    verdictsDiffer: z.boolean(),
  })),
});
export type Comparison = z.infer<typeof Comparison>;

export const Report = z.object({
  iteration: z.string(),
  writtenAt: z.string(),
  reps: z.array(RepMeta),
  cases: z.array(CaseSummary),
  causes: z.record(z.string(), z.number()),
  layers: z.record(z.string(), z.number()),
  cost: z.object({ hub: z.number(), person: z.number(), judge: z.number(), total: z.number() }),
  /** The variants compared (present when the iteration ran more than one). */
  comparison: Comparison.optional(),
});
export type Report = z.infer<typeof Report>;

/** The folder of an iteration. */
export function iterationFolder(iteration: string): string {
  return join(SCENARIOS_DIR, iteration);
}

/** The variant folders an iteration has (`<iteration>/<variant>/rep-<n>/`), in `VARIANT_NAMES` order. */
export function savedVariants(iteration: string): VariantName[] {
  const folder = iterationFolder(iteration);
  if (!existsSync(folder)) { return []; }
  return VARIANT_NAMES.filter((name) => existsSync(join(folder, name)) && readdirSync(join(folder, name)).some((n) => /^rep-\d+$/.test(n)));
}

/** The rep folders under one folder, by number. */
const repNames = (folder: string): string[] => readdirSync(folder).filter((n) => /^rep-\d+$/.test(n)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

/** Every judged case saved for an iteration, by repetition (top-level reps first, then each variant's). */
export function loadIteration(iteration: string): { reps: RepMeta[]; cases: JudgedCase[] } {
  const folder = iterationFolder(iteration);
  if (!existsSync(folder)) { throw new Error(`no iteration ${iteration} at ${folder}`); }
  const reps: RepMeta[] = [];
  const cases: JudgedCase[] = [];
  const places = [{ dir: folder, variant: undefined as string | undefined }, ...savedVariants(iteration).map((v) => ({ dir: join(folder, v), variant: v as string | undefined }))];
  for (const { dir: base, variant } of places) {
    for (const name of repNames(base)) {
      const meta = join(base, name, 'rep.json');
      if (existsSync(meta)) { reps.push(RepMeta.parse(JSON.parse(readFileSync(meta, 'utf8')))); }
      const dir = join(base, name, 'cases');
      if (!existsSync(dir)) { continue; }
      for (const file of readdirSync(dir).filter((n) => /^case-\d+\.json$/.test(n)).sort()) {
        const judged = JudgedCase.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        // the folder decides the variant (a record saved before variants has none)
        cases.push(variant === undefined ? judged : { ...judged, variant });
      }
    }
  }
  return { reps, cases };
}

/** Where a case's readable file is, from the iteration folder. */
export function caseFile(rep: number, caseId: number, variant?: string): string {
  return `${variant === undefined ? '' : `${variant}/`}rep-${rep}/cases/case-${String(caseId).padStart(2, '0')}.md`;
}

const costOf = (judged: JudgedCase): number => judged.stats.hubCost + judged.stats.personCost + judged.judgeCost;

/** A mean, or null for none. */
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length);

/** The order a variant sorts in (known names first, in their order). */
const variantOrder = (v: string): number => { const i = (VARIANT_NAMES as readonly string[]).indexOf(v); return i < 0 ? VARIANT_NAMES.length : i; };

/** The variants side by side, when the iteration has more than one. */
function compare(cases: readonly JudgedCase[]): Comparison | undefined {
  const names = [...new Set(cases.flatMap((c) => (c.variant === undefined ? [] : [c.variant])))].sort((a, b) => variantOrder(a) - variantOrder(b));
  if (names.length < 2) { return undefined; }
  const of = (variant: string): JudgedCase[] => cases.filter((c) => c.variant === variant);
  const variants = names.map((variant) => {
    const runs = of(variant);
    const verdict = (v: Verdict): number => runs.filter((r) => r.judgement?.verdict === v).length;
    return {
      variant, reps: new Set(runs.map((r) => r.rep)).size,
      pass: verdict('pass'), weak: verdict('weak'), fail: verdict('fail'), unjudged: runs.filter((r) => r.judgement === null).length,
      meanScore: mean(runs.flatMap((r) => (r.judgement === null ? [] : [r.judgement.score]))),
      cost: runs.reduce((sum, r) => sum + costOf(r), 0),
      meanModelCalls: mean(runs.map((r) => r.stats.modelCalls)) ?? 0, meanToolRuns: mean(runs.map((r) => r.stats.toolRuns)) ?? 0,
      shed: runs.reduce((sum, r) => sum + (r.stats.shed ?? 0), 0),
    };
  });
  const ids = [...new Set(cases.map((c) => c.case))].sort((a, b) => a - b);
  const rows = ids.map((id) => {
    const cells = names.map((variant): VariantCell => {
      const runs = of(variant).filter((c) => c.case === id).sort((a, b) => a.rep - b.rep);
      return {
        variant, verdicts: runs.map((r) => r.judgement?.verdict ?? null),
        meanScore: mean(runs.flatMap((r) => (r.judgement === null ? [] : [r.judgement.score]))),
        cost: mean(runs.map(costOf)) ?? 0, modelCalls: mean(runs.map((r) => r.stats.modelCalls)) ?? 0, toolRuns: mean(runs.map((r) => r.stats.toolRuns)) ?? 0,
      };
    });
    const [first, second] = cells;
    const delta = first?.meanScore == null || second?.meanScore == null ? null : second.meanScore - first.meanScore;
    const sets = cells.map((c) => [...new Set(c.verdicts.filter((v) => v !== null))].sort().join(','));
    return { case: id, title: cases.find((c) => c.case === id)?.title ?? '', cells, delta, verdictsDiffer: new Set(sets).size > 1 };
  });
  return { variants, cases: rows };
}

/** Summarize an iteration. */
export function buildReport(iteration: string): Report {
  const { reps, cases } = loadIteration(iteration);
  const byCase = new Map<number, JudgedCase[]>();
  for (const judged of cases) { byCase.set(judged.case, [...(byCase.get(judged.case) ?? []), judged]); }
  const causes: Partial<Record<Cause, number>> = {};
  const layers: Partial<Record<Layer, number>> = {};
  const summaries: CaseSummary[] = [...byCase.entries()].sort(([a], [b]) => a - b).map(([id, runs]) => {
    const sorted = [...runs].sort((a, b) => variantOrder(a.variant ?? '') - variantOrder(b.variant ?? '') || a.rep - b.rep);
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
        rep: judged.rep, ...(judged.variant === undefined ? {} : { variant: judged.variant }),
        verdict: judged.judgement?.verdict ?? null, score: judged.judgement?.score ?? null, summary: judged.judgement?.summary ?? judged.judgeError ?? '',
        cause: judged.judgement?.cause ?? null, layer: judged.judgement?.layer ?? null, fix: judged.judgement?.fix ?? '',
        cost: costOf(judged), wallMs: judged.stats.wallMs, ended: judged.ending.by, checksFailed: judged.checks.filter((c) => !c.ok).map((c) => c.name),
        sessions: judged.sessions.map((s) => s.url), file: caseFile(judged.rep, id, judged.variant),
        modelCalls: judged.stats.modelCalls, toolRuns: judged.stats.toolRuns, shed: judged.stats.shed ?? 0,
      })),
      meanScore: mean(scores),
      consistent: verdicts.size <= 1,
      cost: sorted.reduce((sum, judged) => sum + costOf(judged), 0),
    };
  });
  const sum = (pick: (judged: JudgedCase) => number): number => cases.reduce((total, judged) => total + pick(judged), 0);
  const cost = { hub: sum((j) => j.stats.hubCost), person: sum((j) => j.stats.personCost), judge: sum((j) => j.judgeCost), total: 0 };
  cost.total = cost.hub + cost.person + cost.judge;
  const comparison = compare(cases);
  return { iteration, writtenAt: new Date().toISOString(), reps, cases: summaries, causes, layers, cost, ...(comparison === undefined ? {} : { comparison }) };
}

/** A variant's name as a report reads it. */
export function variantLabel(variant: string): string {
  return variant in VARIANT_LABELS ? `${variant} (${VARIANT_LABELS[variant as VariantName]})` : variant;
}

/** The comparison as markdown: the variants in all, where they differ most, and every case side by side. */
export function comparisonMarkdown(report: Report): string {
  const c = report.comparison;
  if (c === undefined) { return ''; }
  const score = (n: number | null): string => (n === null ? '—' : n.toFixed(1));
  const mark = (v: Verdict | null): string => (v === null ? '—' : VERDICT_MARK[v]);
  const [a, b] = c.variants;
  const totals = ['| variant | reps | pass | weak | fail | not judged | mean score | cost | model calls / case | tool runs / case | shed calls |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...c.variants.map((v) => `| ${variantLabel(v.variant)} | ${v.reps} | ${v.pass} | ${v.weak} | ${v.fail} | ${v.unjudged} | ${score(v.meanScore)} | ${usd(v.cost)} | ${v.meanModelCalls.toFixed(1)} | ${v.meanToolRuns.toFixed(1)} | ${v.shed} |`)].join('\n');
  const moved = c.cases.filter((row) => row.delta !== null).sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0));
  const better = moved.filter((row) => (row.delta ?? 0) > 0);
  const worse = moved.filter((row) => (row.delta ?? 0) < 0);
  const line = (row: Comparison['cases'][number]): string => `${row.case}. ${row.title} (${row.cells.map((cell) => `${cell.variant} ${score(cell.meanScore)}`).join(' → ')}, ${(row.delta ?? 0) > 0 ? '+' : ''}${(row.delta ?? 0).toFixed(1)})`;
  const summary = a === undefined || b === undefined ? [] : [
    `Mean score ${a.variant} ${score(a.meanScore)} vs ${b.variant} ${score(b.meanScore)}; passes ${a.pass} vs ${b.pass}, fails ${a.fail} vs ${b.fail}; cost ${usd(a.cost)} vs ${usd(b.cost)}; model calls per case ${a.meanModelCalls.toFixed(1)} vs ${b.meanModelCalls.toFixed(1)}.`,
    `- **Better with ${b.variant}** (${better.length} case(s)): ${better.slice(0, 8).map(line).join('; ') || 'none'}.`,
    `- **Worse with ${b.variant}** (${worse.length} case(s)): ${worse.slice(0, 8).map(line).join('; ') || 'none'}.`,
    `- **Verdicts differ** in ${c.cases.filter((row) => row.verdictsDiffer).length} of ${c.cases.length} case(s): ${c.cases.filter((row) => row.verdictsDiffer).map((row) => row.case).join(', ') || 'none'}.`,
    `Every case runs ${a.reps} rep(s) a variant, so a difference of one verdict in one case is within the noise the reps of one variant already show; read the cases that move in every rep.`,
  ];
  const head = `| case | ${c.variants.map((v) => `${v.variant}: verdicts · mean · cost · calls · runs`).join(' | ')} | Δ mean |`;
  const rows = [...c.cases].sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0) || x.case - y.case).map((row) => `| ${row.case}. ${row.title} | ${row.cells.map((cell) => `${cell.verdicts.map(mark).join('/') || '—'} · ${score(cell.meanScore)} · ${usd(cell.cost)} · ${cell.modelCalls.toFixed(0)} · ${cell.toolRuns.toFixed(0)}`).join(' | ')} | ${row.delta === null ? '—' : `${row.delta > 0 ? '+' : ''}${row.delta.toFixed(1)}`} |`);
  return [
    `## Variants compared: ${c.variants.map((v) => variantLabel(v.variant)).join(' vs ')}`,
    totals,
    ...summary,
    '### Case by case (largest difference first; cost, model calls and tool runs are means per rep)',
    [head, `|---|${c.variants.map(() => '---|').join('')}---|`, ...rows].join('\n'),
  ].join('\n\n');
}

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
  const several = report.comparison !== undefined;
  const repName = (r: RepMeta): string => `${several && r.variant !== undefined ? `${r.variant.name} ` : ''}rep ${r.rep}`;
  const variantNote = (r: RepMeta): string => (r.variant === undefined ? '' : `; variant ${r.variant.name}${r.variant.model === undefined ? '' : ` (${r.variant.model}${r.variant.proof === undefined ? '' : `, preview: ${r.variant.proof.calls} decision call(s)`})`}${r.variant.notes.length === 0 ? '' : ` — ${r.variant.notes.join('; ')}`}`);
  const shed = report.reps.filter((r) => (r.shedding?.sheds ?? 0) > 0);
  const shedLine = (r: RepMeta): string => {
    const t = r.shedding;
    if (t === undefined) { return ''; }
    const calls = Object.entries(t.byCall).sort(([, x], [, y]) => y - x).slice(0, 6).map(([call, n]) => `${call} ${n}`).join(', ');
    return `- ${repName(r)}: ${t.sheds} shed answer(s) on ${t.calls} call(s), ${Math.round(t.waitedMs / 1000)}s waiting, ${t.gaveUp} given up (from ${t.first ?? '—'} to ${t.last ?? '—'}); by call: ${calls}`;
  };
  const repsLine = report.reps.map((r) => `${repName(r)}: ${r.systems.join(', ')}${r.skipped.length === 0 ? '' : ` (not run: ${r.skipped.join('; ')})`}${indexNote(r)}${variantNote(r)}`).join('\n- ');
  const behind = report.reps.filter((r) => r.index?.caughtUp === false).map(repName);
  const crashes = report.reps.flatMap((r) => r.crashes.map((c) => ({ rep: repName(r), ...c })));
  const crashed = report.cases.flatMap((c) => c.reps).filter((r) => r.ended === 'harness-crash').length;
  const diagnosed = existsSync(join(iterationFolder(report.iteration), 'diagnosis.md'));
  return [
    `# Scenarios: ${report.iteration}`,
    `Written ${report.writtenAt}. ${report.cases.length} cases × ${report.reps.length} rep(s). Verdicts: ${count('pass')} pass, ${count('weak')} weak, ${count('fail')} fail${crashed === 0 ? '' : `, ${crashed} lost to a harness crash`}. Cost: ${usd(report.cost.total)} (hub ${usd(report.cost.hub)}, person ${usd(report.cost.person)}, judge ${usd(report.cost.judge)}). Model: ${report.reps[0]?.model ?? '—'}.`,
    ...(crashes.length === 0 ? [] : [`**The hub crashed ${crashes.length} time(s):**\n${crashes.map((c) => `- ${c.rep} at ${c.at}: ${c.error.slice(0, 200)}. Cases marked harness-crash: ${c.cases.join(', ') || 'none'}. ${c.restartedIn === undefined ? 'The rest of the rep did not run.' : `The rest ran on a fresh stack in that rep's ${c.restartedIn}/.`}${c.logTail.length === 0 ? '' : `\n\n  \`\`\`\n  ${c.logTail.slice(-12).map((l) => l.slice(0, 240)).join('\n  ')}\n  \`\`\``}`).join('\n')}`]),
    ...(shed.length === 0 ? [] : [`**The hub shed load (HTTP 503, "the hub is busy") in ${shed.length} rep(s).** The runner waited and tried again (\`busy.ts\`); a case fails on it only past that patience. This is the hub's finding, not the agent's:\n${shed.map(shedLine).join('\n')}`]),
    ...(several ? [comparisonMarkdown(report)] : []),
    ...(diagnosed ? ['**Why it went that way, step by step, and the fixes ranked: [diagnosis.md](diagnosis.md).**'] : []),
    ...(behind.length === 0 ? [] : [`**The index never caught up in rep(s) ${behind.join(', ')}: suggestions and search by meaning were off or partial there, so read those verdicts with that in mind.**`]),
    `Stacks:\n- ${repsLine || '—'}`,
    'Open a rep\'s chats: `npm run scenarios -- --view ' + report.iteration + ' --rep <n>' + (several ? ' --variant <name>' : '') + '`, then the session links below (sign in as the case\'s person, password `scenario-person-password`).',
    '## Causes (weak and fail reps)',
    table(report.causes),
    '## Layers to fix',
    table(report.layers),
    '## Cases, worst first',
    ['| case | reps | mean | same? | cost |', '|---|---|---|---|---|', ...worst.map((c) => `| ${c.case}. ${c.title} | ${c.reps.map((r) => `${r.variant === undefined ? '' : `${r.variant}:`}${r.verdict === null ? '—' : `${VERDICT_MARK[r.verdict]} ${r.score}`}`).join(' · ')} | ${c.meanScore === null ? '—' : c.meanScore.toFixed(1)} | ${c.consistent ? 'yes' : 'no'} | ${usd(c.cost)} |`)].join('\n'),
    ...worst.map((c) => [
      `### ${c.case}. ${c.title}`,
      `Good: ${c.good}`,
      ...c.reps.map((r) => `- **${r.variant === undefined ? '' : `${r.variant} `}rep ${r.rep}: ${r.verdict === null ? 'not judged' : `${r.verdict} ${r.score}/10`}** — ${r.summary}${r.cause === null ? '' : ` _(cause ${r.cause}, layer ${r.layer ?? '—'}; fix: ${r.fix})_`}${r.checksFailed.length === 0 ? '' : ` **Checks failed: ${r.checksFailed.join(', ')}.**`} Ended ${r.ended}, ${Math.round(r.wallMs / 1000)}s, ${usd(r.cost)}. [transcript](${r.file}) · chat: ${r.sessions.join(' , ')}`),
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
