/**
 * The claude system's shared shapes, now that they ship with the system (item 9): a machine's config reads the same
 * through gin as through zod (the case `@harness/sdk`'s zod-gin test kept while the shape was in core), and the
 * contract declares the fleet and session pages its client draws.
 */
import { ginOf, parseValue } from '@harness/sdk';
import { describe, expect, it } from 'vitest';
import { CLAUDE_PAGES, claude, ClaudeInstanceConfig } from './index.ts';

describe('the claude shapes', () => {
  it('reads a Claude machine the same through gin as through zod', () => {
    const value = { folders: [{ path: 'C:/work', label: 'Work' }], permissionMode: 'acceptEdits', maxLive: 4, hubMcp: { url: 'http://127.0.0.1:4320/mcp', secret: 's' } };
    const type = ginOf(ClaudeInstanceConfig);
    expect(ClaudeInstanceConfig.parse(parseValue(type, value))).toEqual(ClaudeInstanceConfig.parse(value));
    expect(() => parseValue(type, { folders: [{ path: 'C:/work' }], maxLive: 0 })).toThrow();
  });

  it('declares the fleet in the main nav and one session as a hidden page', () => {
    expect(claude.pages.map((page) => [page.segment, page.nav, page.access, page.component])).toEqual([
      [CLAUDE_PAGES.fleet, 'main', 'everyone', 'FleetPage'],
      [CLAUDE_PAGES.session, 'hidden', 'everyone', 'SessionPage'],
    ]);
  });
});
