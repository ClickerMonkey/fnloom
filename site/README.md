# The marketing site (draft 2)

A static site: plain HTML, CSS and a little vanilla JavaScript, no framework. Sources live in `src/`; the build writes
`dist/`, which is what gets hosted.

```
site/
  site.config.json      the product name, tagline, domain and contact: the ONLY place the name lives
  src/index.html        the home page ({{name}} tokens, <!-- build:… --> markers)
  src/marketplace/      the system marketplace preview (mock; docs/plans/marketplace-2026-11-26.md)
  src/css/              site.css (the "Saddle & Signal" look), stage.css (demos, devices), market.css
  src/js/               site.js (theme, reveal, tilt, tabs, matrix chips), demo.js (the drawn demos), market.js
  src/img/              the mark (and any screenshots)
  data/marketplace.json the marketplace's listings (built-in systems are real; the rest say "example")
  tools/build.mjs       src → dist: fills {{tokens}}, the comparison, the sources and the listings
  tools/check.cjs       renders dist in Chromium: errors, overflow, links, unfilled tokens; writes preview/*.png
```

## Build and preview

```sh
node site/tools/build.mjs            # → site/dist
npx serve site/dist                   # or open site/dist/index.html
NODE_PATH=<somewhere with playwright>/node_modules node site/tools/check.cjs
```

## Change the name

Edit `name` in `site.config.json` and rebuild. Every page, title, meta tag, the matrix's first column and the
marketplace use it; the marketplace's repository topic is derived from it (`<name>-system`). `check.cjs` fails if any
`{{token}}` is left unfilled.

## Change the comparison

`docs/site/feature-matrix.md` is the single source, cell for cell: categories show in that file's order, numbered,
with the text after " — " in a heading as the category's lede. Sources come from the footnotes in
`docs/site/research/competitors.md`. Anything a harness cell or the copy claims must be in
`docs/site/research/harness-features.md` / `systems-out-of-box.md` and not on their "Do not claim" lists.

## The demos

Each demo is plain HTML that already shows its finished state (so it reads without JavaScript and under reduced
motion). `demo.js` replays it: elements with `data-beat="n"` appear in order, `data-type` types, `data-press` presses,
`data-until` hides, `data-count` counts up; `data-goto` buttons jump to a step. They play only while on screen.

## Hosting (Phil: his own domain on DigitalOcean; not done yet)

`dist/` is a plain static folder, so either of these works once the domain is bought:

1. **App Platform, static site** (simplest): a new app from this repository (DigitalOcean's GitHub app can read the
   private repo), component type *Static Site*, build command `node site/tools/build.mjs`, output directory
   `site/dist`, deploy on push to `main` (or a `site` branch to keep site deploys separate). Add the domain under
   Settings → Domains; it issues the certificate.
2. **A Droplet with Caddy or nginx**, serving `site/dist` copied by a deploy script; more control, more upkeep. Later,
   the marketplace service (phase M2) can run beside it on the same Droplet.

Set `domain` in `site.config.json` when it's known (for canonical links and the marketplace's subdomain).
