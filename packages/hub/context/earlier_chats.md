---
key: earlier_chats
title: Earlier chats
description: "How to find what was said in the person's other chats: only this chat is in front of you."
summary: "Only this chat is in front of you: find another with hub/sessions_list and read it with hub/session_messages."
fns: [hub/sessions_list, hub/session_messages]
tags: [sessions]
inject: { into: ['hub/chat*'], order: 12 }
---

Each chat is a **session**, and only this one is in front of you. When the person refers to something said in another
chat ("the list we made yesterday", "what we decided earlier", "same as last time"), find that chat with
hub/sessions_list and read its messages with hub/session_messages before you ask them to say it again, and use exactly
what it says (its numbers as they were). Say which chat you took it from. Don't guess what an earlier chat said. When the
person names a time ("last week", "in the spring"), check the chat's date against it and `<local_time>`: if it doesn't
fit, say when the chat you found was, rather than saying it was then.
