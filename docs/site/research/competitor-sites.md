# Competitor home pages: what they show and how

Research for the harness marketing home page. Goal: out-do these sites, and be animated and dynamic.

- **Checked:** 2026-11-26, every site.
- **Method:** each page was fetched as HTML. Copy and structure come from the page text. Motion comes from the raw markup: `<video>`, `<canvas>`, `@keyframes`, Lottie/Rive, asciinema `.cast` files, scroll-observer classes. **I could not run any page.** Anything marked *(inferred)* is a guess from markup or filenames, not something I watched play.
- Product facts and star counts are in [competitors.md](competitors.md). This file covers only the sites.

---

## 1. OpenCode: https://opencode.ai

- **Hero:** "The open source coding agent." Subhead: "Start with free models or bring any of 200+ providers… use it from your desktop, the terminal, your phone or your own code." Badge: "Trusted by 22M+ developers".
- **How it shows the product:** four product cards (Desktop, Terminal, Mobile "New", SDK). Each card plays a short angled product video on hover. The markup has `media/card-hover/angled/{desktop,mobile,sdk}` MP4s in AV1 and HEVC at 720p and 1080p. The Terminal card is a tabbed install block (curl / npm / bun / brew / paru) with copy buttons.
- **Motion and interactivity:** the hover videos are confirmed in the markup. There is also an OG video (`home-*.mp4`). The footer wordmark has letters you can drag, with full keyboard support (Space picks up, arrows move). It is a playful detail that people remember.
- **Order:** hero → Products → "What is OpenCode?" (10 feature cards: any model, any device, multi-session, plugins, MCP, custom agents, skills, commands, permissions, undo/redo) → Get started (3 steps) → Bring your own subscription → Bring your own tools (integration names) → Open source (stats and contributor avatars) → Console → footer.
- **Proof:** 229K stars, 1K+ contributors, 22M+ monthly developers, 20,000+ commits, 200+ providers. No testimonials or customer logos.
- **CTAs:** Download (repeated), Read docs, Free models / OpenCode Go, Start for free, Star on GitHub.
- **Strong:** the video is behind a hover, so the page loads fast and still feels alive. The drag-the-letters footer. "No account needed" is said early. The page is honest and dense.
- **Weak:** the hero has no product in it; you see the product only on hover. The 10-card feature grid is the generic SaaS grid, and permissions and undo get one card each. Everything is aimed at developers.

## 2. Claude Code: https://claude.com/product/claude-code

- **Hero:** "Claude Code." Subhead: "Hand Claude a bug fix, test, or multi-day migration. You set its permissions. Steer and review from your desktop, terminal, IDE, Slack, or the web." CTAs: "Download for macOS" and "Read documentation".
- **How it shows the product:** HTML mockups of a real session. One is a sidebar and chat on "Fix the double-charge bug in checkout" with a file summary (`charges.ts +9 −3`). Another adds a dark-mode toggle next to a localhost preview. There is a terminal transcript explaining the Excalidraw codebase, three captioned stills (terminal, VS Code, web), and the curl install line, shown twice.
- **Motion:** the page is a Next.js build. Its icon components have `lottieUrl` / `lottieAnimateInFrames` fields, but on this page they are all `undefined`, so the icons are static SVG. No `<video>` and no `<canvas>`. The mockups are built from markup, so they may animate in *(inferred, not confirmed)*. Overall the page is restrained.
- **Order:** hero → mockups → pricing tabs (Team / Enterprise / Individual) → latest announcements → "What Claude Code can take on" → 3 use-case cards (onboarding, issue to PR, multi-hour migrations) → "Meets you where you code" → Slack → testimonials and logo row → CLI tools → FAQ (7) → technical rundown → closing CTA → newsletter → footer.
- **Proof:** two logo rows (Zapier, Notion, Stripe, Shopify, NASA, GitLab, AWS, GitHub, Datadog). Three named testimonials (Ramp, Intercom, Notion). Pricing figures.
- **Strong:** the mockups use concrete, believable tasks with a diff count. Each one reads as a story, not a feature. "You set its permissions" is in the hero, and safety is the first promise. Pricing comes early.
- **Weak:** the hero is just the product name. Most of the page is enterprise reassurance (logos, FAQ, resources). Little is interactive. Permissions are claimed, but you never see an approval happen.

## 3. herdr: https://herdr.dev (from github.com/ogulcancelik/herdr)

- **Hero:** "No two Herdrs look alike." Subhead: "Herdr is an app for running coding agents that you shape by asking. **Every window here is Herdr.**" CTAs: "Download Herdr" and "Browse the gallery →"; "On your phone too →".
- **How it shows the product:** the hero is a dense grid of real layouts that users made, as WebP tiles (Darkroom, Command Center, Orrery…), credited to their creators. "Click any window" opens a lightbox with Esc and ←/→ keys and a "See the layout →" link. A prompt-to-result demo ("One sentence in. A different app out.") shows `❯` and a transcript of the agent editing `mods/tabs/main.js`. Code blocks show `hc run --bg codex`, `hc send t3`, `hc machine add vps` and a config file tree. There are phone screenshots (inbox, terminal, foldable).
- **Motion:** the page is light (62 KB) and hand-built. It uses an `IntersectionObserver` for reveal-on-scroll. The repeated tile rows suggest a marquee or drift *(inferred)*. No video and no canvas.
- **Order:** hero gallery → stats counters → prompt-to-app demo → "Your agents, from anywhere." (mobile, store badges) → "Your agents run agents. And hear back." → 7 numbered, README-style sections → FAQ → closing CTA, the same line again → footer ("Made for your agents. Remade by them.").
- **Proof:** "312 layouts, 576 mods, 533 people". These are community numbers, not stars. No logos and no testimonials.
- **Strong:** **the best idea in the set.** The hero proves the claim ("you shape it by asking") with a hundred real, different results. The gallery is the proof. The copy is short and confident. Mobile is a "who needs you" inbox, which is a real use and not a store badge.
- **Weak:** it only makes sense to people who already run several coding agents. Nothing in it is useful at home or to someone who isn't technical. The screenshots are dense and hard to read at tile size.

## 4. OpenClaw: https://openclaw.ai

- **Hero:** "The AI that *really* does things." Subhead: it "organizes your inbox, sends emails, manages your calendar, and checks you in for flights, all from the chat apps you already use." Above it: "Open source · Runs on your machine · Nobody's business model". CTAs: "Get started", "Read the docs", "Who is behind OpenClaw".
- **How it shows the product:** it barely does. There is a big ASCII-art lobster and a mascot SVG, then a tabbed install block (One-liner / npm / pnpm / Hackable, macOS-Linux / Windows Beta) and desktop download buttons. There are no screenshots and no video.
- **Motion:** an Astro `Marquee` script scrolls the X testimonial cards; the cards are duplicated for the loop. Rive is mentioned in the markup but no animation was found. Otherwise the page is static.
- **Order:** hero → Quick Start → What People Say (X posts) → Latest (blog) → What It Does (6 cards) → Works With Everything → What people are building → Featured In (press) → support → newsletter → Foundation → sponsors → "Pull up a chair" → footer.
- **Proof:** heavy social proof. X testimonials (including Microsoft- and OpenAI-linked accounts), "346k+ stars", "half a million systems", "29 channels", press (TechCrunch, Fast Company), and sponsor logos (OpenAI, GitHub, NVIDIA, Vercel).
- **Strong:** the hero promise is about everyday life (inbox, calendar, flights) and not about code. It is the only competitor that speaks to ordinary life. "No subscription. No hosted tier. No token." is a sharp line about trust. There is a lot of community energy.
- **Weak:** it **never shows the assistant doing any of those everyday things.** The page goes straight from the promise to an install command. The proof is about popularity, not results. "Full System Access" sits on a card with no picture of how it is kept safe, and its skill marketplace had a malware incident (see competitors.md).

## 5. Hermes Agent: https://hermes-agent.nousresearch.com

- **Hero:** "The Agent That Grows With You." There is no subhead. CTAs: "Download desktop app" and "Deploy to the cloud", plus "Install Hermes" in the nav.
- **How it shows the product:** a hero image, the curl install line with OS tabs, and a looping, muted desktop-app video (`hermes-desktop.mp4` with a poster). Each of the six feature cards has an illustration.
- **Motion:** there is one `<video loop muted playsinline>`. A fixed, full-screen `<canvas>` sits at 2% opacity over the whole page. It is a grain or noise overlay, for texture *(inferred from its styles)*.
- **Order:** hero → install → desktop downloads → six numbered features (Connect "Lives Everywhere", Remember, Schedule, Delegate, Search, Experiment / sandbox) → FAQ (5) → Nous Portal plans table → footer.
- **Proof:** none to speak of: no stars, logos or testimonials. It lists pricing tiers and "200+ models".
- **Strong:** the numbered verbs (Connect, Remember, Schedule, Delegate, Search, Experiment) are easy to scan. The FAQ answers the real worries ("What happens when I stop my agent?"). The grain canvas gives the page an atmosphere.
- **Weak:** "Grows with you" is never shown; nothing on the page shows the agent learning or getting better. The cloud plans pull attention away from "it's yours".

## 6. OpenAI Codex: https://openai.com/codex/

- **Hero:** "Build anything with Codex." Subhead: "Move faster, go further, and bring your biggest ideas to life."
- **How it shows the product:** polished static screenshots (changed-files panel, parallel agents, mobile cloud view, PR review, CLI "implement dark mode"). The markup has four MP4s set to autoplay, so some panels play clips. The headline has an `ascii-overlay` class, so there is an ASCII-texture effect over the hero *(inferred from the class name)*.
- **Order:** hero → plans (Plus / Pro / Business) → "The best way to build with agents" (4 subsections) → plugins and integration logos → "The same agent everywhere you code" (ChatGPT, cloud, IDE, CLI) → 6 testimonials → "Start building" → footer.
- **Proof:** "Trusted by top teams" logos, six named testimonials (Harvey, Ramp, Duolingo, Cisco Meraki…), and Harvey's "30–50%" claim.
- **CTAs:** Get Plus, Get Pro, Try ChatGPT Business, Try on web, Browse plugins.
- **Strong:** the craft is top-tier. It sells parallel agents and "the same agent everywhere", and the screenshots are real UI.
- **Weak:** the hero copy is the most generic of all ten ("Build anything… bring your biggest ideas to life"). The page leads with a sales funnel (plans come second) and asks you to buy a subscription.

## 7. Open WebUI: https://openwebui.com

- **Hero:** "The freedom AI stack." Subhead: "Run AI on your own terms. Connect any model, extend with code, and protect what matters without compromise." CTAs: "Get Open WebUI" and "Join the community 543K+ members"; "Looking for Enterprise?"
- **How it shows the product:** hardly at all. The images are oil-painting style (a farmhouse, a library, "Explore the cosmos"). There is one autoplay, muted, looping `<video>` and the line `$ pip install open-webui`.
- **Motion:** that one video loop. Otherwise the page is calm and static.
- **Order:** hero → "The self-hosted AI interface" → stats ("The network": 496M+ downloads, 543K+ members, 160K+ stars) → "A home for AI, at any scale" → painting interstitial → community → toolkit (Models, Skills, Tools, Functions) → mission → get started → blog → switch guide → footer (Solutions: Defense, Government, Healthcare…).
- **Proof:** big numbers (496M+ downloads), a live member count (543,226), and stars.
- **Strong:** the art direction is unusual: paintings, "a home for AI", "the path to this door is yours to walk". It feels warm and not like a tech product. "One command. 60 seconds. No account required." is a strong reassurance.
- **Weak:** you never see the interface. The mood is lovely, but there is no evidence behind it. "Home" is a metaphor, and nothing on the page is about an actual household.

## 8. goose: https://goose-docs.ai (block.github.io/goose now points here)

- **Hero:** "Your open source AI agent." Subhead: "Use goose on desktop or in the terminal", plus building agents with oi-kit. Badges: "Open Source · Apache 2.0 · Agentic AI Foundation". CTAs: "Install goose" and "Quickstart".
- **How it shows the product:** emoji icons on seven feature cards and a curl install line. "See goose in action" is a **YouTube iframe** ("vibe coding with goose").
- **Motion:** none beyond the embedded YouTube video. The page is a Docusaurus docs site.
- **Order:** hero → "What goose does" (7 cards) → "Built on open standards" (MCP, ACP, AAIF) → Community → Get started → See goose in action → footer.
- **Proof:** 55k+ stars, 600+ contributors, 70+ extensions, 85+ providers, and the backing of the Linux Foundation.
- **Strong:** clear trust signals around governance and open standards.
- **Weak:** the weakest page. It looks like docs, with an emoji grid and a video that sends you off to YouTube. Its strongest feature, "Smart Approval", is buried in a security card.

## 9. n8n: https://n8n.io

- **Hero:** "Build the agent. Understand its workflow." Subhead: "n8n is the platform for agents and workflows you can follow. Open any step, see what it does, and explain to anyone who runs it." CTAs: "Get Started" and "Talk to sales". Top banner: "Meet Nod, an open-source personal agent from n8n Labs."
- **How it shows the product:** **an animated workflow canvas in the hero.** You write a prompt in plain words ("When a refund request comes in, look up the order. Then ask me in Slack whether to refund it or open a ticket."), and it becomes nodes: Lookup order → Investigate → **Ask for approval on Slack** → Approved? → Refund / Open ticket. Tabs switch between examples (Process invoice, Knowledge assistant, Daily News Digest). A model node reads "Claude Sonnet 4.6", and a "Click here" hint invites you to interact.
- **Motion:** the richest on the list. There are `@keyframes` named `overlaySlideStepsIn/Out`, `tooltipFadeIn/Out` and `skeletonPulse`, so the canvas plays a guided walkthrough with tooltips. Section videos are named `see_and_understand_expand.mp4` and `built_by_you_notes_highlight.mp4`. Persona intro clips (`Prototype_Alix_Intro.mp4` and others) play with the use-case stories. Lottie and Rive are both referenced.
- **Order:** hero canvas → Fortune 500 logos → use-case stories by named persona (Tom in IT, Cécile in Security, Konsti in DevOps, Alicia in Sales) → community stats → "The USB-C for your AI stack" → "See + understand + trust your agents" → "Built by you + readable by anyone" → "Move fast + break nothing" (replay, mock data, logs) → enterprise → Huel and Vodafone case studies → 10 testimonials → closing CTA → footer.
- **Proof:** the most of any site. Logos (Meta, Vodafone, Mercedes, Dell), 212.2k stars, 4.7/5 on G2, 250k+ community, "Huel saved 1,000 hours", "Vodafone £2.2M".
- **Strong:** **the hero demo is the product, and it shows a human approval step happening.** The persona stories are the right idea (real people, real jobs). The section titles all follow one pattern ("X + Y").
- **Weak:** the approval is a box on a diagram ("Ask for approval on Slack"). You never see what the person is actually asked, or what would change. Every persona is someone at work; no one is at home. The page is very busy.

## 10. pi: https://pi.dev

- **Hero:** "There are many agent harnesses, but this one is yours." (the page is missing the space before "but"). Subhead: a minimal harness you adapt to your workflow. Banner: "Pi 1.0", "Pi Durable", "Go make them yours."
- **How it shows the product:** **real terminal recordings.** The page loads `asciinema-player` with a custom `pi-theme.css` and `/recordings/*.cast` files (install, hello, models, extension, print, mobile-cal, arrr…). Each is captioned "Pi – Steer a running agent" and so on. There is a static "Fig. 01 | DOOM EXTENSION" screenshot.
- **Motion:** the hero logo is drawn on a `<canvas id="heroLogo">` *(probably WebGL, inferred)*. The `#demo` player is driven by scrolling ("$ scroll to continue"), and sections fade in on scroll (`home-scroll-fade-item`). A "Crooked mode: ON" easter egg tilts the page and has a reset button. There is an Auto/Light/Dark switch.
- **Order:** hero and install → Why Pi? → Change the harness, not your workflow → 15+ providers → tree-structured, shareable history → context engineering → steer or follow up → four modes → "Primitives, not features" → **"What we didn't build"** → get involved → footer.
- **Proof:** almost none: "15+ providers", "50+ examples", and OpenClaw cited as an integration. No stars and no logos.
- **Strong:** scroll-driven, *real* terminal sessions as crisp text (asciinema, not video), which makes them light, sharp and selectable. "What we didn't build" is a brave and memorable section. It has personality (the DOOM figure, crooked mode).
- **Weak:** it is only for terminal-native developers. A recorded terminal says nothing to anyone else in the house.

---

## Synthesis

### What everyone does (so we can avoid looking generic)

1. **A one-line install in the hero or right below it** (`curl … | bash` in OS/package tabs with a copy button). Nine of the ten sites do this. It is now just furniture.
2. **"Open source / any model / runs on your machine" stated as badges.** The claim is the same everywhere, and none of them backs it up visually.
3. **A grid of 6–10 feature cards** with an icon and two lines each (OpenCode, Hermes, goose, OpenClaw, Open WebUI).
4. **Star counts and community numbers as the main proof** (229K, 395K, 543,226 members). Logo walls and testimonials appear only on the corporate sites (Claude, Codex, n8n).
5. **A list of surfaces** ("desktop, terminal, IDE, phone, web") as icons or cards, with no sign that it is the same session on all of them.
6. **Dark, terminal-flavoured design** with monospace accents and ASCII art (OpenClaw's lobster, Codex's ASCII overlay, pi's terminal).
7. **FAQ, then newsletter, then a footer with 10 link columns.**
8. **Motion that is decoration and not demonstration:** hover videos, marquees, noise canvases, fade-in on scroll. Only n8n and pi animate the *product itself*.

### The best ideas worth beating

1. **n8n's live hero canvas:** a plain-words request turns into steps, with a guided tooltip walkthrough and switchable example tabs. *Beat it* by showing what the person actually sees: the approval card, the exact change, and the tap.
2. **herdr's "every window here is Herdr" gallery.** The hero *is* the proof, built from many real results. *Beat it* with a wall of the tools, schedules and dashboards the harness built for different people in one home.
3. **pi's scroll-driven asciinema recordings.** Real sessions, crisp text, light pages, played by scrolling. *Beat it* with real chat sessions replayed as live DOM (not video), so they stay sharp, can be themed and can be interacted with.
4. **Claude Code's concrete task mockups** ("Fix the double-charge bug", `+9 −3`). They are believable and specific. *Beat it* with everyday tasks, written the way a family member would ask.
5. **n8n's named personas** (Tom in IT, Cécile in Security). *Beat it* with people in one household: a parent, a teenager, a grandparent, the one who likes tinkering.
6. **OpenClaw's everyday-life hero promise** (inbox, calendar, flights) and its trust line ("No subscription. No hosted tier. No token."). *Beat it* by actually **showing** those everyday jobs, which OpenClaw never does.
7. **Small touches of personality:** OpenCode's draggable footer letters, pi's crooked mode, Open WebUI's painted, homely art direction. One memorable interactive detail does more than a dozen fade-ins.
8. **pi's "What we didn't build"** section. An honest statement of what we left out builds trust. We could do "What it will never do without asking."

### Gaps none of them fill (ours to own)

1. **A non-technical person's real day.** OpenClaw promises everyday life but shows a terminal; n8n shows people at work. *Nobody shows a grandparent, a kid or a busy parent using one of these.*
2. **The approval preview, live.** Seven of the nine products have approvals (see competitors.md), but no site *shows one*. n8n's is a box on a diagram; Claude's is a sentence. The harness's approval card, which previews exactly what will change, is the single most demonstrable difference.
3. **One home, many people, private memory.** No page shows two people using the same assistant while each one's memory stays private. Open WebUI and OpenClaw have multi-user features but show nothing of them.
4. **The same session moving across phone, tablet and desktop.** Every site *lists* surfaces, and none shows a conversation carrying on from one device to the next.
5. **The assistant building its own tool, and the result being a usable thing.** herdr shows layouts and Hermes says "grows with you", but nobody shows "I asked, and now there is a chore-chart tool / a pantry database / a dashboard".
6. **Schedules on a calendar.** Everyone says "cron" or "scheduled tasks". Nobody shows a week view where the assistant's jobs sit next to the family's events.
7. **Systems as installable pieces you can see** (database, Claude Code, APIs, MCP, web research). Competitors show integration logo walls. We can show a system being installed and the assistant's abilities growing as a result.
8. **Warmth and safety together.** The sites are either cold and technical (terminal, dark) or warm and vague (Open WebUI's paintings). Nobody is warm *and* concrete.

### Recommendations for our hero

- **Headline:** about the household, not about agents. It should promise one assistant for everyone at home that asks before it acts. Avoid "open source coding agent", "build anything" and "the X that really does things".
- **Hero visual: a live, scripted chat demo built in DOM, not video** (pi's crispness, n8n's guided feel). Make it auto-play, loop, and pause when hovered or tapped. Script:
  1. A family member types something everyday ("Can you move Thursday's dentist to after school and tell Grandma?").
  2. The assistant thinks for a moment, then an **approval card slides in** with an exact before/after preview: the calendar event's old and new time highlighted, the message draft to Grandma, and who sees what.
  3. A finger or cursor taps **Approve**. The calendar block moves on a small week view, and a "sent" tick appears.
  4. A one-line "Undo" chip stays for a few seconds.
- Put **2–4 person tabs** above the demo (for example a parent, a teen, a grandparent and the tinkerer, each with an avatar). Switching tab replays a different script, n8n-style, and shows that each person's memory is private ("Mia's memory: only Mia").
- **Install goes below the hero**, not in it. It is furniture everywhere else. Keep one short "Self-host in one command" line with a copy button, plus "any model" chips.
- **Background motion:** keep it calm, at most a slow ambient element. Spend the motion budget on the product demo, not on grain or marquees.

### Recommendations for the animated demos (one per section)

1. **"Ask, preview, approve"**, an interactive approval card. Let the visitor tap Approve, Edit or Decline and see each outcome. This is our signature moment, so make it the one thing people play with (our draggable letters).
2. **"Same conversation, every screen":** a phone, a tablet and a desktop frame side by side, all showing one session. A message typed on the phone appears on the desktop, and the approval is tapped on the tablet. Drive it with scroll (pi's scroll-to-play).
3. **"It builds its own tools":** someone asks "Keep track of what's in the freezer". The assistant writes a small tool or database, and it *appears* as a working mini app the visitor can click. End with a herdr-style gallery of tools other households built.
4. **"Systems: add a skill like an app":** install cards for Database, Claude Code, APIs, MCP and Web research. Clicking one plugs it in, with a short animation of the assistant's new abilities lighting up.
5. **"On the calendar":** a week view that fills in as you scroll. The assistant's scheduled jobs (Sunday meal plan, bin-night reminder, weekly budget check) sit next to family events, each with a "runs at" tag.
6. **"Your memory is yours":** two people side by side. One tells the assistant something private, and the other person's view shows it is not there. Keep it simple: a lock, two memory panes.
7. **"Any model":** a model picker with a few providers and a local-model chip. Switch it mid-conversation and the conversation carries on.
8. **Proof that we have and they don't:** without big star counts, use *scenario proof*. Show a "real week in one home" timeline and real (or clearly labelled sample) transcripts. Add a "What it will never do without asking" list.

**Technical notes for the demos:** build them as live HTML/CSS/JS driven by a small script format (pi's `.cast` idea, applied to chat), not as MP4s. That keeps them sharp, themeable for light and dark, translatable, light to load, and easy to update when the UI changes. Respect `prefers-reduced-motion`: show the final state with a "play" button. Make every demo work at phone width, because the phone frame *is* the product for most of the household.
