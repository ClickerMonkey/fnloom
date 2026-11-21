/*
 * zod's settings for the page, loaded by index.html before any module. The hub's Content-Security-Policy forbids eval
 * (`script-src 'self'`), so zod runs jitless: otherwise zod probes with `new Function` on its first object parse, and
 * the browser reports that as a CSP refusal even though zod catches it. zod reads its settings from this global (and
 * keeps an existing one), so this covers the app and the zod copies inside system client builds, whatever loads first.
 */
globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true });
