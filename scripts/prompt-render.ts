/**
 * `npm run prompt:render`: the chat agents' real prompts, for review. Boots a fresh stack (`.harness-test/prompt-render/`,
 * port 4360) with the systems the scenario stacks run (hub, fs on a fake home outside any git repository, embedder,
 * a new SQLite database, input, widgets, code, api, and web-system when `TAVILY_API_KEY` is set), goes live with every
 * system as an admin does, waits for the index, then asks the hub for the request each chat agent would send for one
 * message (`previewPrompt`: the message enriched with the hub's and hooks' blocks, the planner's prompt, the aeye
 * request, no model called): `hub/chat` (tools mode) planned for the scenarios' chat model, and `hub/chat_small`
 * (static mode) planned both for that model and for a 2,048-token `qwen2.5:3b` as the hub plans an Ollama model (its
 * window, no thinking budget, a quarter of the window for the reply, the prompt margin).
 *
 * Writes `<agent>.md` per prompt (the system prompt, the tools as sent, the messages, the token table) and `report.md`
 * (the tables side by side, whether `hub/chat_small` fits 2k and what was cut, and two checks over the rendered text:
 * any fn spelled `system/name`, and any installable system the core text names). Stops the stack after.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFnShaped, mapConcurrent, QualifiedName, SystemName, type PromptPreview, type SessionId } from '@harness/core';
import { goLiveAll } from '../e2e/review.ts';
import { ROOT, startStack, type ComponentName } from './stack.ts';
import { loadSettings } from './scenarios/env.ts';
import { ADMIN, embedderAnswers, homeFolder, portTaken, waitForIndex } from './scenarios/rep.ts';
import type { DatabaseConfig } from '../systems/database/shared/shapes.ts';

const PORT = 4360;
const DATA = join(ROOT, '.harness-test', 'prompt-render');
const MESSAGE = 'I keep forgetting what I spend on groceries. Can you help me keep track?';
/** The small model, as the hub would plan it on Ollama with a 2k window. */
const SMALL = { model: 'qwen2.5:3b', limits: { contextWindow: 2048, maxOutputTokens: 512, reasoningTokens: 0, charsPerToken: 3.5 } } as const;
/** The same model with a window large enough to see every part at its own size (same estimator, same reply). */
const ROOMY = { model: SMALL.model, limits: { ...SMALL.limits, contextWindow: 16_384 } } as const;

const SCRATCH: DatabaseConfig = {
  label: 'Household', connection: { kind: 'sqlite-new', path: 'household.db' },
  data: 'read-write', schema: 'allowed', enrich: { on: false }, audience: { visibility: 'public', with: [] },
};

const log = (line: string): void => { process.stdout.write(`${line}\n`); };

/** One prompt to render. */
interface Target { readonly file: string; readonly agent: QualifiedName; readonly model?: string; readonly label: string }

async function main(): Promise<void> {
  const settings = loadSettings();
  if (await portTaken(PORT)) throw new Error(`something already listens on ${PORT}`);
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const home = homeFolder({ HARNESS_SCENARIOS_HOME_ROOT: join(tmpdir(), 'harness-prompt-render') }, 'prompt-render', 1, undefined, undefined);
  const embedder = await embedderAnswers(settings.HARNESS_SCENARIOS_EMBEDDER);
  const systems: ComponentName[] = ['hub', 'fs', 'database', 'input', 'widgets', 'code', 'api', ...(embedder ? ['embedder' as const] : []), ...(settings.TAVILY_API_KEY === undefined ? [] : ['web-system' as const])];
  log(`starting ${systems.join(', ')} on ${PORT}; home ${home}`);
  const stack = await startStack({
    port: PORT, data: DATA, admin: ADMIN, build: false, watch: false, timeout: settings.HARNESS_SCENARIOS_START_TIMEOUT, only: new Set(systems),
    systems: {
      fs: { roots: [{ name: 'home', path: home, writable: true, index: 'all' }], self: join(ROOT, 'systems', 'fs') },
      embedder: { url: settings.HARNESS_SCENARIOS_EMBEDDER },
      databases: { main: SCRATCH },
    },
    hubEnv: { HARNESS_LOG_FILES: 'false', HARNESS_DEFAULT_MODEL: settings.HARNESS_SCENARIOS_MODEL },
    output: () => undefined,
  });
  try {
    const { admin } = stack;
    log(`live: ${(await goLiveAll(admin)).join(', ')}`);
    if (embedder) await waitForIndex(admin, settings, log);
    await admin.hub.call('setModelLimits', SMALL);
    const targets: Target[] = [
      { file: 'hub-chat', agent: QualifiedName.parse('hub/chat'), label: `hub/chat, tools mode, ${settings.HARNESS_SCENARIOS_MODEL}` },
      { file: 'hub-chat_small', agent: QualifiedName.parse('hub/chat_small'), model: SMALL.model, label: `hub/chat_small, static mode, ${SMALL.model} at a 2,048-token window` },
      { file: 'hub-chat_small.luna', agent: QualifiedName.parse('hub/chat_small'), label: `hub/chat_small, static mode, ${settings.HARNESS_SCENARIOS_MODEL}` },
    ];
    const fns = await knownFns(admin);
    const keys = new Set([...await contextKeys(admin), ...storedKindsAndTypes()]);
    const systemNames = (await admin.hub.call('systems', {})).map((s): string => s.name);
    const sections: string[] = [];
    for (const target of targets) {
      const session = await admin.hub.call('createSession', { agent: target.agent });
      let preview: PromptPreview;
      try {
        preview = await previewOf(admin, session.id, target.model);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        log(`${target.label}: refused: ${why}`);
        if (target.model !== SMALL.model) { sections.push(`## ${target.label}\n\nThe planner refused it: ${why}`); continue; }
        // the parts at their own sizes, with the same model's estimator and reply, then what 2k leaves for them
        await admin.hub.call('setModelLimits', ROOMY);
        const roomy = await previewOf(admin, session.id, target.model);
        await admin.hub.call('setModelLimits', SMALL);
        writeFileSync(join(DATA, `${target.file}.md`), `${renderPrompt(`${target.label} (refused at 2,048; shown as planned at 16,384)`, roomy)}\n\n## Tokens\n\n${tokenTable(roomy)}\n`);
        writeFileSync(join(DATA, `${target.file}.json`), JSON.stringify(roomy, null, 2));
        sections.push(`## ${target.label}\n\nThe planner refuses it at 2,048: "${why}"\n\n${smallFit(roomy)}\n\nAs planned at a 16,384 window (same estimator, same 512-token reply):\n\n${tokenTable(roomy)}\n\n${check(roomy, fns, keys, systemNames)}`);
        continue;
      }
      const table = tokenTable(preview);
      writeFileSync(join(DATA, `${target.file}.md`), `${renderPrompt(target.label, preview)}\n\n## Tokens\n\n${table}\n`);
      writeFileSync(join(DATA, `${target.file}.json`), JSON.stringify(preview, null, 2));
      const checks = check(preview, fns, keys, systemNames);
      sections.push(`## ${target.label}\n\n${table}\n\n${checks}`);
      log(`wrote ${join(DATA, `${target.file}.md`)}: ${preview.estimate} tokens estimated of ${preview.window}`);
    }
    writeFileSync(join(DATA, 'report.md'), `# Chat prompts for "${MESSAGE}"\n\n${sections.join('\n\n')}\n`);
    log(`wrote ${join(DATA, 'report.md')}`);
  } finally {
    await stack.stop();
  }
}

/** Every fn the hub knows, by qualified name. */
async function knownFns(admin: Awaited<ReturnType<typeof startStack>>['admin']): Promise<Set<string>> {
  const systems = (await admin.hub.call('systems', {})).map((s) => s.name);
  // every system's fns asked at once, gathered in the systems' order
  const each = await mapConcurrent(['hub', ...systems], (system) => admin.hub.call('systemFns', { system: SystemName.parse(system) }).catch(() => [] /* a system with none */));
  return new Set(each.flat().map((fn) => fn.name));
}

/** Every context key the hub knows. */
async function contextKeys(admin: Awaited<ReturnType<typeof startStack>>['admin']): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await admin.hub.call('contexts', { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) keys.add(item.name);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return keys;
}

/** The kinds and types the hub stores (read from its database, read-only): with the context keys, they keep their `/`. */
function storedKindsAndTypes(): string[] {
  const db = new DatabaseSync(join(DATA, 'hub.sqlite'), { readOnly: true });
  try {
    return ['kinds', 'types'].flatMap((table) => db.prepare(`select name from ${table}`).all().map((row) => String(row['name'])));
  } finally {
    db.close();
  }
}

/** What a 2,048-token window leaves the prompt, against the fixed parts the planner must place whole. */
function smallFit(roomy: PromptPreview): string {
  const window = SMALL.limits.contextWindow;
  const margin = Math.max(64, Math.ceil(0.06 * window));
  const available = window - SMALL.limits.maxOutputTokens - margin;
  const [systems = 0] = roomy.counts;
  const tools = roomy.tools.reduce((sum, t) => sum + t.tokens, 0);
  const message = roomy.messages.reduce((sum, m) => sum + m.tokens, 0);
  const bare = roomy.parts.tokens.instructions + systems + roomy.parts.tokens.guide + tools;
  return [
    `A 2,048 window leaves ${available.toLocaleString('en-US')} tokens for the prompt (reply ${SMALL.limits.maxOutputTokens}, margin ${margin}).`,
    `The parts the planner places whole: core ${roomy.parts.tokens.instructions}, systems list ${systems}, mode guide ${roomy.parts.tokens.guide}, tools ${tools}: ${bare.toLocaleString('en-US')}, before the message (${message}).`,
    bare > available
      ? `So hub/chat_small does not fit 2k: the fixed part alone is ${(bare - available).toLocaleString('en-US')} over, the injected section gets no room (its share of what is left is 0, so every item is cut), and the message has nowhere to go, which is the refusal.`
      : `The fixed part fits with ${(available - bare).toLocaleString('en-US')} to spare.`,
  ].join(' ');
}

/** The preview, with the systems list and the rest of the context counted by the model's estimator. */
async function previewOf(admin: Awaited<ReturnType<typeof startStack>>['admin'], session: SessionId, model: string | undefined): Promise<PromptPreview> {
  const first = await admin.hub.call('previewPrompt', { session, text: MESSAGE, ...(model === undefined ? {} : { model }) });
  const pieces = split(first);
  const again = await admin.hub.call('previewPrompt', { session, text: MESSAGE, ...(model === undefined ? {} : { model }), count: [pieces.systems, pieces.rest] });
  return again;
}

/** The context after the instructions in its parts: the `<systems>` list, the guide, and whatever else follows. */
function split(preview: PromptPreview): { systems: string; rest: string } {
  const context = preview.parts.context;
  const systems = /<systems>[\s\S]*?<\/systems>/.exec(context)?.[0] ?? '';
  const rest = context.replace(systems, '').replace(preview.parts.guide, '').trim();
  return { systems, rest };
}

/** The prompt as the model gets it. */
function renderPrompt(label: string, preview: PromptPreview): string {
  const tools = preview.tools.map((tool) => `### ${tool.name}\n\n${tool.description}\n\n\`\`\`json\n${JSON.stringify(tool.parameters)}\n\`\`\``);
  const messages = preview.messages.map((m) => `### ${m.role}\n\n\`\`\`\`text\n${m.content}\n\`\`\`\``);
  return [
    `# ${label}`,
    `Planned for ${preview.model}: window ${preview.window.toLocaleString('en-US')}, reply reserve ${preview.maxTokens.toLocaleString('en-US')}, estimate ${preview.estimate.toLocaleString('en-US')} tokens. No model was called.`,
    `## System prompt\n\n\`\`\`\`text\n${preview.system}\n\`\`\`\``,
    `## Tools (${preview.tools.length})\n\n${tools.join('\n\n') || 'None (the toolset is described in the prompt).'}`,
    `## Messages\n\n${messages.join('\n\n')}`,
  ].join('\n\n');
}

/** The token table of one prompt: each part, the totals, the budget, and what was cut. */
function tokenTable(preview: PromptPreview): string {
  const { parts, report } = preview;
  const [systems = 0, rest = 0] = preview.counts;
  const injected = report.injected;
  const toolTokens = preview.tools.reduce((sum, t) => sum + t.tokens, 0);
  const messageTokens = preview.messages.reduce((sum, m) => sum + m.tokens, 0);
  const rows: Array<[string, number | string]> = [
    ['core instructions', parts.tokens.instructions],
    ['systems list', systems],
    ['mode guide', parts.tokens.guide],
    ...(injected?.items ?? []).map((item): [string, number] => [`injected: ${item.name} (${item.detail})`, item.tokens]),
    ['injected section, total', parts.tokens.injected],
    ['other context (cards, citations rule, tail)', rest],
    [`tools (${preview.tools.length})`, toolTokens],
    ...preview.tools.map((t): [string, number] => [`  tool ${t.name}`, t.tokens]),
    [`messages (${preview.messages.length})`, messageTokens],
    ['system message, whole', parts.tokens.system],
    ['request estimate (planner)', preview.estimate],
  ];
  const b = report.budget;
  const budget = `Window ${b.window.toLocaleString('en-US')}: reply ${b.output}, reasoning ${b.reasoning}, margin ${b.margin}, so ${(b.window - b.output - b.reasoning - b.margin).toLocaleString('en-US')} for the prompt; the estimate is ${preview.estimate.toLocaleString('en-US')} (${preview.estimate <= b.window - b.output - b.reasoning - b.margin ? 'fits' : 'does not fit'}).`;
  const cut = b.cut.length === 0 ? 'Nothing was cut.' : `Cut: ${b.cut.map((c) => `${c.what} (${c.why})`).join('; ')}.`;
  const left = (injected?.leftOut ?? []).length === 0 ? '' : `\n\nInjected items left out: ${(injected?.leftOut ?? []).map((l) => `${l.name} (${l.why}: ${l.reason})`).join('; ')}.`;
  return `| Part | Tokens |\n|---|---:|\n${rows.map(([part, n]) => `| ${part} | ${typeof n === 'number' ? n.toLocaleString('en-US') : n} |`).join('\n')}\n\n${budget} ${cut}${left}`;
}

/** The checks over the rendered text: fns spelled `system/name`, and installable systems the core names. */
function check(preview: PromptPreview, fns: ReadonlySet<string>, keys: ReadonlySet<string>, systems: readonly string[]): string {
  const text = [preview.system, ...preview.tools.flatMap((t) => [t.description, JSON.stringify(t.parameters)]), ...preview.messages.map((m) => m.content)].join('\n');
  const hits = new Map<string, number>();
  // a fn-shaped name of an installed system no fn holds (an example name: `isFnShaped`, the rule the hub spells them by);
  // context keys, kinds and types keep their `/`, as does an attribute's value that is no fn (a mention's provider)
  const other = new Map<string, number>();
  const installed = new Set([...systems, 'hub']);
  for (const match of text.matchAll(/(?<![\w/.:-])([a-z][a-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*)/g)) {
    const name = (match[1] ?? '').replace(/[.-]+$/, '');
    const parsed = QualifiedName.safeParse(name);
    const inAttribute = text.slice(Math.max(0, match.index - 2), match.index) === '="';
    if (fns.has(name)) hits.set(name, (hits.get(name) ?? 0) + 1);
    else if (parsed.success && !inAttribute && isFnShaped(parsed.data, installed, keys)) other.set(name, (other.get(name) ?? 0) + 1);
  }
  const named = systems.filter((s) => s !== 'hub').flatMap((system) => {
    const lines = preview.parts.instructions.split('\n').filter((line) => new RegExp(`(?<![\\w/-])${system}(?![\\w-])`).test(line));
    return lines.length === 0 ? [] : [`- \`${system}\`: ${lines.map((l) => `"${l.trim().slice(0, 160)}"`).join('; ')}`];
  });
  return [
    `Fns spelled \`system/name\` in the rendered prompt, tools and messages: ${hits.size === 0 ? 'none' : [...hits].map(([n, c]) => `\`${n}\` ×${c}`).join(', ')}.`,
    `Example fn names (fn-shaped, of an installed system, no fn holds them) still spelled \`system/name\`: ${other.size === 0 ? 'none' : [...other].map(([n, c]) => `\`${n}\` ×${c}`).join(', ')}.`,
    `Installable systems the core instructions name (word matches; \`input\` and \`web\` are also English words):${named.length === 0 ? 'none' : `\n${named.join('\n')}`}`,
  ].join('\n\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
