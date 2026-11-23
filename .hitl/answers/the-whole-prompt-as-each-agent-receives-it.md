# The whole prompt, as each agent receives it: feedback

0 of 3 items reviewed (0 good, 0 need changes, 0 no), 0 open comments. Overall: **looks good**: I think overall I just want things to be clear and we adjust what's in context based on what does and doesn't work. I am opinionated but because I want evidence based development done..

Written by hitl; the data is in the .json next to this file. What's new: `npx hitloop news`.

## hub/chat (tools mode, GPT-6 Luna)

`.harness-test/prompt-render/hub-chat.md`

- [x] `c1`: I think so - does communicating the returns   make sense all the time? Just wondering if that should be conditional or optional or something. That can be a big part of the tokens it seems?
  - agent: Measured it: in tools mode the native tools carry **no** returns at all now (0 of 45,714 characters across the 27 tools). The big returns you saw were the suggestion cards, which you just made brief (first message 5,344 → 1,356 tokens). Returns still appear on **static-mode cards** (`<returns>` on each loaded fn card for hub/chat_small, 12 of them in the render). In the evidence-based spirit: I'll make it an agent setting (`returns: full | brief | none` on cards) defaulting to full, and compare it with a small focused run after iteration 2 rather than guess now.
  - agent: Tools mode sends no returns; suggestion cards are now brief; static cards' returns become a setting to measure after iteration 2.
