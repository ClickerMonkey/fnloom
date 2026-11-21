/**
 * The iteration as a hitl review Phil reads on his phone (`.hitl/reviews/scenarios-<iteration>.json`): one item per
 * case, titled with its verdicts ("12. Heat pump — pass/weak/fail ×3"), its markdown holding the request, the Good
 * line, each repetition's verdict and reasons, where to open its chat, and its transcript folded away. He gives a
 * verdict and comments per case, which the next iteration reads back (`npx hitloop feedback scenarios-<iteration>`).
 * Publishing again replaces the items and keeps the review (and so his verdicts, by item id).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CASES } from './cases.ts';
import type { JudgedCase } from './records.ts';
import { buildReport, loadIteration, type CaseSummary } from './report.ts';
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
  const verdicts = summary.reps.map((r) => r.verdict ?? 'unjudged');
  const same = new Set(verdicts).size === 1;
  return same ? `${verdicts[0]} ×${verdicts.length}` : verdicts.join('/');
}

/** One repetition, as the item shows it. */
function repSection(judged: JudgedCase): string {
  const j = judged.judgement;
  const verdict = j === null ? `not judged (${judged.judgeError ?? '—'})` : `${j.verdict} ${j.score}/10`;
  const transcript = clip(transcriptMarkdown(judged, 'short'), MAX_REP_TRANSCRIPT);
  return [
    `### Rep ${judged.rep}: ${verdict}`,
    j === null ? '' : j.summary,
    j === null ? '' : [...j.wentWell.map((w) => `- ✓ ${w}`), ...j.wentWrong.map((w) => `- ✗ ${w}`)].join('\n'),
    j === null || j.cause === null ? '' : `Cause **${j.cause}**, layer **${j.layer ?? '—'}**. Fix: ${j.fix}`,
    judged.checks.some((c) => !c.ok) ? `**Checks failed:** ${judged.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ')}` : '',
    statsLine(judged),
    `Open the chat: ${judged.sessions.map((s) => `[${s.url}](${s.url})`).join(' · ')} — sign in as \`${judged.person.email}\` / \`${judged.person.password}\` while \`npm run scenarios -- --view ${judged.iteration} --rep ${judged.rep}\` runs.`,
    `<details><summary>Transcript, rep ${judged.rep}</summary>\n\n${transcript}\n\n</details>`,
  ].filter((part) => part !== '').join('\n\n');
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
    const reps = cases.filter((c) => c.case === summary.case).sort((a, b) => a.rep - b.rep);
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
    intro: `The 40 everyday requests played against a fresh hub with GPT-6 Luna, ${report.reps.length} rep(s) each, a simulated non-technical person answering, judged by a model on each request's Good line. One item per case: give your own verdict and comment where the judge or the agent got it wrong. Total cost ${usd(report.cost.total)}. The full report is .harness-test/scenarios/${iteration}/report.md.`,
    mode: 'review',
    status: 'open',
    from: 'harness scenarios runner',
    created: saved.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
    items,
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
