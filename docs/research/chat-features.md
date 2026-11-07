# Chat features: what the harness chat must do

Research for the first milestone's chat (build order, step 2). It lists every chat feature and UX detail
worth having in harness, drawn from three places:

- **Product**: `product/design/chat-ux.md`, `user-message-format.md`, `fn-status.md`, `interrupt.md`, and the shipped
  React chat in `product/packages/app/src/next/surfaces/chat/` (`chat-surface.tsx`, `message-bubble.tsx`,
  `fn-status.tsx`, `background-strip.tsx`, `approvals.tsx`, `inputs.tsx`, `mention*.ts(x)`, `attachments.tsx`,
  `voice.tsx`, `meta.tsx`, `settings.tsx`, `model-selector.tsx`, `editable-title.tsx`, `widget-collapse.ts`,
  `fn-embed.tsx`, `interrupt.tsx`) and `packages/app/src/markdown.tsx`.
- **Cletus**: `aits/packages/cletus/src/browser/` (`pages/MainPage.tsx`, `components/MessageList.tsx`,
  `MessageItem.tsx`, `ChatInput.tsx`, `OperationDisplay.tsx`, `QuestionsModal.tsx`, `TodosModal.tsx`,
  `ChatSidebar.tsx`, `Markdown.tsx`, `ImageViewer.tsx`, `ChartViewer.tsx`, `DiagramViewer.tsx`, `ModelSelector.tsx`,
  `TypingIndicator.tsx`, `ExpandableText.tsx`).
- **Harness's own design** (`docs/harness.md`, `types/hub.ts`, `types/sdk.ts`): reply and reply-all, undo a turn,
  the fn tree, forms, handlers, deliveries, renderers, capabilities, budgets, push notifications.

Each item says what it does, where it came from, and the **check** a Puppeteer UI test uses to accept it.
Checks name `data-testid` hooks the components should expose; the test suite reuses them.

## How to read this

- **Priority:** **P0** is what makes it a chat at all; **P1** is what makes it the chat the owner expects; **P2** is
  polish or a later phase.
- **M1** marks the first milestone. Items without it stay types or design only for now.
- **Viewports** used by every layout check: phone 390×844, tablet 820×1180, desktop 1440×900, both themes.
- "No overlap" checks mean: for every pair of visible interactive elements in the region, bounding boxes don't
  intersect; nothing has horizontal scroll (`document.documentElement.scrollWidth <= innerWidth`); no text is
  clipped (`scrollWidth <= clientWidth` on labels unless they are declared truncating with a `title`).

Sources in short form: **P** = product, **C** = Cletus, **H** = harness design, **new** = not in either, added
because the owner asked for it or the expected chat experience needs it.

---

## 1. Layout, routing and states

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 1.1 | App shell: session list + thread + composer | P0 | M1 | C, P |
| 1.2 | Every view tied to the URL | P0 | M1 | P, owner |
| 1.3 | Responsive layout at every size | P0 | M1 | P, owner |
| 1.4 | Header bar | P0 | M1 | P, C |
| 1.5 | Empty, loading, error and reconnect states | P0 | M1 | P, C |
| 1.6 | Themes: light and dark, following the device | P0 | M1 | H, C |
| 1.7 | Capabilities drive the UI | P0 | M1 | H |
| 1.8 | Motion that makes it feel alive | P1 | M1 | owner, H |

- [ ] **1.1 App shell.** A session list (sidebar on desktop, a drawer on phone), the open thread, and the composer
  pinned to the bottom. The list has New chat, search, and rows with title, last activity and a live status dot
  (running, waiting on you, idle). Rows update live from one user-scoped subscription, not one per row (P
  `chat-list-item.tsx`). The sidebar can collapse on desktop (C `ChatSidebar`). Archive and delete from a row menu,
  delete asking for confirmation (C asks to type DELETE; a plain confirm dialog is enough).
  *Check:* at 1440 the sidebar and thread are both visible, side by side; at 390 only the thread shows and
  `[data-testid=open-sessions]` opens the drawer; starting a run in session A turns A's row dot to running without
  a reload while B is open.
- [ ] **1.2 URL is the state.** `/chat` (list), `/chat/:session` (thread), `/chat/:session?run=:run` (run detail
  open), `/chat/:session/turn/:turn/tree` (the fn tree), `#m-:message` (scroll to and flash a message),
  `/settings/...`, `/inbox`. Back and Forward move between them. Refresh returns to the same view, the same open
  panel and, for a deep link, the same message (P: hash ⇄ open-thread sync). The composer draft survives refresh
  per session (P stores drafts per chat id; cleared on send).
  *Check:* open a session, open a run drawer, reload: the same session and drawer are open. Type a draft, reload: the
  draft is back. Load `/chat/:s#m-:id`: that message is in the viewport and has the flash class. Back closes the
  drawer before it leaves the session.
- [ ] **1.3 Responsive at every size.** One column at 390 with a full-width composer; message bubbles cap at a
  readable width (about 72ch) on desktop; long tokens (URLs, paths, stack frames) wrap instead of widening the page
  (P `break-words` + `min-w-0`); wide content (tables, code, embeds) scrolls inside its own box. Safe-area insets on
  phones; the composer stays above the on-screen keyboard (`visualViewport`). Tap targets at least 40px.
  *Check:* at all three viewports in both themes: no horizontal page scroll, no overlapping interactive elements in
  the header, thread and composer, composer fully inside the viewport; a 300-character unbroken token in a message
  doesn't widen the thread.
- [ ] **1.4 Header bar.** Editable title (click, Enter saves, Escape cancels; P `editable-title.tsx`, C); the agent
  and model in use (click to change); participants (1.4 in §8); the budget meter (§9); the session's enabled
  systems; links to the turn tree and the inbox; an overflow menu (rename, archive, delete, settings). On phone the
  less-used controls move into the overflow menu rather than shrinking.
  *Check:* rename via the title persists after reload; at 390 the header is one row with no overlap and the overflow
  menu holds the rest.
- [ ] **1.5 States.**
  - *Empty session:* a welcome with suggested starters (from contexts whose `suggest` audience includes users, H;
    P pre-chat question cards; P/C fall back to fixed starters) and the composer focused.
  - *Loading history:* skeleton bubbles, never a blank pane (C "Loading messages…").
  - *Waiting for the first token:* a typing indicator in the assistant's own provisional row (C `TypingIndicator`),
    replaced in place by the first token or first run status. Never a second assistant avatar under a real one (P).
  - *Turn failed with no reply:* an amber notice at the foot of the thread with the reason clamped to a few lines
    behind Show more, and a Retry action; from the second failure in a row it also suggests a new chat (P
    turn-failure notice).
  - *Fatal stop:* a terminal banner "This turn stopped: reason".
  - *Connection lost:* a slim banner "Reconnecting…", then "Back online"; on reconnect the client refetches messages
    and run statuses and re-subscribes, so no spinner is left stuck (P R-0553). Sending while offline queues the
    message visibly (new).
  *Check:* each state has a testid and is reached by a scripted fake hub: empty session shows starters and clicking
  one sends it; kill the socket and the banner appears within 2s, restore it and a run that finished meanwhile
  shows done.
- [ ] **1.6 Themes.** Light and dark follow `prefers-color-scheme`, with a manual override saved per device. One
  accent color, calm neutrals, contrast at least WCAG AA. Code blocks, embeds and system renderers take theme
  tokens (CSS variables), never hard-coded colors.
  *Check:* emulate both color schemes: `html` gets the matching theme class; sampled text/background pairs in
  bubbles, chips and buttons pass 4.5:1.
- [ ] **1.7 Capabilities drive the UI.** The hub's `ChatCapabilities` (and the `capabilities` event) decide what
  is offered: the mic only with voice input, `@` only with a mention provider, `/` only with commands, `!` only with
  invocable fns, uploads only when allowed. The composer placeholder names only the powers that exist (P derives the
  placeholder from the ports it has).
  *Check:* a fake hub with no mention providers: typing `@` opens nothing and the placeholder doesn't mention `@`;
  pushing a `capabilities` event that adds one makes `@` work without reload.
- [ ] **1.8 Alive.** Subtle motion: new messages ease in, streaming text has a soft caret, run cards pulse while
  active and settle with a short check animation, counts and cost tick rather than jump, finished status groups fade
  out (P fn-status). All motion respects `prefers-reduced-motion`.
  *Check:* with reduced motion emulated, no element has a running CSS animation longer than 0ms; without it the
  active run card has an animation.

## 2. The thread: scrolling and streaming

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 2.1 | Sticky auto-scroll | P0 | M1 | P, C |
| 2.2 | Jump to latest, with new-content count | P0 | M1 | new |
| 2.3 | Token streaming | P0 | M1 | P, C, H |
| 2.4 | Scroll anchoring when content above changes | P0 | M1 | new |
| 2.5 | Older history loads on scroll up | P1 | M1 | H (`messages` is paged) |
| 2.6 | One answer per turn | P0 | M1 | P |
| 2.7 | Opening a session lands at the bottom | P0 | M1 | P |

- [ ] **2.1 Sticky auto-scroll.** The thread follows new content only while the reader is at the bottom (within
  about 80px; P `AT_BOTTOM_SLACK_PX`). Scrolling up stops following immediately, even mid-stream. Sending a message
  always returns to the bottom (P resets the flag on send).
  *Check:* stream 200 tokens; at the bottom, the last token stays in view. Scroll up 400px mid-stream: `scrollTop`
  doesn't change while the stream continues. Send a message: the thread is at the bottom.
- [ ] **2.2 Jump to latest.** When scrolled up and new content arrives, a floating "Jump to latest" button appears
  above the composer with a count of new messages ("3 new"); clicking scrolls smoothly to the bottom and hides it.
  Also offered when an approval or form arrives off-screen ("Needs you"). Neither P nor C has this; P's thread just
  stops following.
  *Check:* scroll up, push two messages: `[data-testid=jump-latest]` shows "2 new"; click it: at the bottom, button
  hidden. The button never overlaps the composer or the send button at any viewport.
- [ ] **2.3 Streaming.** Tokens render as they arrive (`token` events) through incremental markdown, with no reflow
  flicker of earlier lines and a caret at the end. Tool calls, status lines and reasoning appear in order within the
  same answer. When the message completes, the client reconciles with the stored message (P refetches on any gap).
  Only top-level turns stream; nested agent runs appear when done (P R-0503).
  *Check:* a fake stream of 50 chunks: the bubble's text grows monotonically and equals the stored text at the end;
  the caret is present only while `status=streaming`.
- [ ] **2.4 Scroll anchoring.** When content above the reader grows (a run card expands, an image loads, older
  history is prepended), what the reader is looking at stays put (`overflow-anchor` or manual offset correction).
  Images reserve their size before they load.
  *Check:* scroll to the middle, note the top visible message's `getBoundingClientRect().top`; prepend a page of
  history and expand a card above: the same message's top moves by less than 2px.
- [ ] **2.5 Older history.** Scrolling near the top loads the previous page (cursor paging), with a small spinner at
  the top and anchoring (2.4). A "Beginning of chat" marker at the very start.
  *Check:* a session with 300 messages opens showing the latest page; scrolling to top loads more until the marker
  appears; no duplicate ids.
- [ ] **2.6 One answer per turn.** All the assistant iterations of one turn (text, then tool calls, then more text)
  render as one bubble with one avatar and one timestamp, the run activity merged in order (P `groupThread`). The
  working indicator sits at the foot of that bubble, never as a sibling row.
  *Check:* a turn with 3 iterations renders one `[data-testid=assistant-answer]` with one avatar.
- [ ] **2.7 Opening lands at the bottom.** Opening or switching sessions shows the latest messages without a
  visible scroll animation, unless a `#m-` hash asks for a message (1.2). An in-flight turn is rehydrated on open:
  its streaming text, status line and pending approvals show at once (P "BUG 3" rehydrate).
  *Check:* open a session with a running turn: the working indicator and current status are visible on first paint
  after load.

## 3. Messages and message actions

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 3.1 | User and assistant bubbles | P0 | M1 | P, C |
| 3.2 | Markdown: code, tables, math, diagrams | P0 | M1 | P, C |
| 3.3 | Hover / long-press action bar | P0 | M1 | P |
| 3.4 | Copy | P0 | M1 | P |
| 3.5 | Edit and resend | P1 | M1 | P |
| 3.6 | Retry an answer | P1 | M1 | new |
| 3.7 | Message details: usage, cost, model, timing | P1 | M1 | P, C |
| 3.8 | "What the model saw" | P1 | M1 | P |
| 3.9 | Reasoning, collapsible | P1 | M1 | C |
| 3.10 | Long messages collapse | P1 | M1 | C |
| 3.11 | Timestamps and day separators | P1 | M1 | P, C |
| 3.12 | Feedback (thumbs down with a reason) | P2 | | P |
| 3.13 | Link to a message | P1 | M1 | P (deep links) |
| 3.14 | Read aloud | P2 | | P |

- [ ] **3.1 Bubbles.** User messages right-aligned in the accent bubble with no avatar; assistant answers left
  with one avatar tile (P). Notes (`role: 'note'`, e.g. undo reports, system joins) render as a centred muted line.
  User message parts render as: text; mention chips (§5); command chips; invocation cards; files; and the hub's and
  hooks' additions (`extra`, `hook` parts) as a dimmed, collapsible "Added for the model" row, never raw XML (H, P
  user-message-format). Multi-person: the author's name and avatar on others' messages (§8).
  *Check:* a user message with a mention, a command and an extra renders a chip, a chip, and a collapsed dimmed row;
  the page text contains no `<mention` or `<extra`.
- [ ] **3.2 Markdown.** GFM (tables, task lists, strikethrough), syntax-highlighted code blocks with a language
  label and a copy button (P `markdown.tsx`), inline code pills, KaTeX math (P, C), Mermaid diagrams (C
  `DiagramViewer`), safe external links (open in a new tab, `rel=noopener`), images clickable to a zoom/pan viewer
  with Escape to close (C `ImageViewer`, P attachments). File paths and resource URIs become links that open the
  resource viewer (C `FileViewer`, H resources). Tables scroll horizontally inside the bubble.
  *Check:* a fixture message with each construct: `.katex` exists, a code block has `button[aria-label="Copy code"]`
  and clicking it puts the code on the clipboard, the Mermaid block renders an `svg`, a 12-column table does not
  widen the page at 390.
- [ ] **3.3 Action bar.** Appears on hover and keyboard focus on desktop; on touch, on long-press or a tap on a
  small "more" affordance (never hover-only). Holds the actions below, each with an `aria-label` and tooltip. Doesn't
  cover message text (sits in the bubble's margin row).
  *Check:* desktop: hover shows `[data-testid=msg-actions]`; Tab to the message shows it too. Phone: long-press shows
  it. Its box never intersects the bubble's text box.
- [ ] **3.4 Copy.** Copies the message as markdown; the icon briefly turns into a check ("Copied").
  *Check:* clipboard equals the stored text; the label flips to Copied and back.
- [ ] **3.5 Edit and resend.** On a user message: edit in place, Save & resend. Harness maps it to undoing every turn
  from that one on (`undoTurn`, newest first) then sending the edited text, and says what was undone (P rewind +
  edit-resend). If something can't be undone, the confirmation says so before it starts.
  *Check:* edit the second-to-last user message: later messages disappear, an undo note lists what was undone, the
  new answer streams.
- [ ] **3.6 Retry.** On the last assistant answer: undo that turn and send the same message again (optionally with a
  different model). New; neither P nor C has a one-click retry.
  *Check:* Retry replaces the last answer; the user message isn't duplicated.
- [ ] **3.7 Details.** A popover or drawer with model, provider, tokens in/out, cost, time to first token, duration,
  iterations, and links to each LLM call (H `LlmInteraction`, P `MessageMetaModal`, C per-message cost/usage on hover).
  *Check:* open details on a fixture answer: the numbers match the fixture's LLM interactions.
- [ ] **3.8 What the model saw.** For a turn: the system prompt, the tagged additions (local time, suggested
  context and fns, hook blocks, mention texts) and the tools offered, as the model received them (P "what context
  was fed" trace). Read-only, copyable.
  *Check:* the panel contains each mention's `llm` text and the suggested-fns block of the fixture turn.
- [ ] **3.9 Reasoning.** Model reasoning shows as a collapsed "Reasoning" row above the answer, shimmering
  "Reasoning…" while it streams, expandable (C `CollapsibleReasoning`). Needs a reasoning part on messages (see
  Gaps).
  *Check:* a fixture with reasoning shows the collapsed row; clicking expands the text.
- [ ] **3.10 Long messages.** A long user message (a pasted log) collapses after a few lines with a fade and Show
  more (C `ExpandableText`). Assistant answers don't collapse.
  *Check:* a 200-line user message renders at most about 8 lines tall until Show more.
- [ ] **3.11 Time.** Relative time on hover/tap (exact time in a tooltip), day separators ("Today", "Yesterday",
  dates) between days.
  *Check:* fixtures across three days render three separators.
- [ ] **3.12 Feedback.** Thumbs down opens an inline reason box; the reason is stored with the message for a later
  memory feature (P R-50i). Later: no memory agent in M1.
- [ ] **3.13 Link to a message.** "Copy link" gives `/chat/:s#m-:id` (1.2).
  *Check:* the copied URL opens with that message flashed.
- [ ] **3.14 Read aloud.** Play a finished answer through text to speech when voice output is configured (P
  proposed). Later.

## 4. Runs in the chat: status cards, live status and summaries

The owner asked to "see fn realtime statuses, they can be summarized". Product's `fn-status.md` is the model.

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 4.1 | Run card per tool call | P0 | M1 | P, C, H |
| 4.2 | Live status text per run | P0 | M1 | P |
| 4.3 | Grouped and summarized status line | P0 | M1 | P |
| 4.4 | Progress: linear and named steps | P0 | M1 | H |
| 4.5 | Elapsed time, cost and attempts, live | P0 | M1 | P, C |
| 4.6 | Run detail drawer | P0 | M1 | P, C |
| 4.7 | The fn tree of a turn | P0 | M1 | P, H |
| 4.8 | System renderers in the card | P0 | M1 | H |
| 4.9 | Broken or disabled renderer placeholder | P0 | M1 | P, H |
| 4.10 | Display after done: card, message or nothing | P0 | M1 | H |
| 4.11 | Background runs strip | P0 | M1 | P, H |
| 4.12 | Collapse one / collapse all | P1 | M1 | P |
| 4.13 | Errors and retries shown plainly | P0 | M1 | P, C |
| 4.14 | Deliveries from renderers, live | P1 | M1 | H |
| 4.15 | Turn summary when it settles | P2 | | new |

- [ ] **4.1 Run card.** Every run a turn makes shows inline in the answer, in call order: a status dot (queued,
  awaiting approval, running, waiting, paused, done, failed, cancelled, undone; H `RunStatus`), the fn's friendly
  label (never a raw id; P `fn-label.ts`), a one-line summary of its args, and its live status text. Click opens
  the detail drawer (4.6).
  *Check:* a turn with three runs shows three `[data-testid=run-card]` in order; pushing `run` events moves each dot
  through running → done without reload; no card shows a uuid.
- [ ] **4.2 Live status text.** Each run reads in plain words what it is doing: present tense with "…" while active
  ("Reading harness.md…"), past tense when done ("Read harness.md"), "Retrying… (attempt 2)" on retry, "… failed"
  on failure (P's four states). Text comes from the fn (templates with arg values) or its kind's default. Harness
  types don't carry this yet (see Gaps).
  *Check:* a fake run with a template renders the active, done, retry and failed strings exactly, with args filled.
- [ ] **4.3 Grouped and summarized line.** Beneath the in-flight answer one line sums up what's happening right
  now: same-fn runs grouped with a plural form ("Reading 3 files…"), most active first (active > retry > failed >
  done), finished groups linger briefly then fade, and past a few groups "+4 more" (P `fn-status.tsx`
  `groupStatuses`/`combineStatusText`). Expanding shows every run in its last state. The line never repeats text a
  visible card already shows (P's double-print fix). When nothing has reported yet it reads "Thinking…"; when the
  turn waits on the user it says so ("Waiting for your approval").
  *Check:* 3 concurrent `fs/read` runs and 1 `fs/write`: the line reads the plural read group first and a
  write group second; finish all reads: the read group shows done then disappears within the fade time.
- [ ] **4.4 Progress.** Linear progress as a thin bar with a percentage; named steps as a compact stepper with each
  step's status and detail (H `ProgressDecl`). Updates animate.
  *Check:* a run sending progress 0.2 → 0.8 shows the bar width change; a steps run shows each step's state.
- [ ] **4.5 Live metrics.** Each card shows a ticking elapsed time while running and the final duration after,
  its cost and the subtree's total cost (`cost` updates), and the attempt number on retry (P `FnRunMetrics`, C
  `getElapsedTime`).
  *Check:* elapsed text increases between two reads 1.1s apart while running and stops after done.
- [ ] **4.6 Run detail drawer.** A side drawer (full screen on phone) for one run: status history, args, result
  (friendly view and JSON tabs, as C `OperationDetails` has Input / Output / Input JSON / Output JSON), errors per
  attempt (P Errors tab), progress, cost, timing, LLM calls made inside it, its children, and the run's operations
  (cancel, pause, resume, background, undo) as far as `allowed` says. URL `?run=`.
  *Check:* clicking a card opens the drawer and adds `?run=`; reload keeps it open; the JSON tab equals the run's
  stored args.
- [ ] **4.7 The fn tree.** For a turn: the whole tree of runs (a run's children are the fns it called) with
  status, timing and cost per node and LLM calls as leaves (H `TreeNode`). Live while the turn runs. Click a node for
  its detail. Reachable from the status line's expand, from a card, and from the header (P status-tree drawer and
  request tree viewer).
  *Check:* a nested fixture (agent → fs/edit → fs/read) renders three nested nodes; a new child run event adds a
  node live.
- [ ] **4.8 System renderers.** A system's Vue renderer for its fn replaces the default card body; it sees the
  run's live status, progress, result and declared state fields, and can send actions and submit forms (H
  renderers). Loaded from the system's client build through the hub, sharing the chat's Vue.
  *Check:* the fs system's `bash` renderer appears for an `fs/bash` run and updates from progress events.
- [ ] **4.9 Broken or disabled renderer.** A renderer that fails to load or throws shows a placeholder (fn label,
  status, "Couldn't show this", with inspect) and never breaks the message (P R-2b). A system whose renderers an
  admin turned off falls back to the default card.
  *Check:* a renderer that throws on mount: the placeholder shows, the rest of the thread renders, the console error
  is logged once.
- [ ] **4.10 Display after done.** When a run finishes, its `display` decides what remains: the card, a plain
  message, or nothing (H).
  *Check:* a `display: 'nothing'` fn leaves no card after done; `'message'` leaves a text row.
- [ ] **4.11 Background runs.** A new user message while runs are going moves them to the background (H). A thin
  strip above the composer lists every background run with live status; tap opens its detail (P
  `background-strip.tsx`). When one finishes, its card on the original message resolves in place and the agent's
  follow-up appears (P background handle card). Cards can be moved to the background by hand when `allowed` says so.
  *Check:* send while a slow run is active: the run appears in `[data-testid=background-strip]`; finishing it
  removes it from the strip and its card shows done; the strip never pushes the composer off a 390×844 screen.
- [ ] **4.12 Collapse.** Each card collapses to its one line; "Collapse all" on an answer writes every card's own
  state, not a separate mode (P `widget-collapse.ts`). Collapse state survives reload (keyed by run id).
  *Check:* collapse all, expand one, reload: only that one is expanded.
- [ ] **4.13 Errors.** A failed run's card shows a red dot and the error message in place of its summary (C), with
  the detail one click away. Retries show distinctly with the attempt count.
  *Check:* a failing fixture shows the error text in the card and the Errors tab in the drawer.
- [ ] **4.14 Deliveries.** An action or form a renderer sent shows its live state (queued, delivered, done, failed)
  near the control that sent it, including "Waiting for system to come online" (H `DeliveryRecord`).
  *Check:* with the system offline, submit: shows queued; bring it online: shows done with the result.
- [ ] **4.15 Turn summary.** For a long or many-run turn, a short generated summary on the settled line ("Edited 4
  files, ran tests twice, all passed"). Deterministic grouping (4.3) covers M1; an LLM-written summary is later.

## 5. Composer and its powers

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 5.1 | Auto-growing input, send and stop | P0 | M1 | C, P |
| 5.2 | Send while a turn runs | P0 | M1 | P, H |
| 5.3 | `@` mentions with search | P0 | M1 | P, H |
| 5.4 | Mention chips with hover cards | P0 | M1 | H, P |
| 5.5 | Type methods from the hover card | P1 | M1 | H |
| 5.6 | `/` commands with argument hints | P0 | M1 | P, H |
| 5.7 | `!` fn invocation forms | P0 | M1 | P, H |
| 5.8 | Inputs for every gin type, plus custom inputs | P0 | M1 | H |
| 5.9 | Attachments: pick, drop, paste | P1 | M1 | C, P |
| 5.10 | Voice dictation | P1 | M1 | P |
| 5.11 | Draft persistence and double-send latch | P0 | M1 | P |
| 5.12 | Composer meta row | P1 | M1 | C, P |
| 5.13 | Input history (Up to recall) | P2 | M1 | new |

- [ ] **5.1 Input.** A multi-line textarea that grows with its content up to about half the viewport, then
  scrolls (C caps at 50vh). One line sits vertically centred against the buttons (P item 22). 16px text so phones
  don't zoom. Enter sends and Shift+Enter is a new line on a hardware keyboard (C); on touch devices Enter is a new
  line and the button sends. Ctrl/Cmd+Enter always sends (P). Send is disabled with nothing to send or while files
  upload. While a turn runs, Stop sits next to Send (5.2, §6).
  *Check:* type 30 lines: height stops growing at 50vh and the textarea scrolls; Enter sends on desktop; on a touch
  emulation Enter inserts a newline; the single-line text's vertical centre is within 2px of the Send button's.
- [ ] **5.2 Send while running.** Sending during a turn is allowed; the running runs move to the background (H,
  P AUTO_BACKGROUND) and the composer says so briefly ("2 runs moved to background").
  *Check:* see 4.11.
- [ ] **5.3 `@` mentions.** Typing `@` at a word boundary opens a popover anchored to the caret that searches the
  session's mention providers (debounced, bounded), grouped by provider, each result with label, hint and the
  type's icon and color (H `MentionOption`, P `mention-picker.tsx`). Up/Down/Enter/Escape work while it is open and
  only then (arrows still move the caret when it's closed; P). Picking inserts a chip. Re-mentioning the same thing
  reuses it; a chip deleted from the text is dropped at send (P `pruneMentions`). On phone the popover becomes a
  sheet above the keyboard.
  *Check:* type `@harn`: results from `fs/files` within 400ms; Down, Enter inserts a chip; send: the sent message
  has one mention part whose `target` matches; delete the chip before sending: no mention part.
- [ ] **5.4 Chips and hover cards.** A chip shows the friendly label with the type's icon and color. Hovering
  (desktop) or tapping (phone) shows a card fetched live from the system: title, subtitle, a few fields, a preview,
  and where clicking goes (H `MentionHover`). A system may draw its own card component. Cards show a skeleton while
  loading and a quiet "Not available" if the system is offline.
  *Check:* hover a chip: `[data-testid=hover-card]` shows the fixture's fields; the card stays inside the viewport
  at 390 (flips above or below as needed).
- [ ] **5.5 Methods.** When the hover card has a typed value, it lists the type's methods the person may run;
  running one opens its args form and shows the result (H Types).
  *Check:* a Customer chip's card offers `upgrade`; running it shows a run card in the thread.
- [ ] **5.6 `/` commands.** `/` at the start opens the session's commands with descriptions; while typing args, a
  hint row above the composer names the current argument and marks required ones (P R-0535, H `commands[].args`).
  Re-running an argument-less command already in the session says "Already added" instead of adding it twice (P
  R-0537). Sends as a command part, shown as a chip.
  *Check:* `/tre` lists `fs/tree`; after `/tree ` the hint shows `root (optional)`; sending shows a command chip.
- [ ] **5.7 `!` invocation.** `!` at the start opens a search of fns the person may run (H `invocations`). Picking
  one opens its args form inline above the composer (stacked, not a modal), generated from its gin type. Submitting
  runs it directly; that submit is the approval (P R-0539a). The result shows as an invocation card in the thread.
  Fns not usable now show greyed with the reason (P R-0540b).
  *Check:* `!edit` → pick `fs/edit` → form with path, find, replace; Submit is disabled until valid; submit creates
  a run card attributed to the user.
- [ ] **5.8 Inputs for every gin type.** The form generator has an input for every gin type: text (with
  constraints), numbers, booleans, enums (select or segmented), dates and timestamps, lists (add, remove, reorder),
  objects (nested, optional fields can be removed and re-added), unions (a type switcher), maps, and refs to named
  types; defaults and per-field docs show as hints; errors show under the field (P R-70, H). Systems register custom
  inputs for their own types (H `inputs: { Entry: EntryInput }`).
  *Check:* a fixture fn whose args use every gin type renders a control for each; invalid values show field errors
  and block submit; the submitted value parses with gin.
- [ ] **5.9 Attachments.** Attach button, drag and drop onto the thread (with a drop highlight), and paste of images.
  Staged files show as chips with name, size, an upload progress ring and remove (C attached files row, P staged
  chips); Send waits until uploads finish (P upload guard). Sent files render as typed chips, images as thumbnails
  that zoom (P `attachments.tsx`). Only when `uploads` is on.
  *Check:* drop a PNG: a chip with a progress ring, then a thumbnail after send; Send is disabled during upload.
- [ ] **5.10 Voice.** A mic button records, shows a live recording indicator with elapsed time, then "Transcribing…",
  and drops the text at the caret for editing before send (P `voice.tsx`, H `transcribe`). Mic permission denied
  shows a dismissable explanation. Only when `voiceInput` is on.
  *Check:* with a fake media stream and fake `transcribe`, tapping mic then stop inserts the fake text at the caret.
- [ ] **5.11 Draft and latch.** The draft is saved per session (survives switching, a blocking approval, and
  reload; P). A send in flight latches so a double tap can't send twice (P `sendingRef`); a failed send restores the
  text, mentions and files.
  *Check:* double-click Send: one message; make `send` fail: the text is back in the composer with an error toast.
- [ ] **5.12 Meta row.** A quiet row under the input: agent and model (click to change; C), enabled systems count,
  the session cost so far with the budget meter (§9), and a background-work indicator (C, P meta bar). Collapses to
  icons on phone.
  *Check:* at 390 the row is one line with no overlap; clicking the model opens the model picker.
- [ ] **5.13 Input history.** Up in an empty composer recalls your last message for editing. Small; M1 if cheap.

## 6. Session controls: stop, pause, undo

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 6.1 | Stop: pause or cancel, as far as runs allow | P0 | M1 | P, H, C |
| 6.2 | Undo the last turn, with a report | P0 | M1 | H, P |
| 6.3 | Per-run undo from the drawer | P1 | M1 | H |
| 6.4 | Resume a paused turn | P0 | M1 | P, H |

- [ ] **6.1 Stop.** While a turn runs, Stop opens a small menu with Pause (resumable) and Cancel, each shown only if
  `SessionControls` allows it (P `interrupt.tsx`, H). Cancel lists runs that won't stop ("2 runs will finish and
  report"; H `uncancellable`). The UI marks the turn stopping at once, then confirms from events. C's single Stop
  button is the floor.
  *Check:* with a fake turn whose controls allow only cancel, Stop shows only Cancel; after cancel, the indicator
  stops within one event and Stop disappears.
- [ ] **6.2 Undo turn.** "Undo" on the last turn (header and the turn's action bar) undoes every run with an undo
  payload, newest first, and posts a note listing what was created, updated and removed, what failed, and what
  couldn't be undone (H `UndoReport`). Offered only when `undoLastTurn` is true. A short toast offers to jump to
  the note.
  *Check:* a turn that edited two files: Undo posts a note naming both files; the turn shows status undone.
- [ ] **6.3 Run undo.** The run drawer offers Undo for a single undoable run (H `undo`), with the same report.
  *Check:* undo one run of two: only that one shows undone.
- [ ] **6.4 Resume.** A paused turn shows a "Paused" line with Resume (P interrupt resume).
  *Check:* pause, then Resume: the status line goes back to active.

## 7. Approvals, forms and questions

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 7.1 | Approval card | P0 | M1 | P, C, H |
| 7.2 | Several approvals: one at a time, or decide all | P0 | M1 | P, C |
| 7.3 | Handler calls answered by the user | P0 | M1 | H, P |
| 7.4 | Fn forms (`ctx.form`) in the card | P0 | M1 | H |
| 7.5 | Questions with options | P1 | M1 | C, P |
| 7.6 | Approval refreshed if the fn changed | P1 | M1 | P |

- [ ] **7.1 Approval card.** A run awaiting approval shows a card with the fn's label and description, its args in
  readable form (long values clamped with Show more; P `APPROVAL_ARG_MAX_CHARS`), and Approve / Deny with a remember
  choice: once, for this session, always (H `approve.remember`; "always" becomes a policy). Deny can take a reason.
  The card sits directly above the composer so it can't be lost at the foot of a long thread (P feedback item 6),
  and the run's card in the thread shows "Waiting for approval". Fns allowed by policy never show a card.
  *Check:* a fake approval event shows `[data-testid=approval-card]` above the composer; Approve with "session"
  sends `remember: 'session'`; the run card moves to running.
- [ ] **7.2 Several at once.** Pending approvals and forms queue oldest first and resolve one at a time (P); when
  several approvals come from one answer, Approve all / Deny all, or decide each then Submit (C's Approve All /
  Reject All / Submit). The composer stays usable for typing (harness can keep it; P hides it), with a count badge
  "3 waiting".
  *Check:* three approvals: the badge reads 3; Approve all approves three.
- [ ] **7.3 Handler calls.** When a fn's handler is answered by a person ("confirm overwrite?", "pick a file"), a
  form card for the handler's type appears like an approval (H `HandlerCall`, `answer`). Also lands in the inbox
  if the person isn't in the session (P R-0541).
  *Check:* a fake handler call renders a form; submitting calls `answer` with the typed value.
- [ ] **7.4 Fn forms.** A fn that waits in `ctx.form()` shows its form in its card (or the system's renderer
  does), and submission is a delivery with live state (H Forms, 4.14).
  *Check:* the `approve` example fn shows a form; submit → the run ends done with the submitted value.
- [ ] **7.5 Questions.** An agent asking the user questions shows them as a stepper: single or multiple choice per
  question, an "other" free answer, Back and Next, Submit at the end (C `QuestionsModal`, P `ask_questions`). Inline
  card, not a modal.
  *Check:* two questions: answer both, Submit sends both answers.
- [ ] **7.6 Changed fn.** If the fn's definition changes while it waits, the card refreshes to the new definition
  rather than keep the stale one (P R-03-045).
  *Check:* push an updated approval event: the card shows the new description.

## 8. Several people, replies and notifications

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 8.1 | Reply to a message | P0 | M1 | H |
| 8.2 | Reply-all | P0 | M1 | H |
| 8.3 | Participants and who will answer | P1 | M1 | H, P |
| 8.4 | Presence and typing | P1 | M1 | H |
| 8.5 | Notify preference per person | P1 | M1 | H |
| 8.6 | Inbox with unread badge | P0 | M1 | H, P |
| 8.7 | Web push notifications | P1 | M1 | H |
| 8.8 | Tab title and favicon badge | P1 | M1 | new |
| 8.9 | Invite people and agents | P2 | | P |

M1 runs in single admin mode, so most of §8 is exercised with a second fake actor in tests; the UI must still be
built for it, because the hub design depends on reply and reply-all.

- [ ] **8.1 Reply.** "Reply" on any message sets `replyTo`: a quoted strip above the composer with the author and a
  one-line excerpt, dismissable. The sent message shows a small quote that jumps to the original. With several
  people, replying to an agent's message is how that agent is asked to answer (H).
  *Check:* reply to an assistant message: the sent payload has `replyTo`; the quote in the thread scrolls to and
  flashes the original.
- [ ] **8.2 Reply-all.** A "Reply all" toggle on the composer (visible when the session has more than one agent or
  person) sends `replyAll: true`; every agent answers, each in its own attributed answer (H).
  *Check:* with two fake agents, a reply-all produces two answers, each with its agent's name.
- [ ] **8.3 Participants.** A compact avatar stack in the header opens a panel listing people and agents with
  their role. Before sending, the composer says who will answer ("Chat agent will answer", "No agent will answer;
  reply to one or use Reply all"), computed from the same rule the hub uses (H `answerers`).
  *Check:* two people, plain message: the hint says no agent will answer; set reply to the agent: the hint names it.
- [ ] **8.4 Presence and typing.** Others' typing shows as "Ana is typing…" under the thread; avatars of people
  looking at the session are highlighted (H `Presence`). The client reports focus and typing, throttled.
  *Check:* a fake presence event shows the typing line; it clears after the timeout.
- [ ] **8.5 Notify preference.** Per session: notify me of every message, of replies to mine, or nothing (H
  participants `notify`).
  *Check:* changing it calls the hub and persists after reload.
- [ ] **8.6 Inbox.** A bell with an unread count, live (H `notification` events; P events inbox). The inbox lists
  approval or input needed, replies, turns finished while away, pairing, systems needing config or disconnected,
  spend limits (H `NotificationReason`). Each links to its place (session, approval, run) and marks read.
  `/inbox` is a page.
  *Check:* push a notification: the badge increments; clicking it opens the linked session and the badge
  decrements.
- [ ] **8.7 Web push.** Ask permission at a sensible moment (after the first time something needs the user while
  they're away, not on load), subscribe (H `subscribePush`), and show pushes for the same reasons; clicking one
  opens the right URL. Requires HTTPS or localhost.
  *Check:* with a granted permission in a headless browser, `subscribePush` is called with an endpoint; a service
  worker `notificationclick` opens the link URL.
- [ ] **8.8 Tab badge.** The tab title shows a count when something needs you ("(2) harness"), and the favicon
  gets a dot; a finished turn in a hidden tab gets a soft chime if enabled. New.
  *Check:* with the page hidden, an approval event changes `document.title` to start with "(1)".
- [ ] **8.9 Invite.** Add a person or agent to a session from the participants panel (P roster/invite). Later,
  once there is more than one account.

## 9. Budgets, cost and models

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 9.1 | Live cost meter | P0 | M1 | P, C, H |
| 9.2 | Budget meter showing the tightest budget | P0 | M1 | H |
| 9.3 | Budget reached card | P1 | M1 | P, H |
| 9.4 | Model picker | P1 | M1 | C, P |
| 9.5 | Agent picker and switching | P1 | M1 | P, C |
| 9.6 | Session settings: systems, priority, budgets | P1 | M1 | H, P |

- [ ] **9.1 Cost meter.** The session's cost so far, updated live as runs and LLM calls settle (run `cost`
  updates), ticking up rather than jumping (P live cost meter, C total cost in the meta row). The current turn's
  cost shows while it runs.
  *Check:* push cost updates 0.01 → 0.03: the meter ends at $0.03 without reload.
- [ ] **9.2 Budget meter.** A small bar showing how much of the tightest applicable budget is used and which one it
  is (session, user, group, hub; per turn or window), with a tooltip listing all of them (H `limits`, "the chat's
  budget meter shows which one is the tightest"). Amber near the limit, red at it.
  *Check:* a fake `limits` with the session budget tightest: the tooltip names it; at 90% the bar is amber.
- [ ] **9.3 Budget reached.** When a budget is hit and it asks someone to raise it, an inline card says which
  budget, how much, and offers Raise and resume or Leave it (P limit-exceeded card, H "asks someone to raise it").
  If the budget waits for its window, the line says when it frees up.
  *Check:* a fake budget event renders the card; Raise sends the new value.
- [ ] **9.4 Model picker.** Search models by name, with price, context size and capabilities, filters and sort (C
  and P `ModelSelector`). Sets the session's model; "Default" clears it.
  *Check:* search "free" filters to free models; picking one shows it in the meta row and persists.
- [ ] **9.5 Agent picker.** Choose the session's agent fn when creating a session and switch later; a switch shows
  "Switching to X on your next message" until then (P §6).
  *Check:* switch agent: the pending label appears; after sending, the answer is from the new agent.
- [ ] **9.6 Session settings.** Which systems apply to the session (H `systems`), priority, and session budgets,
  in a panel tied to the URL.
  *Check:* disable the fs system for the session: `@` no longer shows fs results and `!` no longer lists fs fns.

## 10. Suggested context and fns from the message embedding

The hub adds suggested context and fns to every user message from the embedding index (H "What gets added to a
message"); the owner asked to see them in the product.

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 10.1 | Suggestions chip under each user message | P0 | M1 | P, H |
| 10.2 | Delivery state per suggestion | P0 | M1 | P |
| 10.3 | Use a suggestion yourself | P1 | M1 | P |
| 10.4 | Starter questions on an empty session | P1 | M1 | P, H |
| 10.5 | Live suggestions while typing | P2 | | new |
| 10.6 | Suggestion feedback to the index | P2 | | P |

- [ ] **10.1 Chip.** Under each user message, small chips "4 context" and "3 fns" (only when non-empty) open a list
  of what the embedding of that message surfaced: each item's friendly name, its system, description and score
  (P Suggest-context and suggested-fns chips). The raw qualified name rides the tooltip, not the text. Comes from
  the message's `extra` parts.
  *Check:* a fixture message with suggested context and fns shows both chips with the right counts; the list shows
  scores sorted high to low.
- [ ] **10.2 Delivery state.** Each suggestion is tagged: added automatically, offered only, or loaded by the agent
  during the turn (P `buildSuggestedView`: auto-injected / suggested / loaded).
  *Check:* a fixture where the agent loaded one suggested fn tags it "Loaded".
- [ ] **10.3 Use one.** From the list, a person can add a suggested context to the next message (as its `/`
  command) or open a suggested fn's `!` form.
  *Check:* clicking a suggested fn opens its invocation form in the composer.
- [ ] **10.4 Starters.** An empty session shows contexts that offer a question to users as tappable cards (P pre-chat
  questions); tapping sends that question with its context (P user-message-format §5).
  *Check:* see 1.5.
- [ ] **10.5 While typing.** After a pause in typing, the composer shows a faint row of the top suggested
  fns and context for the draft, from the same index (debounced, cancelled on keystroke). Later; useful but adds
  embedding load per keystroke pause.
- [ ] **10.6 Feedback.** Report which suggestions were taken so ranking can learn (P). Later.

## 11. Attachments, links and resources in answers

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 11.1 | Attachment cards from fns | P0 | M1 | H |
| 11.2 | Link cards: resources, URLs, files, runs | P0 | M1 | H, C |
| 11.3 | Resource viewer by format | P0 | M1 | H, C |
| 11.4 | Charts and diagrams | P2 | | C |

- [ ] **11.1 Attachment cards.** Typed attachments a fn adds to the assistant message render through the owning
  system's attachment renderer (e.g. the fs `diff` view), or a default card with title and a JSON peek (H
  `attach`).
  *Check:* an `fs/diff` attachment renders the diff view inside the answer.
- [ ] **11.2 Link cards.** Links to resources, URLs, files and runs render as clickable cards with an icon, title and
  where they go; a run link opens the run drawer (H `link`).
  *Check:* a run link card opens `?run=` for that run.
- [ ] **11.3 Resource viewer.** Opening a resource shows it in a side panel (full screen on phone) using the shared
  viewer for its format: text and code with highlighting, markdown rendered, images with zoom, others as download
  (H resource viewers, C `FileViewer` with download). URL-tied.
  *Check:* opening `harness.md` from a mention card shows rendered markdown; reload keeps it open.
- [ ] **11.4 Charts and diagrams.** Chart blocks (ECharts) in answers (C `ChartViewer`); Mermaid is in 3.2. Later.

## 12. Keyboard and accessibility

| # | Feature | Pri | M1 | From |
|---|---|---|---|---|
| 12.1 | Shortcuts | P1 | M1 | P, C, new |
| 12.2 | Screen reader and focus | P0 | M1 | P |

- [ ] **12.1 Shortcuts.** Enter / Shift+Enter / Ctrl+Enter (5.1); Escape closes the top popover, drawer or dialog
  in that order and never more than one (P `stopPropagation`); `/` focuses the composer when focus is elsewhere;
  Ctrl+K opens session search; Ctrl+Shift+O new chat; Up in an empty composer edits the last message (5.13); Alt+↑/↓
  moves between sessions; `?` lists shortcuts. Shortcuts never fire while typing in a form field (except the composer's
  own).
  *Check:* with a drawer and a popover open, Escape closes only the popover; Ctrl+K opens search; `?` shows the list.
- [ ] **12.2 Accessibility.** The thread is a `role=log` with `aria-live=polite` that announces finished answers,
  not every token; popovers are ARIA comboboxes (P `useComboboxList`); every icon button has a label; focus is
  trapped in dialogs and returned after; visible focus rings.
  *Check:* axe-core on the main views reports no serious or critical issues; every `button` has an accessible name.

## 13. Settings and admin surfaces reachable from chat

Not the chat itself, but the chat links into them and they share its shell. Owned elsewhere; listed so routing and
layout cover them.

- [ ] **13.1 Sign in** (single admin account, H `signIn`), remembering the session. M1. *Check:* wrong password shows
  an inline error; right one lands on `/chat` or the page that asked for sign-in.
- [ ] **13.2 Systems page**: status, enable, turn off functions or renderers separately, config forms, pairing
  approvals. M1. *Check:* a system needing config shows a badge in chat's header and a link to its form.
- [ ] **13.3 Configuring by asking**: hub native fns that change settings always ask approval (H), so 7.1 covers the UI.

---

## Gaps in the harness design the chat needs

Found while mapping features to `types/hub.ts` and `types/sdk.ts`. Recorded for the type and hub owners; this task
edits none of them.

1. **Status text for runs (4.2, 4.3).** Product's fns carry four state templates with singular and plural forms
   (`fn-status.md`); harness `FnDecl` has none and `RunUpdate` has no status text. Need: an optional `status`
   declaration on fns (with a kind default), and the resolved text in the run event so the UI never builds it.
2. **Reasoning in messages (3.9).** `MessagePart` has no reasoning part, and `BrowserEvent` has no reasoning tokens.
3. **Per-message usage (3.7).** `ChatMessage` has no usage or cost; derivable from the turn's `LlmInteraction`s, but
   the web API has no read for a turn's LLM calls (only `llmCall` by id and `tree`).
4. **Session edits.** `HubWebApi.updateSession` can't set `title` or `archived`, and there is no delete, session
   search beyond `sessions({ search })`, or message search.
5. **Edit and resend, retry (3.5, 3.6).** Doable as `undoTurn` for each later turn plus `send`, but an
   `undoFrom({ turn })` that undoes a turn and every later one in one call would keep the report in one note.
6. **Suggestion details (10.1, 10.2).** The `extra` part's `blocks: Json[]` is untyped; the UI needs a typed block
   with name, system, kind (context or fn), score and whether it was added automatically, plus a way to know an
   agent loaded it later in the turn.
7. **Feedback (3.12).** No message feedback call. Later.
8. **Typing presence timeout and throttle** are unstated; pick values in an env slice.
9. **Budget event (9.3).** `BrowserEvent` has no budget-reached event or a raise call; `spend-limit` exists only as a
   notification reason.
10. **Collapse and UI prefs (4.12, 1.6).** Per-device UI state (theme override, collapsed cards, sidebar) is client
    local storage; no hub change needed, noted so nobody adds one.

## First milestone count

94 features in sections 1 to 12. 87 are marked M1; the 7 later ones are 3.12 feedback, 3.14 read aloud, 4.15 LLM turn summary,
8.9 invite, 10.5 live suggestions while typing, 10.6 suggestion feedback, and 11.4 charts (13.x are shared
surfaces owned elsewhere).
