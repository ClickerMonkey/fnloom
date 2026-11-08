import { describe, expect, it } from 'vitest';
import { REDACTED, domainOf, isCredentialParam, labelOf, parseWebUrl, redactUrl } from './urls.ts';

describe('parseWebUrl', () => {
  it('takes http and https URLs, and reads a bare address as https', () => {
    expect(parseWebUrl('https://example.com/a?b=1')?.href).toBe('https://example.com/a?b=1');
    expect(parseWebUrl('  http://example.com ')?.href).toBe('http://example.com/');
    expect(parseWebUrl('example.com/docs')?.href).toBe('https://example.com/docs');
    expect(parseWebUrl('docs.python.org')?.href).toBe('https://docs.python.org/');
  });

  it('refuses other schemes, words and text with spaces', () => {
    for (const input of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'hello', '', 'example .com', 'https://']) {
      expect(parseWebUrl(input), input).toBeUndefined();
    }
  });
});

describe('redactUrl', () => {
  it('replaces credential-bearing query values and drops user info', () => {
    const redacted = new URL(redactUrl('https://ada:hunter2@example.com/f?api_key=abc&page=2&X-Amz-Signature=sig&access_token=t&sig=s'));
    expect(redacted.username).toBe('');
    expect(redacted.password).toBe('');
    expect(redacted.searchParams.get('api_key')).toBe(REDACTED);
    expect(redacted.searchParams.get('X-Amz-Signature')).toBe(REDACTED);
    expect(redacted.searchParams.get('access_token')).toBe(REDACTED);
    expect(redacted.searchParams.get('sig')).toBe(REDACTED);
    expect(redacted.searchParams.get('page')).toBe('2');
  });

  it('leaves URLs without credentials alone', () => {
    expect(redactUrl('https://example.com/search?q=cats&page=1')).toBe('https://example.com/search?q=cats&page=1');
  });

  it('tells credential names from ordinary ones', () => {
    for (const name of ['token', 'key', 'apiKey', 'api-key', 'client_secret', 'password', 'Signature', 'x-goog-credential', 'auth', 'session_id', 'jwt']) {
      expect(isCredentialParam(name), name).toBe(true);
    }
    for (const name of ['q', 'page', 'monkey', 'keyboard', 'sort', 'id', 'lang']) {
      expect(isCredentialParam(name), name).toBe(false);
    }
  });
});

describe('domainOf and labelOf', () => {
  it('names the site without www', () => {
    expect(domainOf('https://www.example.com/a')).toBe('example.com');
    expect(domainOf(new URL('https://docs.example.com'))).toBe('docs.example.com');
  });

  it('labels a URL by its site and last segment, decoded, never showing credentials', () => {
    expect(labelOf('https://www.example.com/')).toBe('example.com');
    expect(labelOf('https://example.com/docs/My%20Guide.pdf')).toBe('example.com · My Guide.pdf');
    expect(labelOf('https://example.com/bad%E0%A4%A')).toBe('example.com · bad%E0%A4%A');
    expect(labelOf('https://example.com/file?token=secret')).not.toContain('secret');
  });
});
