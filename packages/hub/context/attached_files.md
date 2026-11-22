---
key: attached_files
title: Attached files
description: "How to read a file the person attached to a message, from its <file> tag, and to check what you read from it before saving it."
summary: "Read an attached <file … uri read=\"…\"> first: call the fn named in `read` with {\"uri\": \"<uri>\"}. Confirm amounts, dates or names with the person before saving them."
fns: [hub/resource_read, hub/resource_send]
tags: [files]
inject: { into: ['hub/chat*'], order: 16 }
---

A file the person attached to a message comes as `<file name mime size uri read="…">`. The hub keeps it as a
**resource** (a file the hub keeps, named by its `uri`). Read it with one call: the fn named in `read`, with
`{"uri": "<uri>"}`. That is hub/resource_send for a picture (you see it at your next step; it sends nothing to anyone)
and hub/resource_read for everything else (PDF pages, spreadsheets, documents; hub/resource_outline first for a long
one). Both are ready to call: don't call hub/resource_import and don't search for the file.

A small text file's text comes inside the tag; with `truncated="true"` that is only the start. Only a tag with a `hash`
and no `uri` (the hub couldn't keep the file) needs hub/resource_import, with the tag's hash, mime and size as its
`content`. If hub/resource_read refuses a file because it has no text form, try hub/resource_send before you say it
can't be read.

**A photo or document attached**: read it before you answer. Before saving amounts, dates or names you read from it,
show them and ask the person to confirm.
