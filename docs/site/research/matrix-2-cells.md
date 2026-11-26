# Feature matrix, draft 2: competitor cells

Competitor cells only (the harness column comes from `harness-features.md`). Checked 2026-11-26.

- **Legend:** ● yes · ◐ partly · ○ no · – not in their docs / doesn't apply
- **Sources:** a number in square brackets, like [69], is footnote `[^69]` in `research/competitors.md`. Footnotes 69–101 were added for this draft.
- **Rule for the "ready out of the box" rows:** built in, or a first-party add-on from the same project. A third-party package, or "the agent could write one", does not count. "Via MCP" alone does not count either.
- **pi** is new in this draft (section 10 of `competitors.md`).

## Safety and control

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| Asks before acting | ● [6] | ● [19] | ◐ shows blocked agents [2] | ● [33] | ● [39] | ● [45] | – | ● [54] | ● [58] | ○ "No permission popups" [69][74] |
| **NEW** Shows exactly what will change | – | ● Code: diff before you accept an edit [83] | – | – | – | – diffs reviewed after, in a review pane [45] | – | – | – shows the tool call, not a diff [58] | ○ no approvals [74] |
| Undo a step | ● [10] | ◐ [18] | – | ◐ [36] | ● [41] | ◐ [44] | – | – | – | ◐ conversation tree only; files not stated [73] |
| Tools kept in a sandbox | ○ [6] | ● [19] | ○ [3] | ◐ [31][32] | ● [39] | ● [45] | ◐ [51] | ◐ [53] | – | ◐ none built in; documented container and micro-VM setups [74][77] |

## Builds and extends itself

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| Makes its own tools | ◐ [8] | ● [29] | ● [3] | ● [36] | ● [39] | ● [48] | – | – | ◐ [61] | ● "ask Pi to build it", `/reload` [69] |
| **NEW** Add-on marketplace | ◐ community list, no installer [85] | ● plugin marketplaces [17][28] | ● plugin marketplace [3] | ● ClawHub [31] | ● Skills Hub + marketplace [89] | ● plugin directory [45] | ● one-click community imports [51] | ● extensions directory [98] | ● community nodes [100] | ● 5,547 packages [78] |
| Plugs into other tools | ● | ● | ◐ | ● | ● | ● | ● | ● | ● | ● extensions, MCP [69] |

## Memory

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| Remembers you across chats | ◐ [13] | ● [17][27] | – | ● [34] | ● [39] | ● [45][49] | ● [51] | ● [66] | ◐ [67] | ◐ AGENTS.md only; memory via 3rd-party packages [69][78] |
| **NEW** Brings up memories by itself | ○ rules files only [13] | ● Code loads MEMORY.md each session; apps memory on by default [82][27] | – | ● MEMORY.md loads each session [34] | ● injected at session start [88] | ● ChatGPT "decides which … is relevant" [92] | ● added every reply [94] | ● "includes them in every prompt" [66] | – | ○ none built in [69] |
| **NEW** Private memories per person | – no accounts | ● per member; owners can't view them [27] | – | ◐ split by agent, not by person [32] | – profiles only; per-user not stated [88] | ● "Tied to each individual account" [93] | ● "scoped to your user account" [94] | – | – | – |

## Models and cost

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| Any model, even local | ● [9] | ○ [22] | – | ● [31] | ● [39] | ◐ [47] | ● [50] | ● [52] | ● [56] | ● 15+ providers, llama.cpp, Ollama [69][75] |
| **NEW** Compare two models side by side | – | – | – | – | – | – | ● "Run two models side-by-side" [51] | – | – | – one model at a time [75] |
| Spending limits | – | ● [20] | ○ | ◐ [37] | – | – | ◐ [51] | – | – | – shows cost, no limit [75] |

## Ready out of the box

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| Works with databases | – | ◐ [30] | ○ | ◐ [34] | – | – | ◐ [51] | – | ● [61] | – |
| **NEW** Drives Claude Code | – | – is Claude Code | ● runs it in a real terminal [2] | ● ACP harness, official plugin [86] | ● bundled `claude-code` skill [91] | – | ◐ first-party Computer add-on [96] | ◐ ACP provider; adapter installed separately [97] | – | – |
| **NEW** Calls any web API (saved calls) | – | – | – | – | – | – | ● OpenAPI tool servers [51] | – | ● HTTP Request node, usable as an agent tool [99] | – |
| **NEW** MCP servers | ● [15] | ● [17] | – | ● [35] | ● [40] | ● [44] | ● [51] | ● [53] | ● [56][59] | ● built in [69] |
| **NEW** Web research (search + read pages) | ● webfetch + websearch [84] | ● WebSearch + WebFetch [21] | – | ● web_search + web_fetch [33] | ● web search tool [40] | ● live web search [45] | ● [51] | ◐ web scraping; search not stated [98] | ◐ search node deprecated; HTTP Request [101][99] | – 3rd-party packages only [78] |
| **NEW** Files on several computers | – | – | ◐ remote machines over SSH/Tailscale; terminals, not files [3] | ◐ paired nodes do device-local actions [31][33] | ◐ one terminal backend at a time (local, SSH, …) [39] | – | – | – | – | – |

## Automation

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| Runs on a schedule | ◐ [7][16] | ● [17][26] | ◐ [3] | ● [33] | ● [40] | ● [45] | ● [51] | ● [55] | ● [68] | – [69] |
| **NEW** Calendar of what runs | – | – list page only [81] | – | – list + history only [87] | – job list in dashboard [90] | – | – | – | – | – |
| **NEW** Catches up missed runs | – | ◐ Desktop: one catch-up run on wake; Code/cloud tasks not stated [81] | – | ● restart catch-up [87] | ● "catches up once" [90] | – | – | – | ● opt-in "Run the Most Recent Missed Execution" [68] | – |
| Several tasks at once | ● [7] | ● [17][21] | ● [3] | ● [33] | ● [40] | ● [44][45] | – | ● [53] | ◐ [58] | ○ "No sub-agents"; tmux or packages [69] |

## Data, forms and dashboards

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| Asks with forms | ● [6] | ◐ [21] | ○ | ● `ask_user` structured decision [33] | – | – | – | – | ● [60][58] | – |
| Charts you can keep | – | ● [30] | ○ | ◐ [33][35] | – | – | ◐ [51] | ◐ Auto Visualiser, in chat [98] | ◐ [57] | – |
| **NEW** Dashboards you can keep | – | ● artifact dashboards (beta) [30] | ○ | ◐ Canvas, MCP Apps views [33][35] | – admin dashboard only [42] | – | ◐ admin analytics only [51] | – | ◐ Insights, workflow stats only, paid [57] | – |

## People and sharing

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| Accounts for everyone | ○ [11] | ◐ [24] | ○ [3] | ● [32] | ◐ [39][40] | ◐ [49] | ● [51] | – | ● [57] | – single-user CLI [72] |

## Files and media

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| Reads PDFs, sheets, photos | ◐ [6] | ● [25][28] | ◐ [3] | ◐ [33] | ◐ [40] | ◐ [44] | ● [51] | – | – | ◐ images only [76] |
| Speak instead of type | – | ● [24] | ◐ [3] | ● [31][33] | ● [40] | ◐ [49] | ● [51] | – | – | – |

## Where you use it

| | OpenCode | Claude | herdr | OpenClaw | Hermes | Codex | Open WebUI | goose | n8n | pi |
|---|---|---|---|---|---|---|---|---|---|---|
| **NEW** Same app on every device | ◐ TUI, desktop, web; phone via pairing [5][11] | ● web, desktop, iOS, Android [17] | ◐ native + phone apps, no web [3] | ◐ native apps + web Control UI [31] | ◐ desktop + messaging apps [39][40] | ● ChatGPT web, desktop, mobile [43][49] | ● every instance is an installable PWA [95] | – desktop + CLI only [52] | – web editor only [56] | ○ terminal only [69] |
| Runs on your machine | ● | ◐ | ● | ● | ● | ◐ | ● | ● | ● | ● [69] |
| In the browser | ● | ● | ○ | ● | ● | ● | ● | – | ● | – [69] |
| On your phone | ◐ | ● | ● | ● | ◐ | ● | ● PWA [95] (was –) | – | – | ◐ Termux; Discord/Telegram via pi-chat [72][79] |
| Desktop app | ● | ● | ● | ● | ● | ● | ● | ● | – | – [69] |
| Open source | ● MIT | ○ | ● Apache | ● MIT | ● MIT | ◐ | ◐ | ● Apache | ◐ | ● MIT [70] |
| Price | free / $10+ | $0–200/mo | free | free | free | free / $8+ | free | free | free / €20+ | free + your model [69] |

## Changed from draft 1

1. **Open WebUI, On your phone: – → ●.** "Every Open WebUI instance is a Progressive Web App (PWA)", installable on phone, tablet or desktop [95].
2. **OpenClaw, Asks with forms: – → ●.** The tools list has `ask_user`, which "requests a structured user decision" [33].
3. **goose, Charts you can keep: – → ◐.** The built-in Auto Visualiser extension "automatically creates data visualizations in conversations" [98]. The docs don't say charts can be kept, so ◐.
4. **OpenCode, Reads PDFs, sheets, photos: ◐ is on weak ground.** Draft 1 cited the `generate_image` tool [6]. That *makes* images; it doesn't read them. I kept ◐ because I found no source either way, but – would be the stricter cell.
5. **herdr, Plugs into other tools:** draft 1 says "no MCP". herdr's pages simply don't mention MCP [2][3], so the new MCP row reads –, not ○.
6. **pi left-out row** in `competitors.md` is now crossed out, pointing to the new section 10.
7. **New facts that sharpen draft-1 notes (no cell change):**
   - n8n's Schedule Trigger *does* have catch-up, opt-in. Draft 1's research listed nothing for it.
   - Claude Desktop local tasks run one catch-up after sleep [81].
   - OpenCode has built-in websearch/webfetch [84].

## Least sure

1. **Open WebUI, Drives Claude Code (◐).** It rests on docs.openwebui.com search snippets. The "Computer" coding-agents page returned 404 when fetched, and the Computer README doesn't mention Claude Code [96].
2. **OpenClaw, Files on several computers (◐).** "Nodes" are paired devices with "device-local actions" [31][33]. I could not confirm that the agent reads files across several of them.
3. **Claude, Shows exactly what will change (●).** It is documented for the VS Code extension in Manual mode [83]. CLI and desktop prompts very likely show a diff too, but I didn't find a page that says so. The apps (Cowork) side is unknown.
4. **OpenClaw, Brings up memories by itself (●).** `MEMORY.md` loads each session [34], but that is the whole file, not a pick of relevant memories. The same goes for Claude Code and goose. If the row is meant to be "relevant ones picked per message", only ChatGPT [92] and Open WebUI context memories [94] clearly qualify.
5. **goose, Drives Claude Code (◐).** goose uses Claude Code as its model provider through an ACP adapter you install yourself [97]. Whether that counts as "driving Claude Code" depends on the row's meaning: it hands the whole turn to Claude Code; it doesn't steer sessions from a UI.

Also borderline:

- **Hermes, Asks before acting (●)** comes from the README's "command approval" [39]. The features page doesn't say what the prompt shows.
- **pi, Undo (◐)**: the tree rewinds the conversation, and the docs don't say whether files roll back [73].
- **Codex, Shows exactly what will change (–)**: the CLI may show a patch in its approval prompt, but the docs I found describe diffs only in the review pane [45].
