/**
 * A played case as readable markdown: the person's messages, the agent's answers, its fn runs as short lines (fn,
 * status, outcome, the approval and what the person said), the forms it showed and the questions it asked. The
 * judge reads the same text the report and the hitl review show.
 */
import { callTrouble } from './checks.ts';
import type { CaseRecord, Entry, JudgedCase, ToolRun } from './records.ts';

/** Text shortened to `max` characters. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Quote text as a markdown block quote. */
function quoted(text: string): string {
  return text === '' ? '> (empty)' : text.split('\n').map((line) => `> ${line}`).join('\n');
}

/** What a run's trouble adds to its status: a model arg mistake is said to be one (sent back to the model, not a failure). */
function troubleNote(run: ToolRun): string {
  if (callTrouble(run) !== 'model-arg-mistake') { return ''; }
  return run.status === 'done' ? ` (model arg mistake, repaired: ${run.repairs ?? 1} field(s) sent as JSON text read as JSON)` : ' (model arg mistake: sent back for the model to fix; not a failure)';
}

/** One fn run as a line. */
export function runLine(run: ToolRun, detail: 'short' | 'full'): string {
  const indent = '  '.repeat(Math.max(0, run.depth - 1));
  const approval = run.approval === undefined ? '' : ` — approval "${run.approval.title}": ${run.approval.decision}${run.approval.reason === '' ? '' : ` (${run.approval.reason})`}`;
  const args = detail === 'full' ? ` ${run.args}` : '';
  const outcome = ` → ${detail === 'full' ? run.outcome : clip(run.outcome, 140)}`;
  return `${indent}- \`${run.fn}\` ${run.status}${troubleNote(run)}${args}${outcome}${approval}`;
}

/** What the person did with a widget preview's Save, as the transcript says it. */
const WIDGET_DECISIONS = {
  saved: 'the person pressed Save and it was kept',
  'save-failed': 'the person pressed Save but saving failed',
  declined: 'the person left it unsaved',
  'passed-over': 'passed over: a newer preview came with it',
} as const;

function entryText(entry: Entry, detail: 'short' | 'full'): string {
  switch (entry.type) {
    case 'chat': return `**— chat ${entry.session}${entry.as === undefined ? '' : `, as ${entry.as} on their own login`} —** (${entry.url})`;
    case 'person': return `**Person**${entry.scripted ? '' : ' (follow-up)'}:${entry.files.length === 0 ? '' : ` _[attached ${entry.files.join(', ')}]_`}\n${quoted(entry.text)}`;
    case 'form-answer': return `**Person fills "${entry.title}"**:\n${quoted(entry.text)}`;
    case 'agent': return `**Agent**${entry.status === 'done' ? '' : ` (${entry.status})`}:\n${quoted(entry.text)}`;
    case 'note': return `_Note: ${entry.text}_`;
    case 'tools': return `_Runs:_\n${entry.runs.map((run) => runLine(run, detail)).join('\n')}`;
    case 'form': return `_Form shown: "${entry.title}" — ${entry.fields.join(' · ')}_`;
    case 'question': return `_Asked directly: ${entry.question} → ${entry.answer}_`;
    case 'widget': return `_Widget preview shown: "${entry.title}" — ${WIDGET_DECISIONS[entry.decision]}${entry.detail === '' ? '' : ` (${entry.detail})`}_`;
  }
}

/** The transcript alone. `full` puts each run's args and whole outcome in (for the judge); `short` its fn, status and a clipped outcome. */
export function transcriptMarkdown(record: CaseRecord, detail: 'short' | 'full'): string {
  return record.entries.map((entry) => entryText(entry, detail)).join('\n\n');
}

/** Dollars, to a tenth of a cent. */
export function usd(value: number): string {
  return `$${value.toFixed(value < 0.1 ? 4 : 3)}`;
}

/** The numbers of a case in one line. */
export function statsLine(record: CaseRecord): string {
  const s = record.stats;
  return `${s.turns} turns · ${s.toolRuns} runs · ${s.modelCalls} model calls · hub ${usd(s.hubCost)} · person ${usd(s.personCost)} · ${Math.round(s.wallMs / 1000)}s${(s.shed ?? 0) === 0 ? '' : ` · ${s.shed} call(s) shed by a busy hub`}${record.variant === undefined ? '' : ` · variant ${record.variant}`} · ended: ${record.ending.by} (${record.ending.reason})`;
}

/** One judged case as a readable file: verdict, checks, numbers, sign-in, then the transcript. */
export function caseMarkdown(judged: JudgedCase): string {
  const j = judged.judgement;
  return [
    `# ${judged.case}. ${judged.title} — rep ${judged.rep}`,
    `**Good:** ${judged.good}`,
    j === null ? `**Judge:** none (${judged.judgeError ?? 'not judged'})` : `**Judge:** ${j.verdict} ${j.score}/10 — ${j.summary}${j.cause === null ? '' : `\n\nCause: ${j.cause} · layer: ${j.layer ?? '—'} · fix: ${j.fix}`}`,
    j === null ? '' : `Went well:\n${j.wentWell.map((w) => `- ${w}`).join('\n') || '- —'}\n\nWent wrong:\n${j.wentWrong.map((w) => `- ${w}`).join('\n') || '- —'}`,
    `**Checks:** ${judged.checks.map((c) => `${c.ok ? 'ok' : 'FAILED'} ${c.name} (${c.detail})`).join('; ')}`,
    `**Numbers:** ${statsLine(judged)}`,
    `**Open it:** ${judged.sessions.map((s) => `${s.url}${s.as === undefined ? '' : ` (${s.as}'s)`}`).join(' , ')} — sign in as ${judged.person.email} / ${judged.person.password}${(judged.others ?? []).map((o) => `; ${o.name} as ${o.email} / ${o.password}`).join('')} (\`npm run scenarios -- --view ${judged.iteration} --rep ${judged.rep}\`)`,
    judged.errors.length === 0 ? '' : `**Runner errors:**\n${judged.errors.map((e) => `- ${e}`).join('\n')}`,
    judged.stackErrors.length === 0 ? '' : `**Stack warnings/errors while it ran** (shared stack):\n${judged.stackErrors.slice(0, 15).map((e) => `- \`${e.slice(0, 240)}\``).join('\n')}`,
    '## Transcript',
    transcriptMarkdown(judged, 'full'),
  ].filter((part) => part !== '').join('\n\n');
}
