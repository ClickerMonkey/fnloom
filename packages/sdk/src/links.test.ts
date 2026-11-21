import { describe, expect, it } from 'vitest';
import { safeHref } from './links.ts';

describe('safeHref (H2)', () => {
  it('allows the web, mail, places in the app and resource URIs', () => {
    for (const url of ['https://example.com/a', 'HTTP://example.com', 'mailto:a@b.co', '/chat/ses_1', '#m-1', './a.md', '../b', 'fs://docs/a.md', 'file:///C:/work/a.md']) {
      expect(safeHref(url), url).toBe(url);
    }
    expect(safeHref('  https://example.com  ')).toBe('https://example.com');
  });

  it('refuses script and data URLs, protocol-relative ones and hidden characters', () => {
    for (const url of [
      'javascript:alert(1)', 'JavaScript:alert(1)', 'javascript://x%0Aalert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>1</script>', 'data://x',
      'vbscript:msgbox(1)', 'blob:https://hub.test/1', '//evil.test', '/\\evil.test', '/\\/evil.test','/\t/evil.test', 'https://evil.test/\nx', '', undefined, null,
    ]) {
      expect(safeHref(url), JSON.stringify(url)).toBeUndefined();
    }
  });
});
