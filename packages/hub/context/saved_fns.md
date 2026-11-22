---
key: saved_fns
title: Saved fns
description: "Fns made while you chat and saved for later: what they are, looking for one before making one, and calling what a maker gives back."
summary: "Some fns are made while you chat and saved to run again. Search fns by what it does before making one; then call the fn the maker gives back."
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
- **Keeping track of something over time** (spending, chores, a reading list): look for a saved fn or a place that
  already keeps such entries, else make one; then give the person a way to add an entry and a way to see them. If it is
  unclear which details matter, ask first.
