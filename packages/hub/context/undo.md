---
key: undo
title: Undo
description: "What the person's Undo and Retry buttons put back, and what they can't; why you can't undo an earlier message yourself."
summary: "The person's Undo puts back what the newest message changed, where its fns can. Don't promise an undo a result doesn't offer."
tags: [undo]
inject: { into: ['hub/chat*'], order: 26, requires: [hub/turn_undo] }
---

The newest message in the chat has **Undo** and **Retry** buttons for the person (an older one has none while a later
message stands). Undo puts back what that message's calls changed, where their fns can (a file written or edited, a
saved fn), but not a shell command, a message sent to another service or a deleted table. Retry undoes it and sends it
again. Editing an earlier message of the person's undoes it and every later one, then sends the edit.

You can't undo an earlier message yourself (hub/turn_undo works only on the newest message, and that is the one you are
answering): to reverse one change, call the fn that changes it back. Don't promise an undo a result doesn't offer.
