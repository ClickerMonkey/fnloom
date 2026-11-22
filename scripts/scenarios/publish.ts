/**
 * The iteration as a hitl review Phil reads on his phone (`.hitl/reviews/scenarios-<iteration>.json`): one item per
 * case, titled with its verdicts ("12. Heat pump — pass/weak/fail ×3"), its markdown holding the request, the Good
 * line, each repetition's verdict and reasons, where to open its chat, and its transcript folded away. He gives a
 * verdict and comments per case, which the next iteration reads back (`npx hitloop feedback scenarios-<iteration>`).
 * When the iteration has a diagnosis (`diagnosis.md`), it is the first item, and each repetition shows its own.
 * Publishing again replaces the items and keeps the review (and so his verdicts, by item id).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CASES } from './cases.ts';
import type { JudgedCase } from './records.ts';
import { loadDiagnosis } from './diagnose.ts';
import { buildReport, comparisonMarkdown, iterationFolder, loadIteration, variantLabel, type CaseSummary, type Report } from './report.ts';
import { repFolder } from './rep.ts';
import { ROOT } from '../stack.ts';
import { clip, statsLine, transcriptMarkdown, usd } from './transcript.ts';

/** The most of one repetition's transcript an item holds. */
const MAX_REP_TRANSCRIPT = 14_000;

/** The parts of a saved review this keeps when publishing again. */
const SavedReview = z.object({ created: z.string().optional() }).loose();

/** The review's id. */
export function reviewId(iteration: string): string {
  return `scenarios-${iteration}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

/** A case's verdicts as a title: "pass/weak/fail ×3", or "pass ×3" when they agree. */
function verdictTitle(summary: CaseSummary): string {
  const line = (reps: CaseSummary['reps']): string => {
    const verdicts = reps.map((r) => r.verdict ?? 'unjudged');
    return new Set(verdicts).size === 1 ? `${verdicts[0]} ×${verdicts.length}` : verdicts.join('/');
  };
  const variants = [...new Set(summary.reps.flatMap((r) => (r.variant === undefined ? [] : [r.variant])))];
  // with variants: "off pass ×3 · on weak/pass/pass"
  return variants.length < 2 ? line(summary.reps) : variants.map((v) => `${v} ${line(summary.reps.filter((r) => r.variant === v))}`).join(' · ');
}

/** A repetition's diagnosis in short: its root cause and fixes (empty when it has none). */
function diagnosisSection(judged: JudgedCase): string {
  const saved = loadDiagnosis(repFolder(judged.iteration, judged.rep, judged.variant), judged.case);
  const d = saved?.diagnosis;
  if (d === undefined || d === null) { return ''; }
  return [
    `**Diagnosis:** ${d.rootCause}`,
    d.fixes.map((f) => `- \`${f.where}\` (${f.confidence.toFixed(2)}): ${f.problem}\n  > ${clip(f.proposedText, 800).split('\n').join('\n  > ')}`).join('\n'),
  ].join('\n\n');
}

/** One repetition, as the item shows it. */
function repSection(judged: JudgedCase): string {
  const j = judged.judgement;
  const verdict = j === null ? `not judged (${judged.judgeError ?? '—'})` : `${j.verdict} ${j.score}/10`;
  const transcript = clip(transcriptMarkdown(judged, 'short'), MAX_REP_TRANSCRIPT);
  return [
    `### ${judged.variant === undefined ? '' : `${variantLabel(judged.variant)}, `}rep ${judged.rep}: ${verdict}`,
    j === null ? '' : j.summary,
    j === null ? '' : [...j.wentWell.map((w) => `- ✓ ${w}`), ...j.wentWrong.map((w) => `- ✗ ${w}`)].join('\n'),
    j === null || j.cause === null ? '' : `Cause **${j.cause}**, layer **${j.layer ?? '—'}**. Fix: ${j.fix}`,
    judged.checks.some((c) => !c.ok) ? `**Checks failed:** ${judged.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ')}` : '',
    statsLine(judged),
    diagnosisSection(judged),
    `Open the chat: ${judged.sessions.map((s) => `[${s.url}](${s.url})`).join(' · ')} — sign in as \`${judged.person.email}\` / \`${judged.person.password}\` while \`npm run scenarios -- --view ${judged.iteration} --rep ${judged.rep}${judged.variant === undefined ? '' : ` --variant ${judged.variant}`}\` runs.`,
    `<details><summary>Transcript, ${judged.variant === undefined ? '' : `${judged.variant} `}rep ${judged.rep}</summary>\n\n${transcript}\n\n</details>`,
  ].filter((part) => part !== '').join('\n\n');
}

/** The most of diagnosis.md the first item holds. */
const MAX_DIAGNOSIS = 40_000;

/** The iteration's diagnosis as the review's first item (none when it hasn't been diagnosed). */
function diagnosisItem(iteration: string): Array<{ id: string; title: string; ask: string; md: string }> {
  const file = join(iterationFolder(iteration), 'diagnosis.md');
  if (!existsSync(file)) { return []; }
  return [{
    id: 'diagnosis',
    title: 'Diagnosis: what the model was shown, why it went that way, and the fixes ranked',
    ask: 'Are these the right fixes, in the right order? Which would you make first?',
    md: clip(readFileSync(file, 'utf8'), MAX_DIAGNOSIS),
  }];
}

/** The variants compared, as the review's first item (none for a run of one variant). */
function comparisonItem(report: Report): Array<{ id: string; title: string; ask: string; md: string }> {
  const c = report.comparison;
  if (c === undefined) { return []; }
  const [a, b] = c.variants;
  const score = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toFixed(1));
  return [{
    id: 'variants',
    title: `Decision models on vs off: mean ${a?.variant ?? '?'} ${score(a?.meanScore)} · ${b?.variant ?? '?'} ${score(b?.meanScore)}`,
    ask: 'Do decision models earn their cost? Which cases should decide it?',
    md: clip(comparisonMarkdown(report), MAX_DIAGNOSIS),
  }];
}

/** Write the review and give its links (LAN and Tailscale), or why there are none. */
export function publish(iteration: string): { file: string; links: string[] } {
  const report = buildReport(iteration);
  const { cases } = loadIteration(iteration);
  const id = reviewId(iteration);
  const folder = join(ROOT, '.hitl', 'reviews');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${id}.json`);
  const saved = existsSync(file) ? SavedReview.parse(JSON.parse(readFileSync(file, 'utf8'))) : {};
  const items = report.cases.map((summary) => {
    const played = CASES.find((c) => c.id === summary.case);
    const reps = cases.filter((c) => c.case === summary.case).sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? '') || a.rep - b.rep);
    return {
      id: `case-${String(summary.case).padStart(2, '0')}`,
      title: `${summary.case}. ${summary.title} — ${verdictTitle(summary)}`,
      ask: 'Is the judge right? What should it have done?',
      md: [
        `**Request:** ${played?.steps.map((s) => `"${s.say}"${s.newChat === true ? ' _(new chat)_' : ''}${s.whileRunning === true ? ' _(while running)_' : ''}${s.files === undefined ? '' : ` _[${s.files.join(', ')}]_`}`).join(' → ') ?? summary.title}`,
        `**Good:** ${summary.good}`,
        `Mean ${summary.meanScore === null ? '—' : summary.meanScore.toFixed(1)}/10 · ${summary.consistent ? 'same verdict every rep' : 'verdicts differ'} · ${usd(summary.cost)}`,
        ...reps.map(repSection),
      ].join('\n\n'),
    };
  });
  const verdicts = report.cases.flatMap((c) => c.reps.map((r) => r.verdict));
  const review = {
    $schema: 'https://unpkg.com/hitloop/schema/reviews.schema.json',
    title: `Scenarios ${iteration}: ${verdicts.filter((v) => v === 'pass').length} pass, ${verdicts.filter((v) => v === 'weak').length} weak, ${verdicts.filter((v) => v === 'fail').length} fail`,
    intro: `The 40 everyday requests played against a fresh hub with GPT-6 Luna, ${report.reps.length} rep(s) each, a simulated non-technical person answering, judged by a model on each request's Good line.${report.comparison === undefined ? '' : ` Each case ran in two households, decision models off and on (${report.comparison.variants.map((v) => v.variant).join(' vs ')}); the first item compares them.`} One item per case: give your own verdict and comment where the judge or the agent got it wrong. Total cost ${usd(report.cost.total)}. The full report is .harness-test/scenarios/${iteration}/report.md.`,
    mode: 'review',
    status: 'open',
    from: 'harness scenarios runner',
    created: saved.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
    items: [...comparisonItem(report), ...diagnosisItem(iteration), ...items],
  };
  writeFileSync(file, `${JSON.stringify(review, null, 2)}\n`);
  return { file, links: hitlLinks(id) };
}

/** The review's links on this machine's network (never localhost), from `hitloop url`. */
function hitlLinks(id: string): string[] {
  try {
    const shell = process.platform === 'win32';
    const out = execFileSync(shell ? 'npx.cmd' : 'npx', ['hitloop', 'url', id], { cwd: ROOT, encoding: 'utf8', shell, timeout: 60_000 });
    return out.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^http:\/\/(192\.168\.|100\.)/.test(line));
  } catch (error) {
    return [`(hitloop url failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`];
  }
}
