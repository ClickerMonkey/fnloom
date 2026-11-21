import { describe, expect, it } from 'vitest';
import { HubOption } from './suggestions.ts';
import { HttpUrl, OUTSIDE_IMAGES_DEFAULT, isHttpUrl } from './urls.ts';
import { systemLinkSpec } from './link.ts';
import { Link } from './resources.ts';
import { ResourceSource } from './resource-forms.ts';

/** URLs that would run script, or hide a scheme, if the app opened them. */
const ATTACKS = [
  'javascript:alert(document.cookie)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'javascript://x%0Aalert(1)',
  'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'blob:https://hub.test/1', 'file:///etc/passwd',
  '//evil.test', ' https://evil.test', 'https://evil.test/\nx', 'https://evil.test/\u0000', 'https:evil.test', '/chat',
];

describe('HttpUrl (H2)', () => {
  it('takes http and https URLs, any case', () => {
    for (const url of ['https://example.com/a?b=1#c', 'http://localhost:4300/x', 'HTTPS://Example.com', 'http://[::1]/']) { expect(isHttpUrl(url), url).toBe(true); }
  });

  it('refuses script, data and other schemes, and whitespace or control tricks', () => {
    for (const url of ATTACKS) { expect(HttpUrl.safeParse(url).success, JSON.stringify(url)).toBe(false); }
  });

  it('is what a system’s connect URL and a chat link must be', () => {
    const connectStart = systemLinkSpec.endpoints.connectStart.cfg.response;
    expect(connectStart.safeParse({ url: 'https://idp.test/authorize?x=1' }).success).toBe(true);
    expect(connectStart.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    expect(Link.safeParse({ url: 'https://example.com', title: 'x' }).success).toBe(true);
    expect(Link.safeParse({ url: 'data:text/html,x', title: 'x' }).success).toBe(false);
    expect(ResourceSource.safeParse({ from: 'web', url: 'vbscript:x', fetchedAt: 1, rendered: false }).success).toBe(false);
  });

  it('keeps the outside-images setting as a hub option, asking first by default', () => {
    expect(OUTSIDE_IMAGES_DEFAULT).toBe('ask');
    expect(HubOption.safeParse({ key: 'outsideImages', value: 'always', setBy: 'act_a', updatedAt: 1 }).success).toBe(true);
    expect(HubOption.safeParse({ key: 'outsideImages', value: 'sometimes', setBy: 'act_a', updatedAt: 1 }).success).toBe(false);
  });
});
