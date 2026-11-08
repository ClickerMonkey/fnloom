/**
 * URL helpers shared by the web system's server and its renderers (browser safe): parsing what a person or a model
 * typed as a web address, the domain shown beside a result, and the redaction that keeps credential-bearing query
 * parameters (`?token=…`, `?api_key=…`, signed-URL signatures) out of names, titles and labels.
 */

/** Query parameter names that carry credentials: their values never reach a name, a title or a label. */
const CREDENTIAL_PARAM = /(?:^|[-_.])(?:token|access[-_]?token|id[-_]?token|refresh[-_]?token|key|api[-_]?key|apikey|secret|client[-_]?secret|password|passwd|pwd|auth|authorization|session|session[-_]?id|sid|sig|signature|credential|credentials|code|jwt|bearer)$|^x-amz-(?:signature|credential|security-token)$|^x-goog-(?:signature|credential)$/i;

/** The value redacted parameters show instead of theirs. */
export const REDACTED = 'redacted';

/** True when a query parameter's name says its value is a credential. */
export function isCredentialParam(name: string): boolean {
  return CREDENTIAL_PARAM.test(name);
}

/**
 * Parse an http(s) URL. A bare address with a dot and no scheme (`example.com/docs`) is read as `https://`; anything
 * else that isn't http or https gives `undefined`.
 */
export function parseWebUrl(input: string): URL | undefined {
  const text = input.trim();
  if (text === '' || /\s/.test(text)) { return undefined; }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : /^[^/?#]+\.[^/?#]+/.test(text) ? `https://${text}` : undefined;
  if (withScheme === undefined || !URL.canParse(withScheme)) { return undefined; }
  const url = new URL(withScheme);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? url : undefined;
}

/** The URL with the values of credential-bearing query parameters replaced, and any user info removed. */
export function redactUrl(input: string | URL): string {
  const url = new URL(input);
  url.username = '';
  url.password = '';
  for (const name of new Set(url.searchParams.keys())) {
    if (isCredentialParam(name)) { url.searchParams.set(name, REDACTED); }
  }
  return url.href;
}

/** The host a reader recognises: the hostname without a leading `www.`. */
export function domainOf(input: string | URL): string {
  const host = new URL(input).hostname;
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * A short label for a URL when there is no title: the domain and the last path segment (decoded), with credentials
 * redacted, so a signed link never shows its signature.
 */
export function labelOf(input: string | URL): string {
  const url = new URL(redactUrl(input));
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const last = segments.at(-1);
  if (last === undefined) { return domainOf(url); }
  let name = last;
  try { name = decodeURIComponent(last); } catch { /* a malformed escape keeps the raw segment */ }
  return `${domainOf(url)} · ${name}`;
}
