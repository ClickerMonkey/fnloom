/**
 * Household variants (`--variants off,on`): one named setup of the hub's decision models, applied by the admin after
 * go-live through the hub's own admin API, the way an admin sets them in Settings. Phil (2026-11-22): "let's try these
 * scenarios with decision models on and off and see how the results differ."
 *
 * - `off`: no decision models. Suggestions chooser `none` (the top K by similarity at or over the threshold), the fns
 *   and context search decisions `none`, and the decide role unset.
 * - `on`: the decide role set to the decision model (`HARNESS_SCENARIOS_DECISION_MODEL`, GPT-6 Luna Decisions), the
 *   suggestions chooser `decision` (it uses the decide role's model), and `hubOptions.fnsSearchDecision` and
 *   `hubOptions.contextSearchDecision` set to the decision model, so `hub/fns_search` and `hub/ctx_search` hits are
 *   filtered by it (each search by its own decision).
 * - `load`: as `on`, with each chooser's action `load` (Phil, 2026-11-22: "options to not only allow a decision model
 *   or llm to suggest context or fns but actually have them automatically add them"): what the suggestions chooser
 *   picks is loaded for the turn (fns into the tools, context into the message), and `hub/fns_search` and
 *   `hub/ctx_search` load the best kept hits.
 *
 * Before any stack boots, an `on` run proves the model answers (`proveDecisionModel`: one tiny decide call through
 * aeye's OpenRouter provider, as the hub makes it). After applying `on`, the rep reads every setting back and asks the
 * hub for a suggestions preview: a preview the decision model failed on stops the rep, so `on` never silently runs as
 * `off`; for `load` the preview must also say its picks load (`action: 'load'`, at least one item `load: 'loaded'`).
 */
import { AI } from '@aeye/ai';
import { models } from '@aeye/models';
import { OpenRouterProvider } from '@aeye/openrouter';
import { hubWebSpec } from '@harness/core';
import { z } from 'zod';
import type { SignedIn } from '../hub-client.ts';

export const VARIANT_NAMES = ['off', 'on', 'load'] as const;
export const VariantName = z.enum(VARIANT_NAMES);
export type VariantName = z.infer<typeof VariantName>;

/** `--variants off,on,load` as a list (default `off` alone, as iteration 1 ran). */
export function parseVariants(list: string | undefined): VariantName[] {
  if (list === undefined || list.trim() === '') { return ['off']; }
  const names = list.split(',').map((name) => VariantName.parse(name.trim()));
  return [...new Set(names)];
}

/** What a rep's variant was, as `rep.json` keeps it. */
export const VariantRecord = z.object({
  name: VariantName,
  /** The decision model (`on` and `load`). */
  model: z.string().optional(),
  /** Each setting as the hub read it back after it was applied. */
  applied: z.record(z.string(), z.unknown()),
  /** The hub's suggestions preview after applying (`on`, `load`): who decided, how many model calls, any failure, and (`load`) how many picks load. */
  proof: z.object({ by: z.string(), calls: z.number().int(), used: z.number().int(), failed: z.number().int(), loaded: z.number().int().optional(), text: z.string() }).optional(),
  /** What the variant couldn't set (an option the hub doesn't have yet), said plainly. */
  notes: z.array(z.string()).default([]),
});
export type VariantRecord = z.infer<typeof VariantRecord>;

/** The words a variant reads as in reports. */
export const VARIANT_LABELS: Record<VariantName, string> = {
  off: 'decision models off',
  on: 'decision models on',
  load: 'decision models on, loading what they pick',
};

/** The hub's web endpoints by name, to check before a run that the options a variant sets exist. */
const ENDPOINTS = (hubWebSpec as unknown as { endpoints: Record<string, unknown> }).endpoints;

/** The two search decisions (`hubOptions.fnsSearchDecision`, `.contextSearchDecision`), by the item kind they filter. */
const SEARCH_ITEMS = ['fn', 'context'] as const;

/**
 * Fail loudly, before anything boots, when a variant needs a hub option this hub doesn't have: `on` and `load` set the
 * search decisions (`setSearchDecision`, docs/plans/iteration-2-2026-11-22.md item 1) and the suggestions chooser.
 */
export function checkVariantSupport(variants: readonly VariantName[]): void {
  const using = variants.filter((name) => name !== 'off');
  if (using.length === 0) { return; }
  const missing = ['setSearchDecision', 'searchDecisions', 'setSuggestDecision', 'previewSuggestions', 'setModelRole'].filter((name) => !(name in ENDPOINTS));
  if (missing.length > 0) {
    throw new Error(`the "${using.join('", "')}" variant needs the hub's admin endpoints ${missing.join(', ')} (packages/core/src/web.ts), and this hub has none of them; run --variants off`);
  }
}

/** Apply a variant to a fresh household's hub, read every setting back, and (for `on` and `load`) prove the decision model answers. */
export async function applyVariant(admin: SignedIn, name: VariantName, decisionModel: string, log: (line: string) => void): Promise<VariantRecord> {
  const notes: string[] = [];
  // the decide role takes a model choice; the suggestions chooser and the searches take a role model (choice, provider)
  const choice = { model: decisionModel };
  const model = { model: { model: choice } };
  // `load` loads what each chooser picks; `on` suggests it, as the hub does by default
  const action = name === 'load' ? { action: 'load' as const } : {};
  if (name === 'off') {
    await admin.hub.call('clearModelRole', { role: 'decide' });
    await admin.hub.call('setSuggestDecision', { by: 'none' });
    for (const item of SEARCH_ITEMS) { await admin.hub.call('setSearchDecision', { item, value: { by: 'none' } }); }
  } else {
    await admin.hub.call('setModelRole', { role: 'decide', model: choice });
    // the suggestions chooser and both searches name the model too, so the record says what each uses
    await admin.hub.call('setSuggestDecision', { by: 'decision', ...model, ...action });
    for (const item of SEARCH_ITEMS) { await admin.hub.call('setSearchDecision', { item, value: { by: 'decision', ...model, ...action } }); }
  }
  // what the hub holds now, as an admin's Settings page shows it
  const search = await admin.hub.call('searchDecisions', {});
  const applied: Record<string, unknown> = {
    decideRole: (await admin.hub.call('modelRoles', {})).find((role) => role.role === 'decide') ?? null,
    suggestDecision: (await admin.hub.call('suggestDecision', {})).value,
    fnsSearchDecision: search.fn.value,
    contextSearchDecision: search.context.value,
  };
  const expected = name === 'off' ? 'none' : 'decision';
  const expectedAction = name === 'load' ? 'load' : 'suggest';
  const wrong = [['suggestDecision', applied['suggestDecision']], ['fnsSearchDecision', search.fn.value], ['contextSearchDecision', search.context.value]]
    .filter(([, value]) => {
      const read = value as { by?: string; action?: string } | undefined;
      return read?.by !== expected || (name !== 'off' && (read.action ?? 'suggest') !== expectedAction);
    }).map(([key]) => key);
  if (wrong.length > 0) { throw new Error(`the "${name}" variant didn't take: ${wrong.join(', ')} read back as not "${expected}"${name === 'off' ? '' : ` with action "${expectedAction}"`} (${JSON.stringify(applied)})`); }
  const record: VariantRecord = { name, ...(name === 'off' ? {} : { model: decisionModel }), applied, notes };
  if (name === 'off') { log('variant off: no decision models (decide role unset, suggestions and both searches none)'); return record; }

  // the hub's own decision path, end to end: a preview of what this message would be offered
  const text = 'Can you add milk and eggs to our shopping list?';
  const session = await admin.hub.call('createSession', {});
  const preview = await admin.hub.call('previewSuggestions', { session: session.id, text });
  const failed = preview.items.filter((item) => !item.used && item.reason === 'failed').length;
  const loaded = preview.items.filter((item) => item.used && item.load === 'loaded').length;
  const proof = { by: preview.by, calls: preview.calls?.length ?? 0, used: preview.items.filter((item) => item.used).length, failed, ...(name === 'load' ? { loaded } : {}), text };
  if (preview.by !== 'decision' || failed > 0) {
    throw new Error(`the "${name}" variant is set, but the hub's suggestions preview didn't come from the decision model ${decisionModel} (by ${preview.by}, ${failed} item(s) marked failed); see the stack log's suggestions.decision.failed`);
  }
  // `load`: the preview must say the picks load, and at least one does, so `load` never silently runs as `on`
  if (name === 'load' && (preview.action !== 'load' || loaded === 0)) {
    throw new Error(`the "load" variant is set, but the hub's suggestions preview loads nothing (action ${preview.action ?? 'suggest'}, ${loaded} of ${proof.used} pick(s) to load for "${text}")`);
  }
  log(`variant ${name}: ${decisionModel} decides (decide role, suggestions, fns and context search${name === 'load' ? ', each loading what it picks' : ''}); preview: ${proof.calls} decision call(s), ${proof.used} of ${preview.items.length} candidate(s) kept${name === 'load' ? `, ${loaded} to load` : ''}`);
  return { ...record, proof };
}

/** What `proveDecisionModel` found. */
export interface DecisionProof {
  readonly model: string;
  readonly answers: Record<string, unknown>;
  readonly cost: number | undefined;
  readonly ms: number;
}

/**
 * One tiny decide call (two yes/no questions, a few hundred tokens) through aeye's OpenRouter provider, as the hub
 * makes it, so an `on` run fails in seconds, not after a stack boots, when the model can't be reached.
 */
export async function proveDecisionModel(apiKey: string, model: string): Promise<DecisionProof> {
  const openrouter = new OpenRouterProvider({ apiKey });
  const ai = AI.with().providers({ openrouter }).create({ models } as never);
  const started = Date.now();
  try {
    const response = await ai.decide.get({
      input: 'Mom: can you add milk and eggs to the shopping list?',
      questions: {
        list: { type: 'predicate', instructions: 'Does the person want something added to a list?' },
        weather: { type: 'predicate', instructions: 'Is the person asking about the weather?' },
      },
    }, { metadata: { model } } as never);
    return { model, answers: response.answers, cost: response.usage?.cost, ms: Date.now() - started };
  } catch (error) {
    throw new Error(`the decision model ${model} didn't answer a test decision through OpenRouter: ${error instanceof Error ? error.message.slice(0, 400) : String(error)}. Set HARNESS_SCENARIOS_DECISION_MODEL to one that does, or fix its provider.`, { cause: error });
  }
}
