# Feature matrix (draft 2, 2026-11-26)

Sources: `research/competitors.md` and `research/matrix-2-cells.md` (each competitor cell cites an official page,
checked 2026-11-26) and `research/harness-features.md` + `research/systems-out-of-box.md` (each harness cell is built
and tested; see their evidence and "Do not claim"). Draft 1 is kept in `research/feature-matrix-draft-1.md`.

The site is generated from this file (`node site/tools/build.mjs`): categories show in this order, numbered; the text
after " — " in a heading is the category's one-line lede.

**Legend:** ● yes · ◐ partly · ○ no · – doesn't apply / not found in their docs · ◇ coming soon

**Order (Phil: "order the feature categories by what's unique or strongest"):** ranked by how few competitors match the
harness's ● rows in each category, with the systems out of the box first. Approval previews sit after memory (Phil: "Shows it's work and asks before it acts is not the selling point of this"). "Where you use it" (no desktop
app) is last.

## Ready out of the box — Systems for real work, built in

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Files on several computers | ● | – | – | ◐ | ◐ | ◐ | – | – | – | – | – |
| Works with databases | ● | – | ◐ | ○ | ◐ | – | – | ◐ | – | ● | – |
| Web APIs as fns | ● | – | – | – | – | – | – | ● | – | ● | – |
| Drives Claude Code | ● | – | – is Claude Code | ● | ● | ● | – | ◐ | ◐ | – | – |
| Web research | ● with a search key | ● | ● | – | ● | ● | ● | ● | ◐ | ◐ | – |
| MCP servers | ● | ● | ● | – | ● | ● | ● | ● | ● | ● | ● |

## Runs on its own — Schedules you can see and trust

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Calendar of what runs | ● | – | – | – | – | – | – | – | – | – | – |
| Catches up missed runs | ● | – | ◐ | – | ● | ● | – | – | – | ● | – |
| Runs on a schedule | ● | ◐ | ● | ◐ | ● | ● | ● | ● | ● | ● | – |
| Several tasks at once | ● | ● | ● | ● | ● | ● | ● | – | ● | ◐ | ○ |

## Your data, forms and charts — Ask about your own records

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Charts you can keep | ● | – | ● | ○ | ◐ | – | – | ◐ | ◐ | ◐ | – |
| Asks with forms | ● | ● | ◐ | ○ | ● | – | – | – | – | ● | – |
| Tracks anything in tables | ● | – | – | ○ | – | – | – | – | – | ● | – |

## Models and cost — Any model, fitted, with limits

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Spending limits | ● per user, chat, message | – | ● | ○ | ◐ | – | – | ◐ | – | – | – |
| Compare two models side by side | ● | – | – | – | – | – | – | ● | – | – | – |
| Any model, even local | ● | ● | ○ | – | ● | ● | ◐ | ● | ● | ● | ● |

## Memory, per user — Remembers each user, privately

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Private memories per user | ● | – | ● | – | ◐ | – | ● | ● | – | – | – |
| Brings up memories by itself | ● | ○ | ● | – | ● | ● | ● | ● | ● | – | ○ |
| Remembers you across chats | ● | ◐ | ● | – | ● | ● | ● | ● | ● | ◐ | ◐ |

## See it before it happens — Every change previewed, then approved

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Shows exactly what will change | ● rows, files, commands | – | ◐ code edits | – | – | – | – | – | – | – | ○ |
| Asks before acting | ● | ● | ● | ◐ | ● | ● | ● | – | ● | ● | ○ |
| Undo a step | ◐ last step | ● | ◐ | – | ◐ | ● | ◐ | – | – | – | ◐ |
| Fns kept in a sandbox | ◐ | ○ | ● | ○ | ◐ | ● | ● | ◐ | ◐ | – | ◐ |

## Users and permissions — Multiple users, with permission controls

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Multiple users | ● | ○ | ◐ | ○ | ● | ◐ | ◐ | ● | – | ● | – |

## Files and media — PDFs, sheets, photos and voice

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Reads PDFs, sheets, photos | ● | ◐ | ● | ◐ | ◐ | ◐ | ◐ | ● | – | – | ◐ images |
| Speak instead of type | ◐ dictation | – | ● | ◐ | ● | ● | ◐ | ● | – | – | – |

## Builds and extends itself — New skills when you need them

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Makes its own fns | ● | ◐ | ● | ● | ● | ● | ● | – | – | ◐ | ● |
| Plugs into other apps | ● | ● | ● | ◐ | ● | ● | ● | ● | ● | ● | ● |
| Add-on marketplace | ◇ coming | ◐ | ● | ● | ● | ● | ● | ● | ● | ● | ● |

## Where you use it — The same app on every screen

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Same app on every device | ● | ◐ | ● | ◐ | ◐ | ◐ | ● | ● | – | – | ○ |
| On your phone | ● installable app + alerts | ◐ | ● | ● | ● | ◐ | ● | ● | – | – | ◐ |
| In the browser | ● | ● | ● | ○ | ● | ● | ● | ● | – | ● | – |
| Runs on your machine | ● | ● | ◐ | ● | ● | ● | ◐ | ● | ● | ● | ● |
| Desktop app | ◐ installs from the browser | ● | ● | ● | ● | ● | ● | ● | ● | – | – |
| Open source | ● Apache | ● MIT | ○ | ● Apache | ● MIT | ● MIT | ◐ | ◐ | ● Apache | ◐ | ● MIT |
| Price | free + your model | free / $10+ | $0–200/mo | free | free | free | free / $8+ | free | free | free / €20+ | free + your model |

## Only here, as far as we found

Harness features the competitors' docs don't show (as of 2026-11-26). The page says "we haven't found it elsewhere",
never "only". Draft 2 dropped five draft-1 items that the draft-2 research found elsewhere: compare side by side (Open
WebUI), recalls memories by itself and private memories (Claude, ChatGPT, Open WebUI), catches up after downtime
(OpenClaw, Hermes, n8n), runs Claude Code sessions (herdr, OpenClaw, Hermes).

| | |
|---|---|
| Calendar of what runs | Every reminder and repeating job on one calendar, each with its own approvals. |
| Many computers, one assistant | Attach the files of several machines; it picks the right one. |
| Spending limits at every level | The whole hub, a group, a user, a chat, or a single message. |
| Fns shaped for each model | Every fn's format is fitted to the model in use, so cheaper models make fewer mistakes. |
| Pictures for blind models | A model that can't see gets a description and can ask questions about the image. |
| Previews every kind of change | Rows in a table, lines in a file, the exact command, a new system's skills: shown on the card before you approve. |
| Honest undo report | Undo says what it put back and what it couldn't. |
| Tested end to end by simulated users | Everyday requests played by simulated users and judged on the result. |

## Notes for review

- **Category order** is by uniqueness (above). Ready out of the box leads: it is where the harness is broadest.
- **Dropped row "Dashboards you can keep":** dashboards aren't built (Do not claim 13); charts are kept on the Widgets
  page ("Charts you can keep").
- **New row "Tracks anything in tables"** (hub data, `/data`): n8n has built-in data tables (●); the others were not
  researched for this row, so – means "not found".
- **Add-on marketplace** is ◇ coming (`docs/plans/marketplace-2026-11-26.md`); every competitor has some catalogue.
- **Web research** needs a paid search key (Do not claim 4), hence the note.
- **Undo** ◐: only the last message; database changes, commands and outside sends can't be undone.
- **On your phone** is now ● (installable web app with push alerts; `systems-out-of-box.md` § 4).
- **Open source:** Phil, 2026-11-26: "It will be open source", then "Yeah apache 2 is good": Apache-2.0 (LICENSE, NOTICE).
- **No household framing** (Phil, 2026-11-26: "I don't like the home angle … It does support multiple users and
  permission controls, that's the extent of what should be said in that topic"): the people category is "Users and
  permissions"; the "elsewhere" list says "simulated users".
- **fn, not tool** (Phil, 2026-11-26: "Use fn and fns not the spelled out word … don't call anything tools"): row labels
  say fn/fns; the site underlines every fn and defines it on hover (`site/tools/build.mjs` DEFS).
- **Desktop app / On your phone** (2026-11-26, `docs/plans/installable-app-2026-11-26.md`): the web app installs from Chrome, Edge
  and Safari and on phones (Home Screen), over the hub's own HTTPS; ◐ on desktop because it is not a native download.
