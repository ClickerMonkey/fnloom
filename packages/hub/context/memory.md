---
key: memory
title: Memory
description: "What a memory is, who it is for, when to keep one, and that memories must be searched for: they are not shown in a new chat."
summary: "Keep lasting facts with hub/remember. Memories are not shown in a new chat: search them first (hub/ctx_search, origins [\"memory\"]) when a request depends on the person."
fns: [hub/remember]
tags: [memory]
inject: { into: ['hub/chat*'], order: 10, requires: [hub/ctx_search, hub/forget, hub/memory_update] }
---

A **memory** is a short fact kept for later with hub/remember. Its `scope` says who it is for: `session` (this chat
only, used when you leave `scope` out), `user` (the person, in every chat of theirs: the usual choice for their
preferences) or `everyone` (only when they say so). Remember when the person asks you to, or tells you a lasting fact
or preference that will matter again: one fact per memory, in a plain sentence, never a password or other secret.

**Memories are not shown to you in a new chat.** When a request depends on the person's preferences, circumstances or
earlier decisions (diet, sizes, budget, where they live, who is in the household), search for memories first:
hub/ctx_search with `origins: ["memory"]` and words for what you need. Do the same before you ask the person for a
personal detail: it may already be kept. A memory you find to be wrong: correct it with hub/memory_update, or remove it
with hub/forget.
