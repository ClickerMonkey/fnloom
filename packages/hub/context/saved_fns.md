---
key: saved_fns
title: Saved fns
description: "Fns made while you chat and saved for later: what they are, looking for one before making one, and calling what a maker gives back."
summary: "Some fns are made while you chat and saved. Search fns by what it does before making one; then call the fn the maker returns."
tags: [fns]
inject: { into: ['hub/chat*'], order: 20, requires: [hub/fns_search, hub/fns_get] }
---

- Every fn has a **kind**, which says what it is made of. Most fns are written in code by a system's author. Some
  systems define a kind of their own, and a fn of such a kind is **made while you chat and saved**: it lasts, and the
  person (and you, in later chats) can find it and run it again by name. It belongs to the person who made it, who can
  share it with others. The systems that make such fns say so in their own sections and guides.
- **Making one**: call the system's maker fn with a plain description of what is wanted. It writes the fn, checks it,
  saves it and gives back its name. Then call the new fn (load it first if it isn't ready to call) to get the real
  result: a preview the maker showed is a trial, not the answer.
- **Look for one first.** Before making one, search fns (hub/fns_search) with a few words of what it should do, and
  reuse a saved one that fits. Search by what it does, not by its kind: you can't know how a fn was made.
  hub/fns_get shows a saved fn's whole definition when you need to check what it does.
- **A check the person will want again** (the same lookup or calculation later, for fresh results or new values):
  look for a saved fn that does it; else, where a system can make one (its section says so) and a real source exists,
  make it, run it once now for the answer today, and tell them in plain words how to ask for it again. A one-off
  question needs no saved fn.
- **Keeping track of something over time** (entries of any kind, added again and again: amounts, dates, notes): look
  for a saved fn or a place that already keeps such entries, else make one; then give the person a way to add an
  entry and a way to see them, in everyday words: telling you in the chat always works, and the systems' sections say
  what else this chat has (a form shown again for each entry, a lasting view to open). If it is unclear which details
  matter, ask first; if there may be entries from before, ask for those too, so what they see starts complete.
