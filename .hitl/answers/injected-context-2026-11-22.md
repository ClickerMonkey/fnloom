# Injected context, one fn name, ctx fns: the decisions: answers

12 of 12 answered. Written by hitl; the answers themselves are in the .json next to this file.

## Decisions before the types are written up for approval

### name-format: Which spelling does the model see for every fn, everywhere (tools, `run`, cards, search hits, errors)?

A: `__` between every part

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### which-names: Should context keys, types and hook tags use the model format too, or only fns?

Fns only

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### static-tools: In static mode (the small models), should `find`, `inspect`, `load` and `unload` be called by their real fn names?

Keep short names (`find`, `find_ctx`, `inspect`, `load`, `unload`, `run`)

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### authored-names: About 2,600 `system/name` mentions sit in descriptions, instructions and context. How should they become model names?

Detect known names automatically, plus typed refs

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### rename-strategy: How should we roll out the renames (`load_context`→`load_ctx`, `context_crawl`→`ctx_crawl`, `context_get`/`_from_resource`/`_link`/`_unlink`→`ctx_*`, the new `ctx_search` and `drop_ctx`, the `<ctx…>` card tags) and the new name format?

Clean rename with one store migration

> Also a migration so all ctx or fns tools use that as prefix so load_ctx is ctx_load for consistency

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### approval: How does an admin approve a system's injected context?

Each new or changed injection is its own card in the system's Pending review

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### targeting: How does an injection name the agents it goes into?

Other: A simple format with asterisks for wildcard like functionality 

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### brings: Does `inject` replace `alwaysFor`, and do an injected item's fns join the agent's starting tools?

Replace `alwaysFor`; its fns join the starting tools

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### core-location: What stays as the chat agent's own instructions, and in what form?

Minimal core in code; the hub's features as hub context files

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### mode-text: How should an item whose text has to differ between tools mode and static mode do it?

One text by default; an item may say `mode: 'tools' | 'static'`

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### hook-docs: Where does a system say what its hook's block (such as `<fs__git>`) means to the model?

An `explains` field on `hook()`

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.

### caching: When a system goes off, or an admin switches an injection mid-chat, when does the prompt change?

Rebuild at the next turn, only when something changed

Applied: Recorded verbatim in docs/plans/injected-context-2026-11-22.md (Decided). Next: the design and types revised to these answers (fns-only model names, short static tools, fns_*/ctx_* prefixes, * wildcard targeting), shown to you for approval before the build.
