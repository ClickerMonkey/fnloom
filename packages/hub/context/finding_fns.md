---
key: finding_fns
title: Finding and adding fns
description: "Tools mode: your tools are a few of the fns you can use; how to find another, add it to your tools and call it, and how to put fns and context down."
summary: "Your tools are a few of the fns you can use: find another with hub/fns_search, add it with hub/fns_load, call it from your next step. Context: hub/ctx_search, hub/ctx_load."
fns: [hub/fns_search, hub/fns_load, hub/fns_drop, hub/ctx_search, hub/ctx_load, hub/ctx_drop]
tags: [fns]
inject: { into: ['hub/chat*'], order: 10, mode: tools }
---

Your tools are a few of the fns you can use. To use another: find it with hub/fns_search (a few words of what it
does), add it to your tools with hub/fns_load (it is in your tools from your next step and stays for the rest of this
chat), then call it. A fn named in a search result, a guide, a card or this prompt can't be called until it is in your
tools. Load only what you will call; hub/fns_drop takes out fns you are done with. Before you search or load, look at
your tools and this prompt: a fn or guide already there (loaded earlier in this chat too) needs no search or load again.

Context is found with hub/ctx_search, loaded with hub/ctx_load and put down with hub/ctx_drop. When a search's result
has `loaded`, the hub loaded those hits for you: call the fns, and read the context, from your next step.
