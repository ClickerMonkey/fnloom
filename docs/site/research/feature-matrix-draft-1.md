# Feature matrix (draft 1, 2026-11-26)

Sources: `research/competitors.md` (each competitor cell cites an official page, checked 2026-11-26) and
`research/harness-features.md` (each harness cell is built and tested; see its evidence column and "Do not claim").

**Legend:** ● yes · ◐ partly · ○ no · – doesn't apply / not found in their docs

**Columns:** Harness · OpenCode · Claude (Code + apps) · herdr · OpenClaw · Hermes Agent · Codex (+ ChatGPT) ·
Open WebUI · goose · n8n

## Safety and control

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|---|
| Asks before acting | ● | ● | ● | ◐ | ● | ● | ● | – | ● | ● |
| Undo a step | ◐ last step | ● | ◐ | – | ◐ | ● | ◐ | – | – | – |
| Tools kept in a sandbox | ◐ | ○ | ● | ○ | ◐ | ● | ● | ◐ | ◐ | – |

## Memory

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|---|
| Remembers you across chats | ● | ◐ | ● | – | ● | ● | ● | ● | ● | ◐ |

## People and sharing

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|---|
| Accounts for everyone | ● | ○ | ◐ | ○ | ● | ◐ | ◐ | ● | – | ● |

## Models and cost

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|---|
| Any model, even local | ● | ● | ○ | – | ● | ● | ◐ | ● | ● | ● |
| Spending limits | ● | – | ● | ○ | ◐ | – | – | ◐ | – | – |

## Automation

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|---|
| Runs on a schedule | ● | ◐ | ● | ◐ | ● | ● | ● | ● | ● | ● |
| Several tasks at once | ● | ● | ● | ● | ● | ● | ● | – | ● | ◐ |

## Builds and extends itself

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|---|
| Plugs into other tools | ● | ● | ● | ◐ | ● | ● | ● | ● | ● | ● |
| Makes its own tools | ● | ◐ | ● | ● | ● | ● | ● | – | – | ◐ |

## Data, forms and dashboards

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|---|
| Works with databases | ● | – | ◐ | ○ | ◐ | – | – | ◐ | – | ● |
| Asks with forms | ● | ● | ◐ | ○ | – | – | – | – | – | ● |
| Charts you can keep | ● | – | ● | ○ | ◐ | – | – | ◐ | – | ◐ |

## Files and media

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|---|
| Reads PDFs, sheets, photos | ● | ◐ | ● | ◐ | ◐ | ◐ | ◐ | ● | – | – |
| Speak instead of type | ◐ dictation | – | ● | ◐ | ● | ● | ◐ | ● | – | – |

## Where you use it

| | Harness | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|---|
| Runs on your machine | ● | ● | ◐ | ● | ● | ● | ◐ | ● | ● | ● |
| In the browser | ● | ● | ● | ○ | ● | ● | ● | ● | – | ● |
| On your phone | ◐ web + alerts | ◐ | ● | ● | ● | ◐ | ● | – | – | – |
| Desktop app | ○ | ● | ● | ● | ● | ● | ● | ● | ● | – |
| Open source | ? owner | ● MIT | ○ | ● Apache | ● MIT | ● MIT | ◐ | ◐ | ● Apache | ◐ |
| Price | free + your model | free / $10+ | $0–200/mo | free | free | free | free / $8+ | free | free | free / €20+ |

## Only here, as far as we found

Harness features the competitors' docs don't show (as of 2026-11-26). The page says "we haven't found it elsewhere",
never "only".

| | |
|---|---|
| Previews before you approve | The approval card shows exactly what will change (rows, files, a diff). |
| Tools shaped for each model | Every tool's format is fitted to the model in use, so cheaper models make fewer mistakes. |
| Pictures for blind models | A model that can't see gets a description and can ask questions about the image. |
| Recalls memories by itself | Relevant memories come with your message; you don't have to ask. |
| Private memories stay private | One person's memories never show up in another person's chat. |
| Calendar of what runs | Every schedule on one calendar, each with its own approvals. |
| Catches up after downtime | Missed runs are caught up, or skipped, as you choose. |
| Compare answers side by side | Run the same message on two models and compare them. |
| Honest undo report | Undo says what it could and couldn't take back. |
| Many computers, one assistant | Attach several machines' files; it picks the right one. |
| Runs Claude Code sessions | Start and steer Claude Code from the web app, with its prompts as approval cards. |
| Tested by a simulated family | 84 everyday scenarios played by a simulated household, judged on the result. |

## Notes for review

- **Undo:** the harness undoes only the last step, so it gets ◐ against OpenCode's ●. Honest beats flattering.
- **Desktop app:** the harness has none (it's a web app that works on phones), so ○.
- **Builds whole add-ons from a plain request:** not claimed; it does so only when asked directly ("Do not claim").
  "Makes its own tools" means saved tools: code, API calls and saved queries made from a chat.
- **Open source:** the repo is private and has no licence yet; Phil decides.
- **Columns:** Claude Code and the Claude apps are one column, as are Codex and ChatGPT (one account, one plan, one
  extension model each).
