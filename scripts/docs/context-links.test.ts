/** The guide's anchors and bold section names become context links once it is split into items. */
import { describe, expect, it } from 'vitest';
import { anchorHomes, linkItem, sectionTitles } from './context-links.ts';

describe('linking the split guide', () => {
  const items = [
    { key: 'fs/authoring.contract', body: 'Refers to: [`SystemGrants`](#core-systemgrants) and [`Own`](#own).\n\n<a id="own"></a>\n\nSee **Testing**, **The server** and **The contract**.\n\n```md\n[x](#core-systemgrants) **Testing**\n```' },
    { key: 'fs/authoring.core-types', body: '#### <a id="core-systemgrants"></a>`SystemGrants`' },
  ];
  const titles = sectionTitles([
    { key: 'fs/authoring.contract', title: 'The contract' },
    { key: 'fs/authoring.server', title: 'The server: serve and the implementation' },
    { key: 'fs/authoring.testing', title: 'Testing' },
  ]);

  it('points an anchor in another item at that item, keeps its own, links bold section titles but its own, and leaves code alone', () => {
    const [contract] = items;
    if (contract === undefined) { throw new Error('no item'); }
    expect(linkItem(contract, anchorHomes(items), titles)).toBe([
      'Refers to: [`SystemGrants`](context:fs/authoring.core-types#core-systemgrants) and [`Own`](#own).',
      '',
      '<a id="own"></a>',
      '',
      'See [Testing](context:fs/authoring.testing), [The server](context:fs/authoring.server) and **The contract**.',
      '',
      '```md',
      '[x](#core-systemgrants) **Testing**',
      '```',
    ].join('\n'));
  });

  it('leaves out a short title two parts share', () => {
    const shared = sectionTitles([{ key: 'fs/a', title: 'Types: one' }, { key: 'fs/b', title: 'Types: two' }]);
    expect(shared.has('types')).toBe(false);
    expect(shared.get('types: two')).toBe('fs/b');
  });
});
