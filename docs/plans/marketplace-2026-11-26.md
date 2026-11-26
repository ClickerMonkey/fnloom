# The system marketplace (queued 2026-11-26)

Status: **queued.** Phase M0 (a mock front page in the site) is being built with site draft 2. Everything after it
waits for Phil.

## Phil's words (verbatim, 2026-11-26)

> I also plan on having a system marketplace which will be a service I run and own that lists services people have in
> public repos under certain dirs or something. Queue up that work now as well. I will buy a domain and host this on
> digital Ocean. For now we'll do a mock marketplace but real nice front page and later move that to a separate
> service.

## What it is

A catalogue of **systems** (the harness's add-ons: a folder with `system.json`, a server entry and optional client
renderers) that people publish in **public Git repositories**. Phil runs and owns the service. People don't upload
anything: the service finds systems in public repos by convention, checks them, and lists them. A hub
browses the catalogue and installs a listing through the install flow that already exists (`fs/install_system`: build,
check, scan, an admin approval card with the contract and its diff, then hosted on plain `node` under `--permission`;
`system-install-flow.md`).

## How a system is found (proposal)

- **Where:** any public repository with one or more systems under a known directory: `systems/<name>/system.json`
  (this repo's own layout), or the repository root for a single-system repo.
- **Opt-in:** a GitHub topic on the repository (the name of it waits on the product name, e.g. `<name>-system`), so the
  service never lists a repo by accident. Without the topic a repo can still be submitted by URL.
- **What a listing pins:** the repo, the directory, a tag or branch, and the **commit sha** it was checked at. Install
  always takes that exact commit, so a later push can't change what an admin approved.

## What a listing shows

From `system.json` and the repo, with nothing typed twice:

- name, version, one-line description (`description`), author, licence, stars, last updated, source link;
- **what it can do:** its fns with friendly labels, modes (read / write) and which ones ask before acting;
- **what it needs:** config and keys (`configType`), outside packages (`server.external`), network or file access,
  `instances` (one or many);
- optional `marketplace/` folder in the system: an icon, screenshots, a longer readme;
- badges: **Built in** (ships with the harness), **Verified publisher**, **Builds cleanly** (the service's own build and
  scan passed at the pinned sha).

Proposed `system.json` additions (all optional): `title` (friendly name), `icon`, `categories`, `homepage`, `keywords`.

## Trust

- The service builds and scans each pinned commit with the same builder and scan as `fs/install_system`, and shows the
  report. It never runs the system.
- The hub still decides: install is an admin approval with the full contract, its diff and the scan, as today.
- Takedown and report-a-listing from day one; verified publishers later.

## Phases

| Phase | What | Where |
|---|---|---|
| **M0** (with site draft 2) | A mock marketplace front page: search, categories, featured, listing pages. The built-in systems are real listings; community listings are clearly labelled examples. | `site/` (static, mock data in `site/data/marketplace.json`) |
| M1 | The listing fields in `system.json`, a `harness system check` command that validates a folder as the service would, and docs for publishing. | this repo |
| M2 | The service: an indexer (GitHub topic search + submitted URLs → validate, build, scan at a sha), a small database, a JSON API (`/systems`, `/systems/:id`, `/search`), and the real front page reading it. | a new repo, Phil's DigitalOcean (own subdomain) |
| M3 | The hub's **Browse systems** page and install-from-listing (download the pinned commit into a folder, then the existing install flow). | `packages/web`, `systems/fs` |
| M4 | Publishing niceties: update notices, verified publishers, install counts, reports. | service |

## Open questions for Phil

1. The topic and directory convention (waits on the product name).
2. Accounts on the service (GitHub sign-in for publishers?), or listing purely from repos at first.
3. Whether paid or private systems are ever in scope.
4. The subdomain (e.g. `systems.<domain>`), once the domain is bought.
