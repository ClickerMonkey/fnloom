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

## Phil's addition (verbatim)

> Like hitloop can do self signing certificates let's have that for harness as well

## Status (2026-11-26): built, on branch `worktree-agent-a13e0caa8e89e99b7`, not merged

1. **HTTPS:** done, and with no setup (Phil's addition): the hub makes its own certificate authority and a
   certificate for this computer's addresses (`api/tls.ts`, ported from hitloop's `src/hub/tls.ts`), answers http and
   https on the same port by the first byte (`api/dual.ts`, from hitloop's `dualServer`), `wss://` on https. On by
   default; Settings › Hub › Secure address (admins) or `HARNESS_HTTPS`, applied without a restart.
   `HARNESS_TLS_CERT` / `HARNESS_TLS_KEY` use a real certificate instead (Tailscale cert, mkcert), read again when
   they change; Caddy in front also works. The authority downloads from `/harness-ca.crt` (and `.pem`); Settings › App ›
   Use it on your phone has QR codes, the iPhone and Android steps and the https link per network. A page that isn't
   secure says so (Settings › App, Notifications, Hub) and what it blocks.
2. **Manifest:** done (`serve.ts` `webManifest`): `id`, description, `display_override` with
   `window-controls-overlay`, colours, PNG icons 192/512/maskable and the Apple touch icon from the mark, wide and
   narrow screenshots, shortcuts New chat and Inbox. Pictures committed; `npm run app:images` remakes them.
3. **iOS:** done: `apple-touch-icon`, `apple-mobile-web-app-capable`, status-bar style, `viewport-fit=cover` (was
   there), safe areas in the shell (top and bottom were there; the sides added).
4. **Service worker:** done: network-first page loads with the offline page ("Can't reach your hub") only when the
   network fails; caches only that page; registered at start; push unchanged (PNG notification icon).
5. **Install UI:** done: **Install app** in the account menu (only when one step installs: the kept
   `beforeinstallprompt`, or the iPhone sheet) and Settings › App (every state explained); hidden once installed.
6. **Standalone polish:** done: a title bar for `window-controls-overlay` (the hub's name, drags the window), outside
   links open in the browser, the window colour follows the theme.
7. **Tests:** done: unit tests for the certificate builder, the dual server, the https service and endpoints, the
   manifest (and that its pictures exist at their sizes), the authority route, the install store and platform, the
   offline fallback, the standalone helpers and the Settings states; `npm run test:browser` (`e2e/installable.browser.test.ts`)
   asks Chrome over the DevTools protocol on a throwaway hub over https on the LAN address.

## Decisions made

- **One port, http and https both** (as hitloop), rather than redirecting http to https: existing http links, the CLI
  and systems on this computer keep working; a phone uses the https address.
- **The hub's own authority lives in `<HARNESS_DATA>/tls`**, beside the hub's other secrets (`keys.json`), so each hub
  (and each test) has its own.
- **The browser test trusts the hub's keys with `--ignore-certificate-errors-spki-list`** (the authority's and the
  certificate's public keys), not `--ignore-certificate-errors`: Chrome then treats the connection as valid, the way a
  device that installed the authority does. Putting the authority in the Windows store would need a person to click.
- **Puppeteer, not Playwright:** the repo's browser tooling (ui-tests, the web e2e, the gallery) is Puppeteer.
- **QR codes with `qrcode`**, already in the tree through the SDK (now also a dependency of the web app).
- **Settings got an App section** (install, and Use it on your phone) for everyone; the https switch is in Hub.
- **Screenshots are of the mock hub**, with its random made-up system page names left out of the shot.
- **`HARNESS_URL` stays `http://localhost:<port>` by default**: systems the hub starts link to it, and over https
  Node would need to trust the hub's authority (`NODE_EXTRA_CA_CERTS`); the docs say so.

## For Phil

- Native store apps (Tauri / Capacitor) later, or the installable web app is enough?
- The licence for open-sourcing (MIT or Apache-2.0).
