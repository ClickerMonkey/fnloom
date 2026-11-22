/**
 * The diagnostician: a model (GPT-6 Luna by default, `HARNESS_SCENARIOS_DIAGNOSE_MODEL`) that reads exactly what the
 * chat model saw at every LLM step of a case rep (from the rep's hub database, `modelview.ts`), next to the request,
 * its Good line, the person's facts, the judge's verdict and a true description of what the harness offers
 * (`mechanisms.md` plus the hub's live systems, kinds and fns). At each decision it asks whether a model that knows
 * tool calling but nothing about this harness could have known the right move from what it was shown, and files a
 * zod-checked diagnosis: the steps that mattered and why, a root cause, and fixes worded for such a model.
 *
 * Kept per case rep as `cases/case-NN.diagnosis.json` (and a "Diagnosis" section in `case-NN.md`); `aggregate` merges
 * every rep's fixes into the iteration's `diagnosis.md` / `diagnosis.json`, grouped by where they go and ranked by how
 * many case reps they'd help.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CASES } from './cases.ts';
import { inventory, LIMIT_STEPS, modelView, openHubDb } from './modelview.ts';
import type { OpenRouter } from './openrouter.ts';
import type { JudgedCase } from './records.ts';
import { clip, transcriptMarkdown, usd } from './transcript.ts';
import { VARIANT_NAMES } from './variants.ts';

/** Why the model did what it did at a step. */
export const STEP_CAUSES = ['missing-info', 'misleading-info', 'jargon-unexplained', 'wrong-mechanism', 'mechanism-missing', 'mechanism-too-hard', 'tool-bug', 'model-error', 'fine'] as const;
export const StepCause = z.enum(STEP_CAUSES);
export type StepCause = z.infer<typeof StepCause>;

/** Where a fix goes: a fixed place, or a place of one fn, kind or context key. */
export const WHERE = /^(system-prompt|systems-list|suggestions|hub-behaviour|new-mechanism|(tool-description|fn-instructions|kind-instructions|context):\S+)$/;

/** Words for confidence a model may give instead of a number. */
const CONFIDENCE_WORDS: Record<string, number> = { high: 0.8, medium: 0.5, low: 0.25 };

export const Fix = z.object({
  // a fn written as the model's tool name reads back as its qualified name (`database__main__x` is `database/main.x`)
  where: z.string().trim().transform((w) => w.replace(/^hub-behavior$/, 'hub-behaviour').replace(/__/, '/').replace(/^((?:tool-description|fn-instructions):[^/]+\/.*)$/, (place) => place.replaceAll('__', '.'))).pipe(z.string().regex(WHERE, 'system-prompt | systems-list | suggestions | hub-behaviour | new-mechanism | tool-description:<fn> | fn-instructions:<fn> | kind-instructions:<kind> | context:<key>')),
  /** The steps it would have changed. */
  steps: z.array(z.coerce.number().int()).default([]),
  problem: z.string().min(1),
  proposedText: z.string().min(1),
  confidence: z.preprocess((v) => (typeof v === 'string' ? (CONFIDENCE_WORDS[v.toLowerCase()] ?? Number(v)) : v), z.number().min(0).max(1)),
});
export type Fix = z.infer<typeof Fix>;

/** Words for a step's cause a model may give instead of the listed ones (iteration 1, case 4 rep 3 left one out). */
const CAUSE_WORDS: Record<string, StepCause> = {
  ok: 'fine', good: 'fine', correct: 'fine', right: 'fine', none: 'fine',
  'missing-information': 'missing-info', missing: 'missing-info', 'misleading-information': 'misleading-info', misleading: 'misleading-info',
  jargon: 'jargon-unexplained', 'unexplained-jargon': 'jargon-unexplained', 'bug': 'tool-bug', 'tool-error': 'tool-bug', error: 'model-error',
  'missing-mechanism': 'mechanism-missing', 'too-hard': 'mechanism-too-hard',
};

/** A cause as the list spells it: lower case, dashes, and the obvious synonyms; anything else is left for zod to refuse. */
function causeWord(value: unknown): unknown {
  if (typeof value !== 'string') { return value; }
  const word = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return (STEP_CAUSES as readonly string[]).includes(word) ? word : (CAUSE_WORDS[word] ?? word);
}

export const DiagnosedStep = z.object({
  step: z.coerce.number().int().min(0),
  did: z.string().default(''),
  // a fine step needs no "should"; a model sometimes leaves it out
  should: z.string().default(''),
  why: z.preprocess(causeWord, StepCause),
});
export type DiagnosedStep = z.infer<typeof DiagnosedStep>;

export const Diagnosis = z.object({
  steps: z.array(DiagnosedStep),
  rootCause: z.string().min(1),
  fixes: z.array(Fix),
});
export type Diagnosis = z.infer<typeof Diagnosis>;

/** One case rep's diagnosis, as saved. */
export const CaseDiagnosis = z.object({
  iteration: z.string(),
  rep: z.number().int(),
  /** The variant folder of the rep (absent: a run of one variant). */
  variant: z.string().optional(),
  case: z.number().int(),
  title: z.string(),
  model: z.string(),
  diagnosedAt: z.string(),
  cost: z.number(),
  /** How many LLM steps the trace held, and how long the prompt was (characters). */
  modelSteps: z.number().int(),
  promptChars: z.number().int(),
  diagnosis: Diagnosis.nullable(),
  /** Fixes left out because they broke a rule (stating the person's technical level). */
  dropped: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type CaseDiagnosis = z.infer<typeof CaseDiagnosis>;

/** The most a diagnosis prompt may hold (characters); past it, the trace is clipped harder. */
const MAX_PROMPT = 260_000;

/** The ground truth, hand-written next to this file. */
const MECHANISMS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'mechanisms.md'), 'utf8');

/** A fix that states or assumes how technical the person is (never allowed). */
const TECHNICAL = /\b(non-?technical|not technical|technical (level|ability|skill|background)|tech-savvy|less technical)\b/i;

const INSTRUCTIONS = `You are a diagnostician for an AI assistant app. You read, step by step, exactly what a chat model was shown and what it did while serving one person's request. You work out why it went the way it did, and you propose exact changes to the text and behaviour the app gives the model.

## The model you are judging

It is a capable general model. It knows how to call tools (functions with JSON arguments). It knows NOTHING about this app: it never read this app's documentation, and it does not know the app's words ("fn", "kind", "system", "context", "gin", "instance", "payload", "saved query", "widget") unless its prompt explained them. Everything it knows about the app comes from what is in front of it at that step:
- the system prompt,
- the tool list: each tool's name, description and JSON schema,
- the messages, including blocks the app adds to the person's message (such as <local_time>),
- the results of its own earlier tool calls (search results, loaded guides, errors).
If a fact is not on that page, the model does not know it. Judge each step only by what was on the page at that step.

## What you have that it didn't

- "What the app offers": a true description of the app (below). Use it to see what the right move was.
- The hub's inventory: every system, fn kind and built-in fn of this hub, by name.
- The request, its Good line (what a strong result looks like), notes on what it should use, what the person privately knew, how it ended and the judge's verdict.
- The trace: each LLM step in order. Step 1 shows the system prompt and every tool definition in full; later steps show only what was new (system prompt changes, tools added or removed, new messages, tool results) and then what the model answered. Some steps are "the agent inside <fn>": a helper agent a tool runs, with its own prompt; judge it the same way.

## How to work

1. Read the request, the Good line and the verdict. Work out the ideal path, using only what the app really has (check the inventory; never invent a tool).
2. Read step 1 as that newcomer model would, before anything else happens. Note every app word it is given without an explanation (for example "fn", "context", "kind", "instance", "saved query", "widget", "gin"), and what it would need to be told to take the ideal path: which system does what, that some systems can write and save a new fn (a form, a query, a widget, a program) that can be run again, the difference between a form and a plain question, and what the app cannot do. Each such gap that hurt this case belongs in the steps (at the step where it hurt) and in the fixes.
3. Walk the steps in order. At every step where the model chose something (which tool, which arguments, whether to ask the person and how, what to tell them, when to stop), ask:
   "Given only what was in this prompt at this step, would a model that knows generic tool calling but nothing about this app know the right move here?"
   File the step with one "why":
   - fine: it did the right thing.
   - model-error: the information it needed was clearly in front of it and it still went wrong.
   - missing-info: what it needed to know was nowhere in its prompt (for example nothing told it that a reusable form exists for logging things).
   - misleading-info: something in its prompt pointed the wrong way (a search that ranked unrelated developer documents first, a description that suggests the wrong tool, an error message that sends it the wrong way).
   - jargon-unexplained: its prompt relied on an app word it can't be expected to understand, never explained.
   - wrong-mechanism: the app has the right tool and the model could know of it, but it used another (a plain question instead of a form, writing out a chart instead of a widget).
   - mechanism-missing: the app has nothing that does what is needed.
   - mechanism-too-hard: the right tool exists but is too hard to use correctly from what it was given (a huge schema, a nested format with no example, a multi-step dance nobody described).
   - tool-bug: a tool misbehaved, returned something wrong or unhelpful, or its error didn't say how to fix the call. Before you call a rejected call a bug, compare its exact arguments with the tool's schema in the trace: a call that doesn't fit the schema is not a bug in the validator (the cause is then whatever made the shape hard to get right). Something the person failed to answer is not a tool bug unless the trace shows the tool broke.
   List every step that went wrong or decided something important, plus the first and the last step. Routine steps may be skipped.
   Every "did" must hold a short quote from the trace at that step (the tool call's name and key arguments, or the words the model wrote) so it can be checked. Never say a search or result showed something unless that text is in the trace at or before that step; if you can't find it, say it was absent.
   Read every tool result the model acted on for words that told it what to do next ("go on", "don't wait", "try again", an example, an error's advice). When such words steered it wrong, quote them: that is misleading-info (or tool-bug), and the fix replaces those words.
3b. Audit the model's messages to the person. List each claim of fact or of action in them (a date, a price, a link, "I checked…", "I saved…", "I set up…") and find the tool result that backs it. A claim no tool result backs (a link that appears in no result, "I checked the pages" when no page was read) is the worst failure in a case, whatever the judge said: file the step that wrote it as model-error unless the prompt invited it, and add a fix (usually system-prompt) that makes the rule plain: say only what tool results show, and say what was not checked.
4. rootCause: one paragraph. Name the step numbers, quote the exact text that was missing, misleading or confusing (or say exactly what was absent), and explain how that led to the outcome. If the case went well, say what made it work.
5. fixes: 2 to 6 changes, the most useful first (fix the earliest cause in the chain before its consequences). Every step you filed as anything but fine must be covered by at least one fix; list the steps a fix covers in its "steps". Each changes ONE place ("where"):
   - system-prompt: the core of the chat agent's system prompt (shown in full at step 1): what is true of every chat whatever is installed.
   - systems-list: the <systems> block inside that prompt (one line per system).
   - context:<key> also names an injected item: after the core, the system prompt holds sections under a "## Title" heading (the hub's own, such as hub/asking or hub/saved_fns, and each system's, such as input/basics or database/basics); each is a context item injected into the prompt, so fix one by its key. What one system should say goes in that system's item, never in the core.
   - tool-description:<fn>: one tool's description, by its qualified name: the tool's name with its first __ written / and any later __ written . (tool-description:database/create_table for the tool database__create_table).
   - fn-instructions:<fn>: the longer usage text of a fn, shown when it is loaded or looked at.
   - kind-instructions:<kind>: the text that explains a fn kind (kind-instructions:input/form).
   - context:<key>: a guide or group the model can load (context:input/guide), or a new one you name.
   - suggestions: which tools or guides the app suggests along with the person's message.
   - hub-behaviour: something the app's code should do differently (search ranking, an error message, a default).
   - new-mechanism: something the app lacks.
   "problem": what was wrong, quoting the prompt where it helps.
   "proposedText": the exact words to add or to replace with, ready to paste, written for a model that knows nothing about this app: plain words, explain each app word the first time, say when to use it and when not to, and give a tiny example when a call's shape is tricky. For hub-behaviour and new-mechanism, describe the concrete change instead.
   "confidence": 0 to 1, how likely this fix alone would have made this case go right.

## Rules

- Be specific: real step numbers, real tool names from the trace or the inventory, quoted text. Advice like "improve the prompt", "add more guidance" or "be clearer" is worthless.
- Write proposedText for every request of this kind, not this one person: it goes into a prompt that serves everyone. Use this case's details only as a labelled example ("for example, logging grocery trips"). Don't push one pattern onto every case (not every log needs a form and a chart): say when it fits.
- Never propose telling the model how technical the person is, or to assume they are or aren't technical. Nobody knows who the person is. Plain wording to the person is fine without saying why.
- Never present a tool that doesn't exist as if it did; a needed one is a new-mechanism fix.
- Prefer fixing what the model was told over blaming the model. Use model-error only when the information was clearly there.
- For a request the app can't fully do (for example anything that must happen later on its own), good means saying so plainly and building the closest thing.

Answer with only one JSON object:
{"steps": [{"step": <number>, "did": "what it did", "should": "what it should have done", "why": "${STEP_CAUSES.join('" | "')}"}], "rootCause": "one paragraph", "fixes": [{"where": "...", "steps": [<step numbers>], "problem": "...", "proposedText": "...", "confidence": 0.0}]}

# What the app offers

${MECHANISMS}`;

/** The case's request and facts, the judge's view and the transcript, ahead of the trace. */
function caseBrief(judged: JudgedCase): string {
  const played = CASES.find((c) => c.id === judged.case);
  const j = judged.judgement;
  return [
    `# Case ${judged.case}: ${judged.title} (rep ${judged.rep})`,
    `Request, as the person typed it: ${played?.steps.map((step, i) => `${i + 1}. "${step.say}"${step.newChat === true ? ' (in a new chat)' : ''}${step.whileRunning === true ? ' (sent while the previous turn still ran)' : ''}${step.files === undefined ? '' : ` [attached: ${step.files.join(', ')}]`}`).join(' ') ?? judged.title}`,
    `Good (what a strong result looks like): ${judged.good}`,
    `What it should end up using: ${played?.notes ?? '—'}`,
    `What the person privately knew (said only when asked): ${played?.facts.join(' ') || 'nothing special'} They were after: ${played?.wants ?? '—'}`,
    `How it ended: ${judged.ending.by} — ${judged.ending.reason}`,
    j === null ? `Judge: none (${judged.judgeError ?? '—'})` : `Judge: ${j.verdict} ${j.score}/10. ${j.summary}\nWent well: ${j.wentWell.join('; ') || '—'}\nWent wrong: ${j.wentWrong.join('; ') || '—'}${j.cause === null ? '' : `\nJudge's cause: ${j.cause}; fix: ${j.fix}`}`,
    `Code checks: ${judged.checks.map((c) => `${c.ok ? 'ok' : 'FAILED'} ${c.name} (${c.detail})`).join('; ')}`,
    `## Transcript (what the person saw, with each tool run in short)\n\n${clip(transcriptMarkdown(judged, 'short'), 30_000)}`,
  ].join('\n\n');
}

/** A case rep's diagnosis file, from its rep folder. */
export function diagnosisFile(repFolder: string, caseId: number): string {
  return join(repFolder, 'cases', `case-${String(caseId).padStart(2, '0')}.diagnosis.json`);
}

/** A saved diagnosis, if any. */
export function loadDiagnosis(repFolder: string, caseId: number): CaseDiagnosis | undefined {
  const file = diagnosisFile(repFolder, caseId);
  return existsSync(file) ? CaseDiagnosis.parse(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
}

/** Diagnose one judged case rep from its rep folder's hub database, and save it. */
export async function diagnoseCase(router: OpenRouter, model: string, repFolder: string, judged: JudgedCase): Promise<CaseDiagnosis> {
  const base = { iteration: judged.iteration, rep: judged.rep, ...(judged.variant === undefined ? {} : { variant: judged.variant }), case: judged.case, title: judged.title, model, diagnosedAt: new Date().toISOString() };
  let saved: CaseDiagnosis;
  try {
    if (judged.ending.by === 'harness-crash') { throw new Error('the harness crashed while it ran; nothing to diagnose'); }
    const db = openHubDb(judged.stack === undefined ? repFolder : join(repFolder, judged.stack));
    let view;
    let tools;
    try {
      view = modelView(db, judged.sessions.map((s) => s.id));
      tools = inventory(db, judged.person.email);
    } finally {
      db.close();
    }
    const brief = caseBrief(judged);
    let prompt = '';
    for (const limits of LIMIT_STEPS) {
      prompt = [brief, `## The hub's inventory\n\n${tools}`, `## The trace: what the model saw and did, step by step (${view.steps.length} steps)\n\n${view.render(limits)}`].join('\n\n');
      if (prompt.length <= MAX_PROMPT) { break; }
    }
    if (prompt.length > MAX_PROMPT) { prompt = `${prompt.slice(0, MAX_PROMPT / 2)}\n\n[… ${prompt.length - MAX_PROMPT} characters of the trace cut …]\n\n${prompt.slice(-MAX_PROMPT / 2)}`; }
    // three tries: a long diagnosis sometimes slips one field (a step with no "should"), and the problem is told back
    const { value, cost } = await router.json(model, Diagnosis, [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: prompt }], { tries: 3 });
    const dropped = value.fixes.filter((f) => TECHNICAL.test(`${f.problem} ${f.proposedText}`)).map((f) => `${f.where}: ${clip(f.proposedText, 200)}`);
    const diagnosis = { ...value, fixes: value.fixes.filter((f) => !TECHNICAL.test(`${f.problem} ${f.proposedText}`)) };
    saved = { ...base, cost, modelSteps: view.steps.length, promptChars: prompt.length, diagnosis, dropped };
  } catch (error) {
    saved = { ...base, cost: 0, modelSteps: 0, promptChars: 0, diagnosis: null, dropped: [], error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(diagnosisFile(repFolder, judged.case), `${JSON.stringify(saved, null, 2)}\n`);
  return saved;
}

/** A case rep's "Diagnosis" section, for its markdown file. */
export function diagnosisMarkdown(saved: CaseDiagnosis): string {
  const d = saved.diagnosis;
  if (d === null) { return `## Diagnosis\n\nNone: ${saved.error ?? 'not diagnosed'}`; }
  return [
    `## Diagnosis`,
    `_${saved.model}, ${saved.modelSteps} model steps read, ${usd(saved.cost)}._`,
    `**Root cause:** ${d.rootCause}`,
    `**Steps:**\n${d.steps.map((s) => `- ${s.step}. **${s.why}** — did: ${s.did}${s.why === 'fine' ? '' : ` · should: ${s.should}`}`).join('\n') || '- —'}`,
    `**Fixes:**\n${d.fixes.map((f, i) => `${i + 1}. \`${f.where}\` (confidence ${f.confidence.toFixed(2)}${f.steps.length === 0 ? '' : `, steps ${f.steps.join(', ')}`}): ${f.problem}\n\n   > ${f.proposedText.split('\n').join('\n   > ')}`).join('\n\n') || '- —'}`,
    saved.dropped.length === 0 ? '' : `_Left out (they stated the person's technical level): ${saved.dropped.join(' · ')}_`,
  ].filter((part) => part !== '').join('\n\n');
}

// ── The iteration's aggregate ──

/** A case rep a fix came from (and its variant folder, in a run of several variants). */
export const Origin = z.object({ case: z.number().int(), rep: z.number().int(), variant: z.string().optional() });
export type Origin = z.infer<typeof Origin>;

/** One merged fix of the aggregate. */
export const MergedFix = z.object({
  where: z.string(),
  problem: z.string(),
  proposedText: z.string(),
  confidence: z.number(),
  /** The case reps it came from. */
  from: z.array(Origin),
});
export type MergedFix = z.infer<typeof MergedFix>;

/** The variants a fix came from, in order. */
export const fixVariants = (fix: MergedFix): string[] => [...new Set(fix.from.flatMap((f) => (f.variant === undefined ? [] : [f.variant])))].sort();

/** The iteration's diagnosis, as saved in `diagnosis.json`. */
export const IterationDiagnosis = z.object({
  iteration: z.string(),
  writtenAt: z.string(),
  model: z.string(),
  diagnosed: z.number().int(),
  failed: z.array(Origin.extend({ error: z.string() })),
  /** Every diagnosed step's cause, counted (fine included). */
  causes: z.record(z.string(), z.number()),
  /** A run of several variants: per variant, the case reps diagnosed and their step causes counted. */
  byVariant: z.array(z.object({ variant: z.string(), diagnosed: z.number().int(), failed: z.number().int(), causes: z.record(z.string(), z.number()), cost: z.number() })).default([]),
  fixes: z.array(MergedFix),
  /** Each group's merge, kept by a hash of its input so an unchanged group isn't merged again. */
  merges: z.array(z.object({ where: z.string(), hash: z.string(), fixes: z.array(MergedFix), cost: z.number() })),
  /** What every diagnosis cost, and the merges. */
  cost: z.object({ cases: z.number(), merge: z.number() }),
  rootCauses: z.array(Origin.extend({ title: z.string(), rootCause: z.string() })),
});
export type IterationDiagnosis = z.infer<typeof IterationDiagnosis>;

/** Every saved diagnosis of an iteration: its own reps' and each variant folder's (`<variant>/rep-<n>/`). */
export function loadDiagnoses(iterationFolder: string): CaseDiagnosis[] {
  const found: CaseDiagnosis[] = [];
  const places = [{ dir: iterationFolder, variant: undefined as string | undefined }, ...VARIANT_NAMES.filter((v) => existsSync(join(iterationFolder, v))).map((v) => ({ dir: join(iterationFolder, v), variant: v as string | undefined }))];
  for (const { dir: base, variant } of places) {
    for (const rep of readdirSync(base).filter((n) => /^rep-\d+$/.test(n))) {
      const dir = join(base, rep, 'cases');
      if (!existsSync(dir)) { continue; }
      for (const file of readdirSync(dir).filter((n) => n.endsWith('.diagnosis.json'))) {
        const saved = CaseDiagnosis.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        found.push(variant === undefined ? saved : { ...saved, variant });
      }
    }
  }
  return found.sort((a, b) => a.case - b.case || (a.variant ?? '').localeCompare(b.variant ?? '') || a.rep - b.rep);
}

/** A diagnosis's origin. */
const originOf = (d: Pick<CaseDiagnosis, 'case' | 'rep' | 'variant'>): Origin => ({ case: d.case, rep: d.rep, ...(d.variant === undefined ? {} : { variant: d.variant }) });

/** What the merge model answers for one group. */
const Merged = z.object({
  fixes: z.array(z.object({ from: z.array(z.coerce.number().int().min(1)).min(1), problem: z.string().min(1), proposedText: z.string().min(1), confidence: Fix.shape.confidence })),
});

const MERGE_INSTRUCTIONS = `Several fixes were proposed for the same place in an AI assistant app's prompts or behaviour, each from a different failed conversation. Merge the ones that say the same thing (the same problem, even if worded differently) into one fix whose proposedText keeps every concrete detail that matters, written for a model that knows nothing about this app. Keep fixes that say different things apart. Never add a statement about how technical the person is.
Every input fix number must appear in exactly one output fix's "from".
Answer with only one JSON object: {"fixes": [{"from": [input numbers], "problem": "...", "proposedText": "...", "confidence": 0.0}]}`;

/** One fix as it stands alone (no merge). */
const single = (fix: Fix, origin: Origin, where: string): MergedFix => ({ where, problem: fix.problem, proposedText: fix.proposedText, confidence: fix.confidence, from: [origin] });

/** A case rep as the merge model and the markdown name it. */
const originName = (origin: Origin): string => `case ${origin.case}${origin.variant === undefined ? '' : ` ${origin.variant}`} rep ${origin.rep}`;

/** Merge one group's fixes with the model; on failure, keep them apart. */
async function mergeGroup(router: OpenRouter | undefined, model: string, where: string, items: readonly { fix: Fix; origin: Origin }[]): Promise<{ fixes: MergedFix[]; cost: number }> {
  const apart = { fixes: items.map((i) => single(i.fix, i.origin, where)), cost: 0 };
  if (router === undefined || items.length < 2) { return apart; }
  const list = items.map((i, n) => `${n + 1}. (${originName(i.origin)}, confidence ${i.fix.confidence}) problem: ${i.fix.problem}\n   proposedText: ${i.fix.proposedText}`).join('\n\n');
  try {
    const { value, cost } = await router.json(model, Merged, [{ role: 'system', content: MERGE_INSTRUCTIONS }, { role: 'user', content: `Place: ${where}\n\n${list}` }], { tries: 3 });
    const used = new Set<number>();
    const fixes: MergedFix[] = [];
    for (const merged of value.fixes) {
      const members = [...new Set(merged.from)].filter((n) => n <= items.length && !used.has(n));
      if (members.length === 0) { continue; }
      for (const n of members) { used.add(n); }
      const origins = members.flatMap((n) => { const item = items[n - 1]; return item === undefined ? [] : [item.origin]; });
      fixes.push({ where, problem: merged.problem, proposedText: merged.proposedText, confidence: merged.confidence, from: origins });
    }
    // anything the merge left out stays on its own
    items.forEach((item, n) => { if (!used.has(n + 1)) { fixes.push(single(item.fix, item.origin, where)); } });
    return { fixes, cost };
  } catch {
    return apart;
  }
}

/** Every diagnosed step's cause, counted. */
function countCauses(diagnoses: readonly CaseDiagnosis[]): Record<string, number> {
  const causes: Record<string, number> = {};
  for (const saved of diagnoses) {
    for (const step of saved.diagnosis?.steps ?? []) { causes[step.why] = (causes[step.why] ?? 0) + 1; }
  }
  return causes;
}

/**
 * Merge every diagnosis of an iteration into `diagnosis.json` and `diagnosis.md`; unchanged groups reuse their merge.
 * With several variants, fixes are merged across them (the same fix found in both is one fix), each keeps the variants
 * it came from, and the causes are counted per variant too, so the markdown can say which fixes only one variant needs.
 */
export async function aggregate(iterationFolder: string, iteration: string, router: OpenRouter | undefined, model: string, force = false): Promise<{ path: string; result: IterationDiagnosis }> {
  const diagnoses = loadDiagnoses(iterationFolder);
  const jsonFile = join(iterationFolder, 'diagnosis.json');
  const before = !force && existsSync(jsonFile) ? IterationDiagnosis.safeParse(JSON.parse(readFileSync(jsonFile, 'utf8'))) : undefined;
  const cached = new Map((before?.success === true ? before.data.merges : []).map((m) => [`${m.where}:${m.hash}`, m]));
  const groups = new Map<string, { fix: Fix; origin: Origin }[]>();
  for (const saved of diagnoses) {
    for (const fix of saved.diagnosis?.fixes ?? []) {
      const where = fix.where.toLowerCase();
      groups.set(where, [...(groups.get(where) ?? []), { fix, origin: originOf(saved) }]);
    }
  }
  const merges: IterationDiagnosis['merges'] = [];
  for (const [where, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const hash = createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 16);
    const hit = cached.get(`${where}:${hash}`);
    if (hit !== undefined) { merges.push(hit); continue; }
    const { fixes, cost } = await mergeGroup(router, model, where, items);
    merges.push({ where, hash, fixes, cost });
  }
  const fixes = merges.flatMap((m) => m.fixes).sort((a, b) => repsOf(b) - repsOf(a) || b.confidence - a.confidence);
  const variants = [...new Set(diagnoses.flatMap((d) => (d.variant === undefined ? [] : [d.variant])))].sort();
  const result: IterationDiagnosis = {
    iteration, writtenAt: new Date().toISOString(), model,
    diagnosed: diagnoses.filter((d) => d.diagnosis !== null).length,
    failed: diagnoses.filter((d) => d.diagnosis === null).map((d) => ({ ...originOf(d), error: d.error ?? '—' })),
    causes: countCauses(diagnoses),
    byVariant: variants.length < 2 ? [] : variants.map((variant) => {
      const of = diagnoses.filter((d) => d.variant === variant);
      return { variant, diagnosed: of.filter((d) => d.diagnosis !== null).length, failed: of.filter((d) => d.diagnosis === null).length, causes: countCauses(of), cost: of.reduce((sum, d) => sum + d.cost, 0) };
    }),
    fixes, merges,
    cost: { cases: diagnoses.reduce((sum, d) => sum + d.cost, 0), merge: merges.reduce((sum, m) => sum + m.cost, 0) },
    rootCauses: diagnoses.flatMap((d) => (d.diagnosis === null ? [] : [{ ...originOf(d), title: d.title, rootCause: d.diagnosis.rootCause }])),
  };
  writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`);
  const path = join(iterationFolder, 'diagnosis.md');
  writeFileSync(path, `${iterationDiagnosisMarkdown(result)}\n`);
  return { path, result };
}

/** How many distinct case reps a fix came from. */
const repsOf = (fix: MergedFix): number => new Set(fix.from.map((f) => `${f.case}:${f.variant ?? ''}:${f.rep}`)).size;

/** A case rep's markdown file, from the iteration folder. */
const caseLink = (origin: Origin): string => `[${origin.case}/${origin.variant === undefined ? '' : `${origin.variant}/`}r${origin.rep}](${origin.variant === undefined ? '' : `${origin.variant}/`}rep-${origin.rep}/cases/case-${String(origin.case).padStart(2, '0')}.md)`;

/** The iteration's diagnosis as markdown: step causes, then the fixes ranked, then each case rep's root cause. */
export function iterationDiagnosisMarkdown(result: IterationDiagnosis): string {
  const causes = Object.entries(result.causes).sort(([, a], [, b]) => b - a);
  const several = result.byVariant.length > 1;
  const names = result.byVariant.map((v) => v.variant);
  /** Which variants need a fix, as its heading says it. */
  const need = (fix: MergedFix): string => {
    if (!several) { return ''; }
    const from = fixVariants(fix);
    return from.length === names.length ? ' — both variants' : ` — **only ${from.join(', ')}**`;
  };
  const causeTable = several
    ? ['| cause | all | ' + names.join(' | ') + ' |', `|---|---|${names.map(() => '---|').join('')}`, ...causes.map(([cause, n]) => `| ${cause} | ${n} | ${result.byVariant.map((v) => v.causes[cause] ?? 0).join(' | ')} |`)].join('\n')
    : ['| cause | steps |', '|---|---|', ...causes.map(([cause, n]) => `| ${cause} | ${n} |`)].join('\n');
  const onlyOne = several ? names.map((variant) => ({ variant, fixes: result.fixes.filter((f) => { const from = fixVariants(f); return from.length === 1 && from[0] === variant; }) })) : [];
  return [
    `# Diagnosis: ${result.iteration}`,
    `Written ${result.writtenAt} by ${result.model} from ${result.diagnosed} case rep(s): what the chat model was shown at every step, and why it did what it did. Cost ${usd(result.cost.cases + result.cost.merge)} (cases ${usd(result.cost.cases)}, merging ${usd(result.cost.merge)}).${result.failed.length === 0 ? '' : ` Not diagnosed: ${result.failed.map((f) => `${f.case}/${f.variant === undefined ? '' : `${f.variant}/`}r${f.rep} (${clip(f.error, 120)})`).join(', ')}.`}`,
    ...(several ? [
      `Variants: ${result.byVariant.map((v) => `${v.variant} ${v.diagnosed} diagnosed${v.failed === 0 ? '' : `, ${v.failed} not`} (${usd(v.cost)})`).join('; ')}. Fixes are merged across variants; each says whether both variants' cases asked for it or only one's.`,
      `**Fixes only one variant needs:** ${onlyOne.map((o) => `${o.variant}: ${o.fixes.length === 0 ? 'none' : o.fixes.map((f) => `#${result.fixes.indexOf(f) + 1} \`${f.where}\``).join(', ')}`).join(' · ')}.`,
    ] : []),
    '## Why each step went the way it did',
    causes.length === 0 ? '_none_' : causeTable,
    '## Fixes, ranked by how many case reps they would help',
    ...result.fixes.map((fix, i) => [
      `### ${i + 1}. \`${fix.where}\` — ${repsOf(fix)} case rep(s), confidence ${fix.confidence.toFixed(2)}${need(fix)}`,
      `From ${fix.from.map(caseLink).join(', ')}.`,
      `**Problem:** ${fix.problem}`,
      `**Proposed:**\n\n> ${fix.proposedText.split('\n').join('\n> ')}`,
    ].join('\n\n')),
    '## Root cause of each case rep',
    ...result.rootCauses.map((r) => `- **${caseLink(r)} ${r.title}:** ${r.rootCause}`),
  ].join('\n\n');
}
