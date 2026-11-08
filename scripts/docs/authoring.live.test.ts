/**
 * Live: the authoring guide is enough to write a system. A free OpenRouter model gets only the `fs/system-authoring`
 * context's text (the guide and the template note) and "make a system with one fn that reverses text"; the contract and
 * implementation it writes must typecheck against the real SDK. It gets the compiler's errors back and may try twice
 * more. A model that is busy or refuses is skipped for the next. Run with `npm run test:live`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI } from '@aeye/ai';
import type { Message } from '@aeye/core';
import { models } from '@aeye/models';
import { OpenRouterProvider } from '@aeye/openrouter';
import { liveEnv, liveModels } from '@harness/sdk/server/testing';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { authoringText, PackagedAuthoring } from '../../systems/fs/server/authoring.ts';
import { DEFAULT_COMPILER_OPTIONS } from './extract.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** Inside the repository, so the generated files resolve `@harness/sdk` from its node_modules. */
const OUT = join(ROOT, '.harness-test', 'template-docs', 'live');
const FILES = ['shared/index.ts', 'server/impl.ts'] as const;
const TRIES = 3;

const ASK = [
  'Make a harness system named `reverse` with one native fn, `reverse`, that takes `{ text }` and returns the text reversed.',
  'Answer with exactly two fenced TypeScript code blocks and nothing else:',
  '1. the contract, whose first line is `// shared/index.ts`, exporting the contract as `reverse`;',
  '2. the implementation, whose first line is `// server/impl.ts`, exporting `createImpl()` that returns the',
  "   implementation typed `SystemImpl<(typeof reverse)['defs']>`, importing the contract from '../shared/index.ts'.",
  'Use only what the guide documents.',
].join('\n');

/** The two files in an answer, by path; missing ones are absent. */
function filesOf(answer: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of answer.matchAll(/```[a-z]*\r?\n\/\/ *(shared\/index\.ts|server\/impl\.ts)[^\n]*\n([\s\S]*?)```/g)) {
    const [, path, body] = match;
    if (path !== undefined && body !== undefined) { found.set(path, body); }
  }
  return found;
}

/** The compiler's errors in the generated files, one line each. */
function typecheck(folder: string): string[] {
  const program = ts.createProgram(FILES.map((f) => join(folder, f)), DEFAULT_COMPILER_OPTIONS);
  const mine = (file: ts.SourceFile | undefined) => file !== undefined && file.fileName.replaceAll('\\', '/').startsWith(folder.replaceAll('\\', '/'));
  return ts.getPreEmitDiagnostics(program).filter((d) => mine(d.file)).map((d) => {
    const at = d.file === undefined || d.start === undefined ? '' : `${d.file.fileName.slice(folder.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}: `;
    return `${at}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

describe('the authoring guide (live)', () => {
  const key = liveEnv.get('OPENROUTER_API_KEY');

  it.skipIf(key === undefined)('is enough for a free model to write a system that typechecks', async () => {
    const guide = await authoringText(new PackagedAuthoring());
    const ai = AI.with().providers({ openrouter: new OpenRouterProvider({ apiKey: key ?? '' }) }).create({ models });
    const unavailable: string[] = [];
    for (const model of liveModels()) {
      const folder = join(OUT, model.replace(/[^a-z0-9]+/gi, '-'));
      rmSync(folder, { recursive: true, force: true });
      const messages: Message[] = [{ role: 'system', content: guide }, { role: 'user', content: ASK }];
      let problems: string[] = [];
      let answered = false;
      for (let attempt = 1; attempt <= TRIES; attempt += 1) {
        let answer: string;
        try {
          answer = (await ai.chat.get({ messages, maxTokens: 6_000 }, { metadata: { model: `openrouter/${model}` } })).content;
        } catch (error) {
          unavailable.push(`${model}: ${error instanceof Error ? error.message.slice(0, 160) : 'failed'}`);
          break;
        }
        answered = true;
        const files = filesOf(answer);
        for (const path of FILES) {
          mkdirSync(join(folder, path, '..'), { recursive: true });
          writeFileSync(join(folder, path), files.get(path) ?? '');
        }
        problems = files.size < FILES.length ? [`Answer with both files; got ${[...files.keys()].join(', ') || 'none'}.`] : typecheck(folder);
        console.info('live.authoring', { model, attempt, problems: problems.length });
        if (problems.length === 0) { return; }
        messages.push({ role: 'assistant', content: answer }, { role: 'user', content: `That does not compile:\n${problems.slice(0, 20).join('\n')}\nAnswer again with both files, fixed.` });
      }
      if (answered) { expect(problems).toEqual([]); }
    }
    console.warn('live.authoring.unavailable', { unavailable });
  }, 600_000);
});
