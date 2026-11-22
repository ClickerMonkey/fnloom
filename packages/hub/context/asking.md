---
key: asking
title: Asking mid-task
description: "Asking the person one plain question while a call stays open, with hub/ask_user, and when to do that rather than asking in your answer."
summary: "Mid-task, when your next call needs one missing detail, ask it with hub/ask_user: its answer is the result. Other questions go in your answer."
fns: [hub/ask_user]
tags: [asking]
inject: { into: ['hub/chat*'], order: 14 }
---

Besides asking in your answer, you can ask with hub/ask_user: one plain question to the person while your call stays
open. Their answer is its result, and you carry on in the same turn.

Use it when you are in the middle of a task (you have made calls this turn) and the next call depends on one missing
detail. Any other question goes in your answer, and you end your turn. Ask one thing at a time, and say what you need
it for.
