# The web app installs as a desktop and mobile app (2026-11-26)

## Phil's words (verbatim)

> It will be open source and the harness should be updated now so it can be installed ask desktop or mobile app.

## Where it stands

- `packages/hub/src/api/serve.ts` `webManifest(name)`: name, short_name, start_url `/`, scope `/`, `display:
  standalone`, one SVG icon. `index.html` links it and has `apple-mobile-web-app-title`.
- `packages/web/sw/sw.ts`: push and notification clicks only; it caches nothing ("Do not claim" 7: no offline).
- The hub serves plain `http://` and `ws://` by default. Browsers offer **Install** (and web push) only in a secure
  context: HTTPS, or `localhost`. So today a phone on the LAN can't install it at all. This is the main gap.

## The approach: an installable web app (PWA) first

One codebase, the same app on every device (the site's promise), installable from Chrome, Edge and Safari on desktop
and from Android Chrome and iOS Safari ("Add to Home Screen"). Native store apps (Tauri for desktop, Capacitor for
iOS/Android) are a later, separate choice for Phil; nothing here blocks them.

1. **HTTPS for the hub:** serve TLS when given a certificate (`HARNESS_TLS_CERT` / `HARNESS_TLS_KEY`, reloaded on
   change), with `wss://` for the live connection. Documented ways to get a certificate: Tailscale (`tailscale cert`),
   mkcert for a LAN, or a reverse proxy (Caddy) in front. The admin UI says when the hub isn't in a secure context and
   what that blocks (install, push).
2. **A complete manifest:** the hub's display name, description, `id`, `start_url`, `scope`, `display: standalone` with
   `display_override: ["window-controls-overlay", "standalone"]`, theme and background colours, PNG icons (192, 512,
   maskable) and an Apple touch icon made from the mark, screenshots (wide and narrow) for the richer install sheet,
   and shortcuts (New chat, Inbox).
3. **iOS:** `apple-touch-icon`, `apple-mobile-web-app-capable`, status-bar style, `viewport-fit=cover` and safe-area
   insets in the app shell.
4. **The service worker:** still never serves stale app data; navigations are network-first with an offline fallback
   page ("Can't reach your hub") instead of the browser's error, so the installed app degrades gracefully.
5. **Install UI:** an **Install app** item (in the account menu and Settings) using `beforeinstallprompt` where the
   browser offers it, a short "Add to Home Screen" sheet on iOS, hidden once running installed
   (`display-mode: standalone`).
6. **Standalone polish:** a title bar that works with window controls overlay on desktop, outside links opening in the
   browser, safe areas on phones.
7. **Tests:** unit tests for the manifest; a browser test that asks Chrome itself (DevTools protocol
   `Page.getInstallabilityErrors`, `Page.getAppManifest`) that the app is installable over HTTPS; the install item's
   states; the offline page.

## Done when

Chrome reports no installability errors for a hub served over HTTPS, the app installs and opens standalone on desktop
and Android, adds to the home screen on iOS with the right icon and name, push still works, and the docs and the
feature list say so (and the site's "Desktop app" and "On your phone" rows change).

## For Phil

- Native store apps (Tauri / Capacitor) later, or the installable web app is enough?
- The licence for open-sourcing (MIT or Apache-2.0).
