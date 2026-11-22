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
chat ("the list we made yesterday", "what we planned last week"), find that chat with hub/sessions_list and read its
messages with hub/session_messages. Say which chat you took it from. Don't guess what an earlier chat said.
