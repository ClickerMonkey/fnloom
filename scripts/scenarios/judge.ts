/**
 * The judge: a model (on OpenRouter, apart from the hub) reads the request, its Good line, what the harness should
 * have used, the hard checks and the whole transcript with every run's args and outcome, and gives a zod-checked
 * verdict: pass / weak / fail, a score, what went well and wrong, the main cause (from a fixed list) and the layer to
 * fix. A judge that fails leaves the case unjudged, with why.
 */
import { CASES } from './cases.ts';
import type { OpenRouter } from './openrouter.ts';
import { CAUSES, Judgement, LAYERS, type CaseRecord, type JudgedCase } from './records.ts';
import { transcriptMarkdown } from './transcript.ts';

/** The most transcript the judge reads (characters); the start and end are kept. */
const MAX_TRANSCRIPT = 60_000;

const RUBRIC = `You judge how well an AI assistant app (a "harness": a chat agent with fns, i.e. tools, from systems such as files, a database, web search, forms, widgets, code and API fns, memory and approvals) handled a vague, everyday request from a non-technical person. The person was simulated.

Grade against the Good line: it says what a strong result looks like. Several requests ask for things the app can't do yet (it can't act on a schedule or message people by itself): there, good means it says so plainly, builds the closest thing it can and doesn't pretend.

- pass (7-10): did what the Good line describes, or close to it, honestly.
- weak (4-6): partly there: missed a key part, asked badly (too much or not at all), or was clumsy, slow or confusing.
- fail (0-3): didn't help, did something wrong or unsafe, claimed things it didn't do, or broke.

Causes (pick the main one when it isn't a clean pass; null for a clean pass): ${CAUSES.join(', ')}.
- didnt-ask: guessed where it should have asked. asked-too-much: questions it could have skipped or asked in one go.
- wrong-tool: used a tool that doesn't fit. missed-capability: never used something the app has that fits.
- gave-up: stopped short. overpromised: said it would/could do what it can't. hallucinated: made up facts or results.
- tool-error: a tool failed. harness-bug: the app itself misbehaved (a stuck turn, a broken card). prompt-unclear: the model was confused by its own instructions or tool docs. slow: far too many steps or too long.
Layers (where the fix belongs; null for a clean pass): ${LAYERS.join(', ')}.
- fn: a tool's behavior or its arguments. context: the docs/context items the model reads about the tools. kind: a kind of fn (how authored fns are made). instructions: a tool's usage text. chat-prompt: the chat agent's system prompt (its core text; the hub's and each system's injected items in it are context). ui: how the web app shows it. hub: the hub's own logic.

Read the run lines: they show what really happened (a "saved" claim with no saving run is a false claim). The hard checks are code checks of the same transcript.

Answer with one JSON object: {"verdict": "pass"|"weak"|"fail", "score": 0-10, "summary": "one or two sentences", "wentWell": [short strings], "wentWrong": [short strings], "cause": one cause or null, "layer": one layer or null, "fix": "the change you'd make first, in a sentence (empty for a clean pass)"}`;

/** The transcript, cut in the middle when it is too long. */
function bounded(text: string): string {
  if (text.length <= MAX_TRANSCRIPT) { return text; }
  const half = MAX_TRANSCRIPT / 2;
  return `${text.slice(0, half)}\n\n[… ${text.length - MAX_TRANSCRIPT} characters cut …]\n\n${text.slice(-half)}`;
}

/** Judge one played case. */
export async function judgeCase(router: OpenRouter, model: string, record: CaseRecord): Promise<JudgedCase> {
  const played = CASES.find((c) => c.id === record.case);
  const prompt = [
    `Request ${record.case} ("${record.title}"), as typed: ${played?.steps.map((step, i) => `${i + 1}. "${step.say}"${step.newChat === true ? ' (in a new chat)' : ''}${step.whileRunning === true ? ' (sent while the previous turn was still running)' : ''}${step.files === undefined ? '' : ` [files: ${step.files.join(', ')}]`}`).join(' ') ?? record.title}`,
    `Good: ${record.good}`,
    `What it should end up using (for you only): ${played?.notes ?? '—'}`,
    `The person's private facts (only the person knew these; the assistant starts knowing none of them unless the transcript shows it was told or found them, so asking for one is right): ${played?.facts.join(' ') || 'none'} They were after: ${played?.wants ?? '—'}`,
    `How it ended: ${record.ending.by} — ${record.ending.reason}`,
    `Hard checks: ${record.checks.map((c) => `${c.ok ? 'ok' : 'FAILED'} ${c.name}: ${c.detail}`).join(' | ')}`,
    `Numbers: ${record.stats.turns} turns, ${record.stats.toolRuns} runs, ${record.stats.modelCalls} model calls, ${Math.round(record.stats.wallMs / 1000)}s.`,
    record.errors.length === 0 ? '' : `The test runner hit: ${record.errors.join(' | ')}`,
    `Transcript:\n\n${bounded(transcriptMarkdown(record, 'full'))}`,
  ].filter((part) => part !== '').join('\n\n');
  try {
    const { value, cost } = await router.json(model, Judgement, [{ role: 'system', content: RUBRIC }, { role: 'user', content: prompt }]);
    return { ...record, judgement: value, judgeCost: cost };
  } catch (error) {
    return { ...record, judgement: null, judgeCost: 0, judgeError: error instanceof Error ? error.message : String(error) };
  }
}
