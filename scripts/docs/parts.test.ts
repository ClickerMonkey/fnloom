import { describe, expect, it } from 'vitest';
import type { Topic } from './compose.ts';
import { guideParts, partsModule } from './parts.ts';

const OUTLINE: readonly Topic[] = [
  { id: 'start', title: 'Start here', exports: [] },
  { id: 'make', title: 'Making it', exports: [] },
  { id: 'inside', title: 'Inside', exports: [], reference: true },
  { id: 'types', title: 'Core types', exports: [], reference: true },
];

const GUIDE = ['# Guide', 'Intro.', '## Contents', '1. ...', '## 1. Start here', 'Begin.', '## 2. Making it', "Make 'it'.", '## 3. Inside', 'Gears.', '## 4. Core types', 'Types.'].join('\n\n');

describe('the guide in parts', () => {
  it('cuts the guide at each topic’s heading, in the outline’s order', () => {
    const parts = guideParts(GUIDE, OUTLINE);
    expect(parts.map((p) => [p.name, p.text])).toEqual([
      ['authoring-start', '## 1. Start here\n\nBegin.'],
      ['authoring-make', "## 2. Making it\n\nMake 'it'."],
      ['authoring-inside', '## 3. Inside\n\nGears.'],
      ['authoring-types', '## 4. Core types\n\nTypes.'],
    ]);
    expect(() => guideParts('# Guide\n', OUTLINE)).toThrow('the guide has no section "## 1. Start here"');
  });

  it('writes each part, its context declaration and one value per part, chaining parts of the same kind', () => {
    const text = partsModule(guideParts(GUIDE, OUTLINE));
    expect(text).toContain("'authoring-start': { heading: '## 1. Start here', title: 'Start here', tokens: 10, reference: false, next: 'authoring-make' },");
    // the guide's chain ends before the reference parts, which chain on their own
    expect(text).toContain("'authoring-make': { heading: '## 2. Making it', title: 'Making it', tokens: 10, reference: false },");
    expect(text).toContain("'authoring-inside': { heading: '## 3. Inside', title: 'Inside', tokens: 10, reference: true, next: 'authoring-types' },");
    expect(text).toContain("'authoring-start': context({ description: 'Writing a harness system, part 1 of 4: Start here (about 10 tokens).', parent, next: { ref: 'context', name: 'fs/authoring-make' } }),");
    expect(text).toContain("'authoring-types': context({ description: 'Writing a harness system, reference part 4 of 4: Core types (about 10 tokens).', parent, suggest: 'none', tags: ['reference'] }),");
    expect(text).toContain("    'authoring-make': make('authoring-make'),");
    // the same guide always writes the same module, so `--check` is stable
    expect(partsModule(guideParts(GUIDE, OUTLINE))).toBe(text);
  });

  it('quotes titles with quotes and backslashes', () => {
    const outline: readonly Topic[] = [{ id: 'q', title: "Al's \\ path", exports: [] }];
    const text = partsModule(guideParts("## 1. Al's \\ path\n\nx", outline));
    expect(text).toContain("title: 'Al\\'s \\\\ path'");
  });
});
