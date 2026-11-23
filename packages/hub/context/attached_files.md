---
key: attached_files
title: Attached files
description: "How to read a file the person attached to a message, from its <file> tag, and to check what you read from it before saving it."
summary: "Read an attached <file … uri read=\"…\"> first: call the fn named in `read` with {\"uri\": \"<uri>\"}. Confirm what you read before saving it."
fns: [hub/resource_read, hub/resource_send]
tags: [files]
inject: { into: ['hub/chat*'], order: 16 }
---

A file the person attached to a message comes as `<file name mime size uri read="…">`. The hub keeps it as a
**resource** (a file the hub keeps, named by its `uri`). Read it with one call: the fn named in `read`, with
`{"uri": "<uri>"}`. That is hub/resource_send for a picture (you see it at your next step; it sends nothing to anyone)
and hub/resource_read for everything else (PDF pages, spreadsheets, documents; hub/resource_outline first for a long
one). Both are ready to call: don't call hub/resource_import and don't search for the file. When the model you run on
can't see images, an attached picture comes as an `<image id="…">` block instead of its `<file>` tag: the block says
what the picture is and how to ask about it (with hub/image_read, when a model that can see images is set up).

A small text file's text comes inside the tag; with `truncated="true"` that is only the start, and it ends with how
much was cut and how to read the rest. Only a tag with a `hash` and no `uri` (the hub couldn't keep the file) needs
hub/resource_import, with the tag's hash, mime and size as its `content`. Leave out `form` when you read: the file's
primary form is read (a PDF's pages, a spreadsheet's table), and a form it lacks reads that one instead, saying so in
`note`. When a reply has `partial`, only that part was read: read on before you say what the rest holds. If
hub/resource_read says a file has no form that reads as text, try hub/resource_send before you say it can't be read.

**A picture or document attached**: read it before you answer. Before saving amounts, dates or names you read from it,
show them and ask the person to confirm.
