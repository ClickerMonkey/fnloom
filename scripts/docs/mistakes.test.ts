/** Reading refused mistakes out of compile-time tests, and listing them. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mistakesIn, renderMistakes } from './mistakes.ts';

const SOURCE = [
  'const ok = 1;',
  '// @ts-expect-error the title must be one of the fields',
  "type({ title: 'nmae' });",
  'const after = 2;',
  'function run() {',
  '  // confirm is optional, so the compiler makes us check',
  '  // @ts-expect-error may be undefined',
  '  await confirm();',
  '  // @ts-expect-error',
  '  void serve(tiny, {',
  '    fns: {},',
  '  });',
  '}',
].join('\n');

describe('mistakesIn', () => {
  const found = mistakesIn(SOURCE, 'typetests/a.ts');

  it('finds each expected error with its reason and the statement under it', () => {
    expect(found.map((m) => m.why)).toEqual(['the title must be one of the fields', 'may be undefined', 'refused by the compiler']);
    expect(found[0]).toEqual({ why: 'the title must be one of the fields', code: "type({ title: 'nmae' });", file: 'typetests/a.ts' });
  });

  it('keeps the comments just above as context, and a multi-line statement whole, without its indent', () => {
    expect(found[1]?.code).toBe('// confirm is optional, so the compiler makes us check\nawait confirm();');
    expect(found[2]?.code).toBe('void serve(tiny, {\n  fns: {},\n});');
  });

  it('reads the SDK\'s own compile-time tests', () => {
    const real = mistakesIn(readFileSync(new URL('../../packages/sdk/typetests/examples.ts', import.meta.url), 'utf8'), 'examples.ts');
    expect(real.length).toBeGreaterThan(20);
    expect(real.every((m) => m.code.trim() !== '')).toBe(true);
  });
});

describe('renderMistakes', () => {
  it('lists each reason, capitalized, with its code indented under it', () => {
    expect(renderMistakes(mistakesIn(SOURCE, 'a.ts').slice(0, 1))).toBe("- **The title must be one of the fields.**\n\n  ```ts\n  type({ title: 'nmae' });\n  ```");
  });
});
