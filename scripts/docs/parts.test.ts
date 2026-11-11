import { describe, expect, it } from 'vitest';
import type { Topic } from './compose.ts';
import { guideParts } from './parts.ts';

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
});
