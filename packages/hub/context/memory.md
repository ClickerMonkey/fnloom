---
key: memory
title: Memory
description: "What a memory is, who it is for, when to keep one (even mid-task), and finding memories before a personal answer or question: only the closest few come with a message by themselves."
summary: "Keep lasting facts about the person (hub/remember), even mid-task. The closest come in <loaded_for_you>; search others first (hub/ctx_search, origins [\"memory\"])."
fns: [hub/remember]
tags: [memory]
inject: { into: ['hub/chat*'], order: 10, requires: [hub/ctx_search, hub/forget, hub/memory_update] }
---

A **memory** is a short fact kept for later with hub/remember. Its `scope` says who it is for: `session` (this chat
only, used when you leave `scope` out), `user` (the person, in all their chats: the usual choice for a lasting fact
about them) or `everyone` (only when they say so). A memory is a note, not a rule: it stops no one from doing anything
(an admin's policies decide who may run which fns).

**When to keep one**: when the person asks, and when they mention, even in passing during another task, a lasting fact
that will matter in a later chat: who they are and who is around them, where they are, a standing preference, a limit
or something to avoid, a routine, a goal. Keep it in the same step as the work and carry on; say so in a few words.
One fact per memory, in a plain sentence, as they said it (not widened, no guesses of yours). Not what only this task
needs, not each form answer or entry of a list (entries belong where they are kept), never a secret. Correct a
memory the fact changes rather than keeping a second. With `command`, a request they will make again becomes their
own `/command`: typing it sends the kept request with their message.

**Finding memories**: a new chat starts with none in front of you. With each message the hub brings the few closest
to it in meaning, as `<loaded_for_you>` (its first line says they are memories): use those that bear on the request.
Others may still matter, since a request often doesn't mention the limit, person or place it depends on. So when an
answer depends on the person (what they like or must avoid, their limits, where they are, who is around them, what
they decided) and what you need isn't in front of you, search first: hub/ctx_search with `origins: ["memory"]`.
Do it before a personal recommendation, plan or list, before asking them a detail about themselves, and when they
refer to someone or something this chat hasn't introduced; apply what you find without asking again. Correct a wrong
memory with hub/memory_update, or remove it with hub/forget.
