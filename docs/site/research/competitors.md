# Competitor research: AI agent harnesses

Raw research for a public feature-comparison page. Every claim has a source footnote. Where a source did not say, the cell reads **unknown**. Nothing is filled in from memory.

- **Checked:** 2026-11-26, for every product, unless a row says otherwise.
- **Method:** standard web search first, then the official README, docs and pricing pages. Third-party sources are used only where official docs were silent, and are marked *(3rd party)*.
- **Star counts** are GitHub snapshots taken on 2026-11-26. They move fast.

## Products in the matrix

| # | Product | Why it is here |
|---|---|---|
| 1 | **OpenCode** | Required. The open-source terminal coding agent, ~229k stars. |
| 2 | **Claude (Code + apps)** | Required. Anthropic's own harness. Shown as one column (reasons below). |
| 3 | **herdr** | Required. A runtime and multiplexer for coding agents (YC F26, ~53k stars). |
| 4 | **OpenClaw** | Most-starred agent project on GitHub (~395k). Always-on personal assistant over chat apps. It has memory, cron, skills, multi-user "multiplayer" and self-written skills, so it is the closest match to "an agent for me, my household or my team". |
| 5 | **Hermes Agent** (Nous Research) | ~266k stars. Pitched as "self-improving": it writes its own skills, curates its own memory, runs cron jobs and works through a messaging gateway. A direct match for the "remember, automate, extend itself" brief. |
| 6 | **OpenAI Codex (+ ChatGPT)** | The other frontier lab's equivalent of Claude Code plus apps. Codex CLI has ~137k stars and is now folded into the ChatGPT desktop app. Shown as one column, for the same reasons as Claude. |
| 7 | **Open WebUI** | ~160k stars. The most popular self-hosted, multi-user chat front end. It has roles and groups, memory, scheduled prompts, voice, RAG and analytics. It is the "household or team server" benchmark. |
| 8 | **goose** (AAIF / Linux Foundation, originally Block) | ~57k stars. Open-source desktop and CLI agent with any model, MCP extensions, recipes with a cron scheduler, subagents and smart approvals. It is the vendor-neutral, foundation-governed option. |
| 9 | **n8n** (AI agents) | ~212k stars. The most popular self-hosted automation platform with native AI agents. It is the benchmark for scheduling, human approval of tool calls, forms, data tables and team RBAC: all the "automate" parts the coding harnesses lack. |
| 10 | **pi** (pi.dev, Earendil) | Added in draft 2 at the owner's request. ~124k stars, MIT. The deliberately minimal coding agent: a small core, then everything else as packages from a 5,500-package catalogue. It is the "build it yourself" end of the range. |

### Considered and left out

| Product | Why it is out |
|---|---|
| **DeepSeek Harness** (`deepseek-ai/deepseek-harness`) | Big on stars: 287.5k, the #2 agent repo, published 2026-08-13 [^63][^62]. Left out because it is a "developer preview" that warns "THERE WILL BE COMPATIBILITY-BREAKING CHANGES". Its README documents almost none of the matrix features (memory, scheduling, MCP, multi-user), so nearly every cell would read unknown [^63]. Worth re-checking in a quarter. |
| **Gemini CLI** | 109.2k stars, Apache-2.0. Per its README, free individual access and Google AI Pro/Ultra moved to **Antigravity CLI** on 2026-06-18. The repo now targets Gemini Code Assist Standard/Enterprise users [^64]. It is a coding tool and its consumer story has moved elsewhere. |
| **Cline, Aider, Cursor, Devin** | These are coding agents inside an IDE or a dev SaaS. None is a personal or household agent. Cline is ~70k stars [^62]. |
| ~~**Pi**~~ | Left out in draft 1 as a deliberately minimal agent loop [^62]. Added in draft 2 as product 10 (see section 10). |
| **OpenHands** | ~93k stars, but an autonomous software-dev platform [^62]. |
| **Manus** | Closed SaaS. Meta agreed to acquire it in December 2025 [^65]. I could not verify current pricing or 2026 product status. |
| **LibreChat** | Overlaps Open WebUI. Open WebUI is the larger project, so it stands in for this category. I did not check LibreChat's current numbers. |

### GitHub stars snapshot (2026-11-26)

| Repo | Stars | Source |
|---|---|---|
| openclaw/openclaw | 395.3k | [^31] |
| deepseek-ai/deepseek-harness | 287.5k | [^63] |
| NousResearch/hermes-agent | 266.3k | [^39] |
| anomalyco/opencode (was sst/opencode) | 229.3k | [^5] |
| n8n-io/n8n | 212.2k | [^56] |
| open-webui/open-webui | 159.6k | [^50] |
| anthropics/claude-code (issues, plugins and examples; not the source) | 157.2k | [^23] |
| openai/codex | 136.6k | [^43] |
| earendil-works/pi (was badlogic/pi-mono) | 124.1k | [^70] |
| google-gemini/gemini-cli | 109.2k | [^64] |
| aaif-goose/goose (was block/goose) | 57.0k | [^52] |
| ogulcancelik/herdr | 53.0k | [^1] |

---

## 1. OpenCode

- **One line:** "The open source coding agent." It is a terminal UI plus a beta desktop app, with built-in `build` and `plan` agents [^5].
- **Right project?** Yes. `github.com/sst/opencode` now resolves to **`anomalyco/opencode`**: MIT, ~229.3k stars [^5]. Do not confuse it with `opencode-ai/opencode`, an unrelated Go project that shares the name.
- **Why included:** required.
- **Checked:** 2026-11-26.

**Facts**

- **License:** MIT [^5].
- **Runs locally:** local binary. Docker images exist [^15]. A server runs as a background service or as `opencode serve`, and can sit under systemd or Docker [^11].
- **Models:** many built-in providers via models.dev. Ollama, LM Studio and vLLM are supported, and any OpenAI-compatible server can be configured by hand [^9].
- **Multi-user:** no per-person accounts. The web/server mode is protected by one password. HTTP clients use Basic auth with the username always `opencode` [^11]. OpenCode sells a "Teams" plan for its model subscription, with no price listed [^14].
- **Approvals:** ordered `allow` / `ask` / `deny` rules per tool. The default is `ask` when no rule matches. Replies are `once`, `always` (saved as project-scoped allow rules) or `reject`. Global and Console-managed policies can hard-deny [^6].
- **Undo:** `/undo` "revert[s] the latest user message and the work that followed it", and `/redo` restores it [^10].
- **Memory:** instruction files only. It reads `AGENTS.md`, a global `~/.config/opencode/AGENTS.md`, and falls back to `CLAUDE.md`. The docs describe no learned memory [^13].
- **Scheduled and background work:**
  - Subagents "always run in the background" [^7].
  - There is no built-in scheduler in the docs. Scheduling exists only through third-party plugins such as `opencode-scheduler`, which wraps `opencode run` in launchd, systemd or Task Scheduler [^16] *(3rd party)*.
- **Tools and extensions:**
  - MCP servers, commands and plugins [^15].
  - Plugins can be npm packages or local `.ts`/`.js` files auto-loaded from `.opencode/plugins/`, and can "add tools, hooks, integrations, commands, agents" [^8].
  - Skills use `SKILL.md` files in `.opencode/skills/<id>` [^12].
- **Self-extension:** plugins are plain local files that load automatically, so the agent *could* write one. The docs do not describe the agent doing this [^8].
- **Surfaces:**
  - TUI and desktop (macOS, Windows, Linux) [^5][^15].
  - A web UI served by the same server, opened via a one-time `opencode pair` link. `--remote` uses an end-to-end-encrypted tunnel [^11].
  - "The OpenCode app" connects by scanning the pairing QR code [^11]. That is the only mobile mention.
- **Structured questions:** a `question` tool exists in the permission list [^6].
- **Images:** a `generate_image` tool exists [^6]. PDF handling: unknown.
- **Sandbox:** none documented. The docs warn that `shell` runs "with the host user's filesystem, process, and network authority" and recommend narrow allowlists [^6].
- **Sub-agents:** `general` and `explore` subagents plus custom ones. Each runs in its own child session with its own permissions [^7].
- **Price:** the tool is free.
  - Optional OpenCode **Go** model plan: $10/mo. **Go Plus:** $40/mo [^14].
  - Zen is pay-as-you-go [^14].
- **Unknown:** cost tracking or budgets in the client, voice, dashboards, databases.

## 2. Claude (Claude Code + Claude apps)

**One column or two?** One column, **"Claude (Code + apps)"**, with "Code:" and "apps:" written inside a cell wherever the two differ. The reasons:

1. It is one account and one subscription. Pro, Max, Ultra, Team and Enterprise all include Claude Code, and Team includes Cowork [^24]. Usage allowances are shared across chat, Claude Code and Cowork [^20].
2. The extension model is shared:
   - Skills follow one open spec and appear in both [^28].
   - Plugins bundle skills, connectors and agents [^28].
   - Cowork "uses the same agentic architecture that powers Claude Code" [^25].
3. Sessions move between surfaces: web, desktop, mobile and CLI, via Remote Control, teleport and Dispatch [^17].
4. Splitting Claude into two columns would mean splitting Codex and ChatGPT too, and would push the matrix past ~9 columns.

The cost of one column is that a few cells need a split. "Open source: no" is true of both. Undo and the sandbox are Code-only. Voice is apps-only.

- **One line:** Anthropic's agent harness. Claude Code (CLI, IDE, desktop, web, mobile) for coding and automation, plus the Claude apps: chat, Cowork, Projects, memory, skills, connectors and scheduled tasks [^17][^25].
- **Why included:** required.
- **Checked:** 2026-11-26.

**Facts**

- **License:** proprietary. The `anthropics/claude-code` repo's LICENSE says use is "subject to Anthropic's Commercial Terms of Service" [^23]. The repo holds plugins, examples and issues, not the core source [^23].
- **Runs locally:** the CLI and the desktop app run on your machine. The model is always remote: Anthropic, Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry [^17][^20]. Cloud sessions run on Anthropic's machines [^17].
- **Models:** Claude models only. Anthropic "doesn't support routing Claude Code to non-Claude models through any gateway" [^22]. No local models.
- **Multi-user:**
  - Team and Enterprise plans have SSO, shared Projects and central billing. Enterprise adds role-based access, SCIM and audit logs [^24].
  - Admins set spend limits per organization, group or member [^20].
  - Skills can be shared or published to the organization [^29].
  - There is no household or family plan on the pricing page [^24].
- **Approvals:**
  - Code: permission modes (manual, `acceptEdits`, plan, auto with a classifier, `dontAsk`, `bypassPermissions`) and per-tool allow/ask rules [^19].
  - Apps: Cowork can only reach folders and connectors you choose [^25].
- **Undo:**
  - Code: automatic checkpoints before each prompt. `/rewind` (alias `/undo`) restores code, conversation or both, keeping the last 100 checkpoints. Files changed only by Bash, and edits by background subagents, are not tracked [^18].
  - Apps: unknown.
- **Memory:**
  - Code: `CLAUDE.md` (or `AGENTS.md`) plus **auto memory** that "sav[es] learnings across sessions without you writing anything" [^17].
  - Apps: account memory and past-chat search. Each project has its own memory. Memory can be turned off per chat, and incognito exists [^27].
- **Scheduled and background work:**
  - Cloud scheduled tasks (formerly "routines") run "even when your computer is off" and can trigger on API calls or GitHub events.
  - Desktop scheduled tasks run on your machine, and `/loop` repeats a prompt inside a session [^17].
  - Cowork scheduled tasks run remotely, each as its own session [^26].
  - Background agents and web sessions run while you are away [^17].
- **Tools and extensions:** MCP connectors, skills, hooks, plugins and plugin marketplaces [^17][^28]. Enterprise admins can run private plugin marketplaces [^25]. Channels push Telegram, Discord, iMessage or webhook events into a session [^17].
- **Self-extension:**
  - Code: skills are folders on disk (`~/.claude/skills/<name>/SKILL.md`). Claude can write one and it loads on the next session [^29].
  - Apps: the `skill-creator` skill drafts and evaluates skills with you, and you upload the result as a ZIP [^29].
- **Surfaces:** terminal CLI, VS Code and JetBrains, the desktop app (macOS, Windows, Linux beta), web (claude.ai/code), iOS and Android, and Slack via Claude Tag (Team and Enterprise) [^17].
- **Databases and structured data:** no built-in database. Connectors reach external data, and artifact **dashboards (beta)** are built from data platforms or connected apps, with the query shown on each chart [^30].
- **Files:** Cowork reads and writes local files directly. It produces Excel files with working formulas, PowerPoint decks and formatted documents [^25]. Anthropic skills create Word, Excel, PowerPoint and PDF files [^28].
- **Structured questions:**
  - Code: the `AskUserQuestion` tool "asks multiple-choice questions to gather requirements or clarify ambiguity" [^21].
  - Apps: unknown.
- **Dashboards and widgets:** artifacts cover dashboards, charts, diagrams and small interactive tools that can call Claude and read or write connected apps [^30].
- **Cost tracking:**
  - Code: `/usage` shows estimated session cost, attributes usage to skills, subagents, plugins and MCP servers, and makes recommendations. `--max-budget-usd` caps spend. Team and Enterprise get spend reports with CSV export, and org, group or member spend limits. OpenTelemetry export is available [^20].
- **Voice:** voice mode on every plan, including Free [^24].
- **Sandbox:**
  - Code: an opt-in OS sandbox for shell commands (Seatbelt on macOS; bubblewrap on Linux and WSL2). Network goes through a proxy with a hostname allowlist. Native Windows commands run unsandboxed [^19].
  - Apps: skills run in Claude's code sandbox [^28].
- **Sub-agents:** subagents, agent teams (experimental), background agents and dynamic workflows that orchestrate many subagents [^17][^20][^21]. Cowork splits complex work into parallel workstreams [^25].
- **Price:**
  - Free: $0.
  - Pro: $20/mo ($17/mo billed annually).
  - Max: $100/mo.
  - Ultra: $200/mo.
  - Team: Standard $25/seat/mo ($20 annual), Premium $125 ($100 annual).
  - Enterprise: $20/seat/mo annual, 20-seat minimum, plus API usage.
  - Claude Code needs Pro or above [^24].

## 3. herdr

- **What it is:** **herdr is not an agent.** It is "the runtime your coding agents live on" [^2].
  - It is a Rust background server, `herdr-core`, that keeps agent terminals alive across disconnects. It flags each agent as working, blocked or done, so you see which one needs you [^2][^3].
  - Clients are a TUI, a native app, a phone app, and SSH from other machines [^3][^4].
  - It runs Claude Code, Codex, OpenCode, Cursor, Grok and other terminal agents in real terminals [^2]. Search snippets of the README also list Droid, Amp and Hermes Agent *(3rd party)*.
- **Which project:** `github.com/ogulcancelik/herdr`, site **herdr.dev**. It is a Y Combinator Fall 2026 company: founder Can Celik, Ankara, team of one [^1][^3][^4].
- **How sure:** high, about 90%.
  - The name matches exactly. The repo is large (53.0k stars, 4.3k forks) [^1].
  - YC lists herdr.dev as the company site and describes the same product [^4]. "Can Celik" (YC) and `ogulcancelik` (GitHub) are very likely the same person; that link is my inference.
  - Many forks and mirrors exist (`aliou/herdr`, `nsega/herdr`, …), and a different project, NickGuAI's "Herd", has a similar name. None comes close in size or official status.
- **Why included:** required. It is also a useful contrast: it is the "many agents, one control room" layer that the other columns either build in (subagents) or lack.
- **Checked:** 2026-11-26.

**Facts**

- **License:** Apache-2.0 [^1][^2], and "The app, herdr-core and Herdr TUI are all open source" [^3]. Older README mirrors say AGPL-3.0, so the license appears to have changed. Cite Apache-2.0 from the official repo.
- **Runs locally:** yes. Native on macOS (Apple silicon), Linux (x86_64, arm64) and Windows (x86_64). Remote machines join over SSH or Tailscale [^3].
- **Models:** not applicable. herdr runs whichever agent CLI you start, so model choice belongs to that agent [^2].
- **Accounts:** "No account, and your terminals never pass through us" [^3]. No team features are mentioned.
- **Approvals:** none of its own. It surfaces agents that are **blocked** waiting for your answer, and you can reply from your phone [^2][^3].
- **Undo, memory, scheduling:** not mentioned [^2][^3]. Agents keep running in the background server, but after a reboot their panes reopen as plain shells [^3].
- **Extensions:** "mods" are JavaScript files in `mods/`; the site cites "576 mods". There is a plugin marketplace and a documented agent skill [^2][^3]. MCP is not mentioned.
- **Self-extension: yes.** Layouts, keys, themes and mods are plain files, and an `AGENTS.md` explains them to your agent: "You say what you want and your agent writes it" [^3].
- **Surfaces:**
  - TUI and a native app [^3].
  - Mobile apps for iPhone, iPad and Android. From the phone you can see who needs you, open the live terminal, and reply by typing, pasting a screenshot or talking [^3].
  - No web UI is mentioned [^3].
- **Agent-to-agent work:** an agent can start helper agents, steer them and get their reports, through the CLI and socket API [^2][^3].
- **Traction:** YC reported 25k stars and 340k downloads four months after launch [^4]. The README notes it was #1 on GitHub Trending on 2026-06-30 *(3rd-party snippet)*.
- **Price:** free [^3].

## 4. OpenClaw

- **One line:** "The AI that really does things." It is a self-hosted, always-on personal assistant that you message through Discord, iMessage, Slack, Teams, Telegram, WhatsApp, Signal and "20+ more" [^31].
- **Why included:** the most-starred agent project (395.3k) [^31]. It is the archetype of a personal or household agent: memory, cron, skills and multi-user.
- **Checked:** 2026-11-26.

**Facts**

- **License:** MIT [^31].
- **Runs locally:** yes. A self-hosted Gateway with native apps for macOS, iOS, Android, Windows and Linux [^31].
- **Models:** hosted and local providers. Agent harnesses such as Claude, Codex and local models are swappable plugins [^31].
- **Multi-user ("multiplayer"):** one shared Gateway [^32].
  - Each person signs in and gets their own profile.
  - Sessions record a creator, an owner and who prompted.
  - Roles (`gateway.roles`) set which sessions and agents a person can use, their operator scopes, and whether their sessions must be sandboxed.
  - Session access can be view, write or invited-only.
  - Caveat from the docs: "A gateway is one trust domain." For users who do not trust each other, run "one gateway per tenant."
- **Approvals:** host command "exec approvals" policy, plus elevated exec [^33].
- **Undo:** the Skill Workshop keeps the previous version of each skill the agent edits, so that change can be undone [^36]. General undo of actions: unknown.
- **Memory:** plain Markdown on disk; "there is no hidden state" [^34].
  - `MEMORY.md` holds long-term facts and loads each session.
  - Daily notes are indexed for search, and a background "dreaming" process distills them into `MEMORY.md`.
  - Search is hybrid vector plus keyword, on SQLite by default or PostgreSQL.
- **Scheduled work:** an `automations` tool (alias `cron`), plus hooks and webhooks [^33].
- **Tools and extensions:**
  - Skills follow the AgentSkills spec [^36]. Plugins are built on a plugin SDK, and the ClawHub marketplace hosts shared ones [^31].
  - MCP works both ways: client (`mcp.servers`) and server (`openclaw mcp serve`) [^35].
- **Self-extension: yes.** The Skill Workshop lets the agent "save and update its own skills", visible to that agent only. Installing from ClawHub is shown as a CLI command, not something done from chat [^36].
- **Surfaces:** chat apps, a web Control UI, CLI, TUI, and native desktop and mobile apps [^31].
- **Files:** `view_image` and `image_generate` tools. PDF: not stated [^33].
- **Widgets:** Canvas, "the macOS widget-panel presenter" [^33]. MCP Apps can show sandboxed interactive views (opt-in) [^35].
- **Cost tracking:** `/usage cost`, a per-response usage footer, and a cost analysis in the Control UI, based on your own pricing config [^37]. I found no dollar budget or cap.
- **Voice:** companion apps and nodes add voice, camera and screen actions [^31]. A `tts` tool exists [^33].
- **Sandbox:** tools run **on the host by default** unless you configure sandboxing. Sandboxing can be set per agent or per role [^31][^32].
- **Security record:** in 2026 a Koi Security audit found 341 malicious skills among 2,857 on ClawHub ("ClawHavoc"). ClawHub now scans with VirusTotal and rescans daily [^38] *(press)*.
- **Sub-agents:** `sessions_*` and `subagents` tools [^33].
- **Price:** free and open source. You pay your model provider.

## 5. Hermes Agent (Nous Research)

- **One line:** "The self-improving AI agent built by Nous Research." It is a CLI and messaging-gateway agent that learns skills and curates its own memory [^39].
- **Why included:** 266.3k stars [^39]. It is the clearest example of a harness that extends itself.
- **Checked:** 2026-11-26.

**Facts**

- **License:** MIT [^39].
- **Runs locally:** yes. Terminal backends: local, Docker, SSH, Modal, Daytona and Vercel Sandbox [^39].
- **Models:** "Use any model you want", including your own endpoint [^39].
- **Multi-user:** partial. One gateway serves Telegram, Discord, Slack, WhatsApp, Signal, email and the CLI, with DM pairing [^39]. "Profiles" are isolated Hermes instances [^40]. Per-person permissions: unknown.
- **Approvals:** command approval, DM pairing and container isolation [^39].
- **Undo:** opt-in checkpoints snapshot the project before destructive operations, and `/rollback` restores them [^40][^41].
- **Memory:** "Agent-curated memory with periodic nudges" in `MEMORY.md` and `USER.md`, FTS5 session search, and Honcho user modelling [^39][^40].
- **Scheduled work:** a built-in cron scheduler, set in natural language or cron syntax, that delivers results to any platform. Jobs can be paused or edited [^40].
- **Tools and extensions:** any MCP server (stdio or HTTP) with per-server filtering. Plugins are general, memory-provider or context-engine plugins. Skills follow agentskills.io [^39][^40].
- **Self-extension: yes.** "Autonomous skill creation after complex tasks", with skills that improve as they are used [^39].
- **Surfaces:** CLI/TUI, messaging platforms, a desktop app with wake word, and a web dashboard (`hermes dashboard`) for config, keys and sessions [^40][^42].
- **Files:** image paste for vision models, image generation via FAL.ai, and browser automation that can fill web forms [^40]. PDF: not covered.
- **Voice:** voice mode in the CLI and messaging apps, Discord voice channels, and voice-memo transcription [^39][^40].
- **Sub-agents:** `delegate_task` runs up to 10 concurrent child agents by default [^40].
- **Price:** free and open source.
- **Unknown:** cost tracking or budgets, structured forms, dashboards beyond the admin panel, databases.

## 6. OpenAI Codex (+ ChatGPT)

- **One line:** OpenAI's coding agent. It runs in the CLI, the IDE, the desktop app (now the ChatGPT desktop app, "with ChatGPT and Codex, including Chat and Work") and Codex Cloud [^43][^45].
- **Why included:** the closest like-for-like to Claude Code plus the Claude apps, from the other frontier lab. Codex CLI has 136.6k stars [^43].
- **Checked:** 2026-11-26. Codex docs moved from developers.openai.com to learn.chatgpt.com.

**Facts**

- **License:** Codex CLI is Apache-2.0 [^43]. ChatGPT and Codex Cloud are proprietary.
- **Runs locally:** the CLI runs locally. Cloud tasks run in OpenAI environments [^43][^44].
- **Models:** OpenAI models by default.
  - `--oss` routes to local Ollama or LM Studio [^47].
  - Custom providers go in `config.toml` [^47] *(Ollama and LM Studio docs)*.
- **Multi-user:** ChatGPT Business "available starting at 2 users", and Enterprise [^49]. Per-person permission detail: unknown.
- **Approvals:**
  - An approval policy decides when Codex must ask [^45].
  - **Automatic approval review** has a model review eligible requests [^45].
  - CLI levels are `untrusted`, `on-request` and `never` [^46].
- **Undo:** no undo command is documented. The docs recommend Git checkpoints before and after a task [^44].
- **Memory:** "Memories: locally stored context Codex can reuse across sessions" [^45]. ChatGPT memory comes with each plan [^49].
- **Scheduled work:** scheduled tasks are "a prompt ChatGPT runs at a future time or on a recurring schedule" [^45]. Every plan except Free has them [^49]. Codex Cloud tasks run remotely [^44].
- **Tools and extensions:** MCP (`codex mcp`), skills and plugins. Plugins come from a directory shared by ChatGPT and Codex [^44][^45].
- **Self-extension:** built-in `skill-creator`, `skill-installer` and `plugin-creator` system skills [^48] *(3rd party)*.
- **Surfaces:** CLI, IDE (VS Code, Cursor, Windsurf), desktop app, and web (chatgpt.com/codex) [^43]. ChatGPT Work is on mobile for Plus and Pro [^49].
- **Files:** `--image` and pasted images [^44].
- **Voice:** in ChatGPT plans [^49]. Voice inside Codex itself: unknown.
- **Sandbox:** an OS-enforced sandbox, "typically limit[ing] writes to the current workspace" [^45][^46].
- **Sub-agents:** subagents, Git worktree mode and cloud tasks [^44][^45].
- **Price:** the CLI is free with an API key, or you sign in with a ChatGPT plan [^43].
  - Go: $8/mo.
  - Plus: $20/mo.
  - Pro: $100, $200 or $500/mo [^49b] *(3rd party; OpenAI's pricing page showed no figures when fetched)*.
- **Unknown:** cost tracking or budgets, structured questions, dashboards, databases.

## 7. Open WebUI

- **One line:** "User-friendly AI Interface (Supports Ollama, OpenAI API, ...)". It is a self-hosted, multi-user chat platform [^50].
- **Why included:** 159.6k stars [^50]. It is the standard "AI server for the household or office": real user management, plus memory, schedules and voice.
- **Checked:** 2026-11-26.

**Facts**

- **License:** the "Open WebUI License", which "requires preserving the Open WebUI branding" [^50]. That makes it source-available with a branding condition, not OSI open source.
- **Runs locally:** yes, "built to run entirely offline". Install with pip/uv, Docker or the desktop app [^50].
- **Models:** Ollama plus OpenAI-compatible APIs, local or cloud. Agents connect through ACP [^50].
- **Multi-user: yes.** Roles, groups and per-resource permissions, access to each model, SSO/OIDC/LDAP, and SCIM 2.0 [^51].
- **Memory:** "recall facts about the user across conversations" [^51].
- **Scheduled work:** prompts can run on recurring schedules [^51].
- **Tools and extensions:** Python tools and functions with an in-browser editor and version history. Native MCP over Streamable HTTP [^51].
- **Data:** knowledge bases that support 13 vector databases and 8 extraction engines [^51].
- **Collaboration:** Channels (people and models in one conversation) and Notes [^51].
- **Media and voice:** image generation and editing; voice and video calls, including realtime; STT and TTS [^51].
- **Code execution:** in the browser, or in Open Terminal with Docker isolation [^51].
- **Admin:** analytics dashboards for messages, tokens and costs; A/B evaluation with ELO leaderboards [^51].
- **Price:** free to self-host. Enterprise license pricing: unknown.
- **Unknown:** approvals before tool actions, undo, self-extension from chat, sub-agents, structured forms, mobile/PWA.

## 8. goose

- **One line:** "an open source, extensible AI agent that goes beyond code suggestions." It is a desktop app and CLI, now governed by the Agentic AI Foundation at the Linux Foundation [^52].
- **Why included:** the leading vendor-neutral, foundation-governed general agent. It has the full automation set: recipes, a scheduler, subagents and smart approvals.
- **Checked:** 2026-11-26.

**Facts**

- **License:** Apache-2.0 [^52].
- **Runs locally:** yes. Desktop for macOS, Linux and Windows, plus the CLI [^52].
- **Models:** "over 85 providers", and it can "load and run local models directly" [^52][^53].
- **Approvals:** modes are Autonomous, Manual Approval, **Smart Approval** (risk-based) and Chat Only. Each tool can be set to always allow, ask or never [^54].
- **Memory:** a Memory extension saves commands, snippets and preferences, for one project or globally, across sessions [^66].
- **Scheduled work:** recipes run on a schedule. The desktop Scheduler and `goose schedule add --cron` both turn the schedule into a cron expression [^55].
- **Tools and extensions:** MCP, with "70+ documented extensions" [^53]. Recipes are portable YAML that can be shared with a team [^53].
- **Sub-agents:** "handle tasks in parallel" [^53]. Sub-recipes also exist [^55].
- **Sandbox:** "tool permission controls" and a sandbox mode [^53].
- **Price:** free.
- **Unknown:** multi-user, undo, self-extension, voice, cost tracking, forms, dashboards, databases, files.

## 9. n8n (AI agents)

- **One line:** "Fair-code workflow automation platform with native AI capabilities." It combines a visual builder with code, self-hosted or in the cloud [^56].
- **Why included:** 212.2k stars [^56]. It is the reference point for automation, approvals, forms, data and team RBAC.
- **Checked:** 2026-11-26.

**Facts**

- **License:** fair-code, under the Sustainable Use License and the n8n Enterprise License [^56]. That is source-available, not OSI open source.
- **Self-hostable:** yes; Docker quick start [^56].
- **Models:** OpenAI, Anthropic, Google "or open-source models", swappable without redesigning a workflow [^56].
- **Multi-user:** shared projects and roles, by tier [^57].
  - Starter: project admins only.
  - Pro: admin and editor roles.
  - Enterprise: viewer and custom roles.
  - SSO and LDAP from Business up.
- **Approvals:** "Add human review step" on any AI Agent tool connection. The request goes to Slack, Gmail, Teams or n8n Chat, and the workflow waits [^58].
- **Memory:** a memory component per agent workflow ("add tools and memory") [^67]. Account-wide memory: unknown.
- **Scheduled work:** the Schedule Trigger runs workflows "at fixed intervals and times" [^68].
- **Tools and integrations:** "400+" or "1500+" integrations; the README contradicts itself [^56]. An MCP Server Trigger exposes n8n tools as an MCP server [^59], and there is also an MCP client [^56].
- **Self-extension:** partial. n8n's MCP server includes workflow-builder and data-table tools, so an agent can build workflows [^61].
- **Data:** data tables, reachable through the MCP tools [^61].
- **Forms:** the n8n Form Trigger generates a web form that starts a workflow [^60].
- **Dashboards:** Insights tables and dashboards on Pro and up [^57].
- **Sub-agents:** an AI Agent can be used as a tool by another agent [^58].
- **Price:** the self-hosted Community Edition has no price on the pricing page.
  - Starter: €20/mo.
  - Pro: €50/mo.
  - Business (self-hosted): €667/mo.
  - All billed annually. Enterprise: contact sales [^57].
- **Unknown:** undo, voice, cost tracking of model spend, sandboxing.

## 10. pi (pi.dev)

- **One line:** "Pi is a minimal, extensible agent harness that you can make your own." It is a terminal coding agent with print/JSON, RPC and SDK modes. Its pitch: "Adapt Pi to your workflows, not the other way around" [^69][^71].
- **Which project:** the owner wrote "pi.dec". This is almost certainly **pi at pi.dev**: the `pi` CLI, npm `@earendil-works/pi-coding-agent`, source in the `earendil-works/pi` monorepo (124.1k stars), which `github.com/badlogic/pi-mono` now resolves to [^69][^70].
  - Mario Zechner (badlogic) created it. In April 2026 he wrote that "pi is owned by Earendil, the company", that he, Armin and Colin decide its direction, and that "pi is MIT licensed. It will stay MIT licensed" [^80].
  - **How sure:** high, about 90%. ".dec" is one key from ".dev" (c sits next to v on a keyboard). The draft-1 left-out list already named Pi, and no other agent product matches "pi.dec". The unrelated Inflection "Pi" chatbot (pi.ai) is the only other plausible reading, and it is a consumer chatbot, not a harness.
- **Why included:** the owner asked. It is also the clearest "small core, build the rest yourself" contrast: the harness ships features that pi leaves to packages.
- **Checked:** 2026-11-26. The site announces Pi 1.0, shipped "with Pi Durable" (not described further) [^69].

**Facts**

- **License:** MIT [^70]. Mario writes that some future commercial features will be Fair Source, plus proprietary enterprise and cloud tiers, none built yet [^80].
- **Runs locally:** yes. Install scripts for macOS/Linux and Windows, or npm/pnpm/bun. It needs Node.js 22.19 or newer [^69][^71].
- **Models:** "over 15 providers": Anthropic, OpenAI, Google, Azure, Bedrock, Mistral, Groq, xAI, OpenRouter and Ollama, among others [^69].
  - Local: it connects directly to a llama.cpp router (`/llama`). Ollama, LM Studio, vLLM and SGLang go in `models.json` as OpenAI-compatible endpoints [^75].
  - `/login` signs in with a supported subscription [^75].
  - `/model` and `Ctrl+P` switch models one at a time. The docs describe no side-by-side comparison [^75].
- **Multi-user:** not described. It is a single-user terminal tool [^72].
- **Approvals: none built in.** "No permission popups." The site suggests running in a container or building "your own confirmation flow" with an extension [^69]. The security page says pi "does not ask for approval before every tool call" [^74]. "Project trust" asks only whether to load a folder's settings and extensions. It "does not sandbox tool calls" [^72][^74].
- **Undo:** none as such. Sessions are stored as a tree. "returning to an earlier point does not erase the branch you leave" (`/tree`), and `/fork` and `/clone` branch into new sessions. The docs do not say that file edits are reverted [^73].
- **Memory:** no built-in memory. `AGENTS.md` files load project instructions, and the site says extensions can "build long-term memory" [^69]. The catalogue has memory packages (for example `pi-memory`), all third-party [^78].
- **Scheduled and background work:** not in the docs. Background bash is left out on purpose: the site recommends tmux [^69].
- **Tools and extensions:**
  - TypeScript extensions add tools, commands, shortcuts, events and TUI elements. Skills, prompt templates and themes are also supported [^69][^71].
  - **Pi packages** bundle these and are shared via npm or git. The public catalogue at pi.dev/packages listed **5,547 packages** on 2026-11-26. Install with `pi install npm:<package>` [^78].
  - **MCP:** "MCP is built in, and Codemode lets agents compose tool calls in a JavaScript sandbox." That is new: the site used to say "No MCP" [^69].
- **Self-extension: yes, the headline feature.** "just ask Pi to build it. It will customize itself on the fly." Then "Have Pi manipulate itself in place, hit `/reload`, and keep going" [^69].
- **Sandbox:** none built in; the security page names the "lack of a built-in sandbox" [^74]. The containerization page documents plain Docker, Docker Sandboxes, NVIDIA OpenShell, and a Gondolin micro-VM extension. Gondolin moves only the built-in tools into the VM; other extensions stay on the host [^77].
- **Sub-agents:** "No sub-agents." Instead: "Spawn Pi instances via tmux, or build your own with extensions, or install a package" [^69].
- **Surfaces:**
  - Terminal TUI, print/JSON, RPC and SDK. No web, desktop or mobile app is described [^69][^72].
  - The docs have a Termux on Android page [^72].
  - **pi-chat** (earendil-works) is an extension that "bridges Discord and Telegram channels to a sandboxed pi session", with one Gondolin micro-VM per channel [^79]. Its sidebar says Apache-2.0 and its README says MIT.
- **Files:** "Paste an image or drag it into a compatible terminal", and `@` adds a file to the prompt [^76]. PDF and spreadsheets: not covered.
- **Cost tracking:** the footer shows "accumulated usage and cost", also in `/session`. No spend limit is described [^75][^76].
- **Voice, forms, dashboards, databases:** not in the docs.
- **Price:** free. You pay your model provider or use a subscription login [^69][^75].

---

## Raw feature matrix

**Cell legend**

- **yes:** documented and built in.
- **partial:** limited, opt-in, via plugin or third party, or only on one surface. The note says which.
- **no:** the docs say it is absent, or the product's design excludes it.
- **unknown:** sources do not say.
- **n/a:** does not apply (herdr is not an agent).

"via MCP" alone does not count as a built-in database or file feature; any product with MCP can reach those.

| Feature | OpenCode | Claude (Code + apps) | herdr | OpenClaw | Hermes Agent | Codex (+ChatGPT) | Open WebUI | goose | n8n |
|---|---|---|---|---|---|---|---|---|---|
| **One-liner** | Open-source terminal coding agent [^5] | Anthropic's agent: Code + chat/Cowork apps [^17][^25] | Runtime/multiplexer for many coding agents [^2] | Self-hosted personal assistant over chat apps [^31] | Self-improving agent + messaging gateway [^39] | OpenAI coding agent inside ChatGPT [^43][^45] | Self-hosted multi-user AI chat [^50] | Open desktop/CLI agent, AAIF [^52] | Workflow automation with AI agents [^56] |
| **Open source & license** | yes, MIT [^5] | no, proprietary [^23] | yes, Apache-2.0 [^1] | yes, MIT [^31] | yes, MIT [^39] | partial: CLI Apache-2.0; ChatGPT/cloud closed [^43] | partial: Open WebUI License (branding clause) [^50] | yes, Apache-2.0 [^52] | partial: Sustainable Use License (fair-code) [^56] |
| **Self-hostable / runs locally** | yes [^11][^15] | partial: client local, models in the cloud [^17][^22] | yes [^3] | yes [^31] | yes [^39] | partial: CLI local, cloud tasks remote [^43][^44] | yes, fully offline [^50] | yes [^52] | yes [^56] |
| **Model choice (any provider / local)** | yes: any + Ollama/LM Studio/vLLM [^9] | no: Claude models only, no local [^22] | n/a: uses whatever agent runs [^2] | yes: hosted + local [^31] | yes [^39] | partial: OpenAI + `--oss` local [^47] | yes: Ollama + OpenAI-compatible [^50] | yes: 85+ providers + local [^52] | yes [^56] |
| **Multi-user / household / team, per-person permissions** | no: one shared password [^11] | partial: Team/Enterprise seats, SSO, RBAC (Ent.), per-member spend limits; no household plan [^24][^20] | no: no accounts [^3] | yes: roles, per-role sandbox; "one trust domain" [^32] | partial: profiles, DM pairing [^39][^40] | partial: Business/Enterprise workspaces; detail unknown [^49] | yes: roles, groups, per-resource perms, SSO, SCIM [^51] | unknown | yes: projects + roles by tier [^57] |
| **Approvals before actions** | yes: allow/ask/deny rules [^6] | yes: permission modes, plan, auto classifier [^19] | partial: shows "blocked" agents; approval is the agent's [^2] | yes: exec approvals [^33] | yes: command approval [^39] | yes: approval policy + auto-review [^45] | unknown | yes: manual/smart/per-tool [^54] | yes: human review on tool calls [^58] |
| **Undo** | yes: `/undo` `/redo` [^10] | partial: Code `/rewind` checkpoints (not Bash-only files); apps unknown [^18] | unknown | partial: skill versions only [^36] | yes: opt-in checkpoints `/rollback` [^41] | partial: no command; use Git [^44] | unknown | unknown | unknown |
| **Memory across chats** | partial: AGENTS.md rules only [^13] | yes: Code auto memory; apps memory + chat search [^17][^27] | n/a | yes: MEMORY.md + daily notes + search [^34] | yes: curated memory, session search, user model [^39] | yes: Memories + ChatGPT memory [^45][^49] | yes [^51] | yes: Memory extension [^66] | partial: per-workflow memory component [^67] |
| **Scheduled / background tasks** | partial: background subagents; schedules only via 3rd-party plugin [^7][^16] | yes: cloud + desktop scheduled tasks, `/loop`, Cowork [^17][^26] | partial: keeps agents running; no scheduler [^3] | yes: cron/automations, webhooks [^33] | yes: cron to any platform [^40] | yes: scheduled tasks, cloud tasks [^45][^44] | yes: recurring prompts [^51] | yes: scheduled recipes [^55] | yes: Schedule Trigger [^68] |
| **Tools / integrations (MCP, plugins, skills)** | yes: MCP, npm plugins, skills [^8][^12][^15] | yes: MCP connectors, skills, plugins, hooks [^17][^28] | partial: mods, plugin marketplace; no MCP [^3] | yes: skills, plugins, ClawHub, MCP [^35][^36] | yes: MCP, plugins, skills [^40] | yes: MCP, skills, plugins [^44][^45] | yes: Python tools, native MCP [^51] | yes: MCP, 70+ extensions [^53] | yes: 400+ integrations, MCP [^56][^59] |
| **Extends itself (writes and installs its own tools from chat)** | partial: local plugin files auto-load; not documented as an agent flow [^8] | yes in Code (skills on disk); partial in apps (skill-creator, then upload) [^29] | yes: "say what you want and your agent writes it" [^3] | yes: Skill Workshop [^36] | yes: autonomous skill creation [^39] | yes: skill-creator / skill-installer [^48] | unknown | unknown | partial: agent builds workflows via MCP [^61] |
| **Web UI** | yes [^11] | yes [^17] | no [^3] | yes: Control UI [^31] | yes: dashboard [^42] | yes [^43] | yes [^50] | unknown | yes [^56] |
| **Mobile** | partial: app via pairing QR [^11] | yes: iOS/Android [^17] | yes: iOS/Android [^3] | yes: iOS/Android + chat apps [^31] | partial: via messaging apps [^39] | yes: ChatGPT apps [^49] | unknown | unknown | unknown |
| **CLI** | yes [^5] | yes [^17] | yes: TUI [^3] | yes [^31] | yes [^39] | yes [^43] | unknown | yes [^52] | unknown |
| **Desktop app** | yes, beta [^5] | yes [^17] | yes [^3] | yes [^31] | yes [^40] | yes [^43] | yes [^50] | yes [^52] | unknown |
| **Databases & structured data** | unknown | partial: dashboards over connected data (beta) [^30] | no | partial: memory index on SQLite/Postgres [^34] | unknown | unknown | partial: knowledge bases (vector DBs) [^51] | unknown | yes: data tables [^61] |
| **Files & documents (PDF / images)** | partial: image generation tool [^6] | yes: local files; Word/Excel/PPT/PDF skills [^25][^28] | partial: paste a screenshot to an agent [^3] | partial: view and generate images; PDF unknown [^33] | partial: image input and generation; PDF unknown [^40] | partial: image input [^44] | yes: document extraction, RAG, images [^51] | unknown | unknown |
| **Forms / asking structured questions** | yes: `question` tool [^6] | partial: Code `AskUserQuestion`; apps unknown [^21] | no | unknown | unknown | unknown | unknown | unknown | yes: Form Trigger, review steps [^60][^58] |
| **Dashboards / charts / widgets** | unknown | yes: artifacts and dashboards (beta) [^30] | no | partial: Canvas, MCP Apps views [^33][^35] | unknown | unknown | partial: admin analytics only [^51] | unknown | partial: Insights (paid) [^57] |
| **Cost tracking & budgets** | unknown | yes: `/usage`, attribution, spend limits, `--max-budget-usd` [^20] | no | partial: `/usage cost`, UI analysis; no cap found [^37] | unknown | unknown | partial: token and cost analytics [^51] | unknown | unknown |
| **Voice** | unknown | yes: apps voice mode [^24] | partial: talk a reply from the phone [^3] | yes: via companion apps, TTS [^31][^33] | yes: voice mode, wake word [^40] | partial: ChatGPT voice; Codex unknown [^49] | yes: voice and video calls [^51] | unknown | unknown |
| **Sandboxing / security model** | no sandbox: rules and policies; shell runs as the host user [^6] | yes: opt-in OS sandbox + network allowlist (not native Windows) [^19] | no: direct connections, no account [^3] | partial: host by default; opt-in and per-role sandbox [^31][^32] | yes: Docker, Modal and other backends [^39] | yes: OS sandbox by default [^45][^46] | partial: code runs in Docker via Open Terminal [^51] | partial: sandbox mode + permissions [^53] | unknown |
| **Sub-agents / parallel work** | yes [^7] | yes: subagents, teams, workflows [^17][^21] | yes: agents spawn and steer agents [^3] | yes [^33] | yes: up to 10 concurrent [^40] | yes: subagents, worktrees, cloud [^44][^45] | unknown | yes [^53] | partial: agent as a tool [^58] |
| **Price** | free; optional Go $10 / Go Plus $40 per month [^14] | Free $0, Pro $20, Max $100, Ultra $200, Team from $25/seat [^24] | free [^3] | free | free | CLI free; ChatGPT Go $8, Plus $20, Pro $100–$500 [^49b] | free to self-host; Enterprise unknown | free | Community self-host; cloud from €20/mo [^57] |

---

## Sources

[^1]: herdr GitHub repo: https://github.com/ogulcancelik/herdr
[^2]: herdr README: https://raw.githubusercontent.com/ogulcancelik/herdr/master/README.md
[^3]: herdr website: https://herdr.dev
[^4]: Y Combinator, herdr company page: https://www.ycombinator.com/companies/herdr
[^5]: OpenCode GitHub (sst/opencode, now anomalyco/opencode): https://github.com/sst/opencode
[^6]: OpenCode docs, Permissions: https://opencode.ai/docs/permissions/
[^7]: OpenCode docs, Agents: https://opencode.ai/docs/agents/
[^8]: OpenCode docs, Plugins: https://opencode.ai/docs/plugins/
[^9]: OpenCode docs, Models: https://opencode.ai/docs/models/
[^10]: OpenCode docs, TUI: https://opencode.ai/docs/tui/
[^11]: OpenCode docs, Web: https://opencode.ai/docs/web/
[^12]: OpenCode docs, Skills: https://opencode.ai/docs/skills/
[^13]: OpenCode docs, Rules: https://opencode.ai/docs/rules/
[^14]: OpenCode Go pricing: https://opencode.ai/en/go
[^15]: OpenCode docs index: https://opencode.ai/docs
[^16]: opencode-scheduler, third-party plugin: https://socket.dev/npm/package/opencode-scheduler
[^17]: Claude Code docs, Overview: https://code.claude.com/docs/en/overview
[^18]: Claude Code docs, Checkpointing: https://code.claude.com/docs/en/checkpointing
[^19]: Claude Code docs, Sandboxing: https://code.claude.com/docs/en/sandboxing
[^20]: Claude Code docs, Manage costs: https://code.claude.com/docs/en/costs
[^21]: Claude Code docs, Tools reference: https://code.claude.com/docs/en/tools-reference
[^22]: Claude Code docs, LLM gateway: https://code.claude.com/docs/en/llm-gateway
[^23]: anthropics/claude-code repo and LICENSE.md: https://github.com/anthropics/claude-code
[^24]: Claude pricing: https://claude.com/pricing
[^25]: Cowork overview: https://claude.com/docs/cowork
[^26]: Schedule recurring tasks in Cowork: https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork
[^27]: Claude chat search and memory: https://support.claude.com/en/articles/11817273-use-claudes-chat-search-and-memory-to-build-on-previous-context
[^28]: Claude Skills overview: https://claude.com/docs/skills/overview
[^29]: Create custom skills (skill-creator): https://claude.com/docs/skills/how-to
[^30]: What are artifacts: https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
[^31]: OpenClaw GitHub: https://github.com/openclaw/openclaw
[^32]: OpenClaw docs, Multiplayer: https://docs.openclaw.ai/start/multiplayer
[^33]: OpenClaw docs, Tools: https://docs.openclaw.ai/tools
[^34]: OpenClaw docs, Memory: https://docs.openclaw.ai/concepts/memory
[^35]: OpenClaw docs, MCP: https://docs.openclaw.ai/tools/mcp
[^36]: OpenClaw docs, Skills: https://docs.openclaw.ai/tools/skills
[^37]: OpenClaw docs, Usage tracking: https://docs.openclaw.ai/concepts/usage-tracking
[^38]: ClawHub malicious skills, press: https://thehackernews.com/2026/02/openclaw-integrates-virustotal-scanning.html and https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain/
[^39]: Hermes Agent GitHub: https://github.com/NousResearch/hermes-agent
[^40]: Hermes Agent docs, Features overview: https://hermes-agent.nousresearch.com/docs/user-guide/features/overview
[^41]: Hermes Agent docs, Checkpoints and rollback: https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback
[^42]: Hermes Agent docs, CLI commands (`hermes dashboard`): https://hermes-agent.nousresearch.com/docs/reference/cli-commands
[^43]: openai/codex GitHub: https://github.com/openai/codex
[^44]: Codex CLI docs: https://learn.chatgpt.com/docs/codex/cli.md
[^45]: Codex / ChatGPT glossary: https://learn.chatgpt.com/docs/glossary
[^46]: Codex CLI reference, `--sandbox` and `--ask-for-approval`; seen via search snippet: https://developers.openai.com/codex/cli/reference
[^47]: Codex with local models: https://lmstudio.ai/docs/integrations/codex and https://docs.ollama.com/integrations/codex
[^48]: Codex built-in skill-installer / skill-creator (third party): https://tessl.io/registry/skills/github/openai/codex/skill-installer
[^49]: ChatGPT pricing, feature table: https://chatgpt.com/pricing
[^49b]: ChatGPT prices (third party, Nov 2026): https://tech-insider.org/chatgpt-go-vs-plus-vs-pro-100-200-500-2026/
[^50]: Open WebUI GitHub: https://github.com/open-webui/open-webui
[^51]: Open WebUI docs, Features: https://docs.openwebui.com/features/
[^52]: goose GitHub (block/goose, now aaif-goose/goose): https://github.com/block/goose
[^53]: goose website: https://goose-docs.ai
[^54]: goose permission modes: https://goose-docs.ai/docs/guides/goose-permissions
[^55]: goose recipes and scheduling: https://goose-docs.ai/docs/guides/recipes/session-recipes
[^56]: n8n GitHub: https://github.com/n8n-io/n8n
[^57]: n8n pricing: https://n8n.io/pricing/
[^58]: n8n, Human-in-the-loop for AI tool calls: https://docs.n8n.io/advanced-ai/human-in-the-loop-tools
[^59]: n8n, MCP Server Trigger: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/
[^60]: n8n, Form Trigger: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.formtrigger
[^61]: n8n, MCP server tools reference (workflow builder, data tables): https://docs.n8n.io/connect/connect-to-n8n-mcp-server/mcp-server-tools-reference
[^62]: DataCamp, Top open-source AI agent harnesses (2026-11-11): https://www.datacamp.com/blog/top-open-source-ai-agent-harnesses
[^63]: DeepSeek Harness GitHub: https://github.com/deepseek-ai/deepseek-harness
[^64]: Gemini CLI GitHub: https://github.com/google-gemini/gemini-cli
[^65]: TechCrunch, Meta acquires Manus: https://techcrunch.com/2025/12/29/meta-just-bought-manus-an-ai-startup-everyone-has-been-talking-about
[^66]: goose Memory extension: https://goose-docs.ai/docs/mcp/memory-mcp
[^67]: n8n Advanced AI docs: https://docs.n8n.io/advanced-ai/
[^68]: n8n Schedule Trigger (also covers "If Execution Is Missed"): https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/

Added for draft 2 (all checked 2026-11-26):

[^69]: pi website: https://pi.dev
[^70]: pi GitHub monorepo (badlogic/pi-mono resolves here): https://github.com/earendil-works/pi
[^71]: pi coding-agent README: https://github.com/earendil-works/pi/tree/main/packages/coding-agent
[^72]: pi docs index: https://docs.pi.dev/latest
[^73]: pi docs, Sessions: https://docs.pi.dev/latest/sessions.md
[^74]: pi docs, Security: https://docs.pi.dev/latest/security.md
[^75]: pi docs, Models: https://docs.pi.dev/latest/models.md
[^76]: pi docs, Usage: https://docs.pi.dev/latest/usage.md
[^77]: pi docs, Containerization: https://docs.pi.dev/latest/containerization.md
[^78]: pi packages catalogue: https://pi.dev/packages
[^79]: pi-chat (earendil-works): https://github.com/earendil-works/pi-chat
[^80]: Mario Zechner, "I've sold out" (2026-04-08): https://mariozechner.at/posts/2026-04-08-ive-sold-out/
[^81]: Claude Code docs, Desktop scheduled tasks (missed runs): https://code.claude.com/docs/en/desktop-scheduled-tasks
[^82]: Claude Code docs, Memory (MEMORY.md loads at session start): https://code.claude.com/docs/en/memory
[^83]: Claude Code docs, VS Code (diff before accepting an edit): https://code.claude.com/docs/en/vs-code
[^84]: OpenCode docs, Tools (webfetch, websearch): https://opencode.ai/docs/tools/
[^85]: OpenCode docs, Ecosystem (community list): https://opencode.ai/docs/ecosystem/
[^86]: OpenClaw docs, ACP agents (Claude Code harness): https://docs.openclaw.ai/tools/acp-agents
[^87]: OpenClaw release notes 2026.8.1, Automations and scheduling (restart catch-up): https://docs.openclaw.ai/releases/2026.8.1/automations-and-scheduling
[^88]: Hermes Agent docs, Memory: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
[^89]: Hermes Agent docs, Skills (Skills Hub, marketplace): https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
[^90]: Hermes Agent docs, Cron (catches up once): https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
[^91]: Hermes Agent docs, bundled `claude-code` skill: https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-claude-code
[^92]: ChatGPT Memory FAQ: https://help.openai.com/en/articles/8590148-memory-faq
[^93]: ChatGPT Business Memory FAQ; seen via search snippet: https://help.openai.com/en/articles/9295112-memory-faq-business-version
[^94]: Open WebUI docs, Memory: https://docs.openwebui.com/features/chat-conversations/memory
[^95]: Open WebUI docs, Open WebUI as an app (PWA): https://docs.openwebui.com/getting-started/open-webui-as-app
[^96]: Open WebUI Computer, coding agents; seen via search snippets only (the page returned 404 when fetched): https://docs.openwebui.com/ecosystem/computer/ai/coding-agents and https://github.com/open-webui/computer
[^97]: goose docs, ACP providers (Claude Code): https://goose-docs.ai/docs/guides/acp-providers
[^98]: goose docs, Using extensions (built-ins, extensions directory): https://goose-docs.ai/docs/getting-started/using-extensions
[^99]: n8n docs, HTTP Request node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/
[^100]: n8n docs, Community nodes installation: https://docs.n8n.io/integrations/community-nodes/installation/
[^101]: n8n docs, SerpApi tool node (deprecated from 2.35.0): https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolserpapi/
