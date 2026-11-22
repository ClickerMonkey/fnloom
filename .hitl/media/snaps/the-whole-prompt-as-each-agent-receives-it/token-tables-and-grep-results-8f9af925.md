# Chat prompts for "I keep forgetting what I spend on groceries. Can you help me keep track?"

## hub/chat, tools mode, openai/gpt-6-luna

| Part | Tokens |
|---|---:|
| core instructions | 3,433 |
| systems list | 2,241 |
| mode guide | 0 |
| injected: hub/finding_fns (full) | 191 |
| injected: hub/memory (full) | 263 |
| injected: hub/earlier_chats (full) | 101 |
| injected: hub/asking (full) | 125 |
| injected: hub/attached_files (full) | 303 |
| injected: hub/resources (full) | 157 |
| injected: hub/saved_fns (full) | 371 |
| injected: hub/examples (full) | 84 |
| injected: hub/background_runs (full) | 128 |
| injected: hub/undo (full) | 193 |
| injected: hub/limits (full) | 243 |
| injected: api/basics (full) | 228 |
| injected: code/basics (full) | 169 |
| injected: database/basics (full) | 345 |
| injected: fs/basics (full) | 210 |
| injected: fs/git (full) | 69 |
| injected: input/basics (full) | 306 |
| injected: web/basics (full) | 226 |
| injected: widgets/basics (full) | 196 |
| injected section, total | 3,898 |
| other context (cards, citations rule, tail) | 0 |
| tools (27) | 12,909 |
|   tool hub__fns_search | 980 |
|   tool hub__fns_load | 288 |
|   tool hub__fns_drop | 130 |
|   tool hub__ctx_search | 486 |
|   tool hub__ctx_load | 386 |
|   tool hub__ctx_drop | 170 |
|   tool hub__remember | 794 |
|   tool hub__sessions_list | 558 |
|   tool hub__session_messages | 196 |
|   tool hub__ask_user | 258 |
|   tool hub__resource_read | 508 |
|   tool hub__resource_send | 215 |
|   tool hub__search_resources | 238 |
|   tool hub__fns_examples | 302 |
|   tool hub__run_status | 214 |
|   tool hub__run_wait | 251 |
|   tool api__services | 222 |
|   tool api__make_api | 695 |
|   tool code__make_code | 750 |
|   tool database__databases | 199 |
|   tool database__get_query | 1,382 |
|   tool fs__list | 288 |
|   tool fs__read | 389 |
|   tool input__get_input | 1,029 |
|   tool web__search | 602 |
|   tool web__read | 476 |
|   tool widgets__make_widget | 903 |
| messages (1) | 5,344 |
| system message, whole | 9,570 |
| request estimate (planner) | 27,836 |

Window 1,050,000: reply 16000, reasoning 64000, margin 63000, so 907,000 for the prompt; the estimate is 27,836 (fits). Nothing was cut.

Fns spelled `system/name` in the rendered prompt, tools and messages: none.

Other `system/name` spellings of an installed system that name no fn, context key or type (example fn names, not real fns): `api/github.open_issues` ×3, `code/price_with_tax` ×3, `database/main.expenses` ×1, `database/main.expenses_by_month` ×2, `input/trip_details` ×6, `api/request` ×3, `code/program` ×3, `database/query` ×1, `database/main.expenses_create` ×3, `input/form` ×3, `widgets/widget` ×1, `fs/authoring.kinds` ×1, `database/main.sales_by_month` ×1, `code/total_with_tax` ×1, `database/main.orders_by_status` ×6, `input/ask_` ×1, `widgets/spending_by_month` ×1, `database/main.spending_by_category` ×1, `database/main.overdue_invoices` ×7, `database/main.projects` ×2, `database/main.projects_selectPage` ×1.

Installable systems the core instructions name (word matches; `input` and `web` are also English words):
- `input`: "- **Invalid input** comes back as a few lines, each `path: what was expected` (for a type, the expected shape, such as `{"name":"obj","props":{"store":{"type":{"; "- **What to do when a call doesn't give what you need.** When a fn is refused or unavailable, stop: tell the person what blocks you and why, with the reason the"
- `web`: "- `<link>`: a link the person included, to a resource, a web page, a stored file or a run."

## hub/chat_small, static mode, qwen2.5:3b at a 2,048-token window

The planner refuses it at 2,048: "This message is about 28 tokens; qwen2.5:3b takes 0 here. Shorten it or pick a model with a larger window."

A 2,048 window leaves 1,413 tokens for the prompt (reply 512, margin 123). The parts the planner places whole: core 969, systems list 2558, mode guide 126, tools 1596: 5,249, before the message (48). So hub/chat_small does not fit 2k: the fixed part alone is 3,836 over, the injected section gets no room (its share of what is left is 0, so every item is cut), and the message has nowhere to go, which is the refusal.

As planned at a 16,384 window (same estimator, same 512-token reply):

| Part | Tokens |
|---|---:|
| core instructions | 969 |
| systems list | 2,558 |
| mode guide | 126 |
| injected: hub/memory (listed) | 53 |
| injected: hub/earlier_chats (summary) | 41 |
| injected: hub/asking (summary) | 52 |
| injected: hub/attached_files (summary) | 59 |
| injected: hub/resources (summary) | 41 |
| injected: hub/saved_fns (summary) | 50 |
| injected: hub/examples (summary) | 31 |
| injected: hub/background_runs (summary) | 44 |
| injected: hub/undo (summary) | 43 |
| injected: hub/limits (summary) | 58 |
| injected: api/basics (summary) | 47 |
| injected: code/basics (summary) | 41 |
| injected section, total | 577 |
| other context (cards, citations rule, tail) | 6,905 |
| tools (6) | 1,596 |
|   tool find | 514 |
|   tool find_ctx | 294 |
|   tool inspect | 160 |
|   tool load | 170 |
|   tool unload | 126 |
|   tool run | 332 |
| messages (1) | 48 |
| system message, whole | 11,132 |
| request estimate (planner) | 12,789 |

Window 16,384: reply 512, reasoning 0, margin 984, so 14,888 for the prompt; the estimate is 12,789 (fits). Cut: injected Memory (hub/memory) (as a line under <more_ctx>, to fit the injected section); injected Widgets (widgets/basics) (left out of the injected section: it did not fit); injected The web (web/basics) (left out of the injected section: it did not fit); injected Forms (input/basics) (left out of the injected section: it did not fit); injected The <fs_git> block (fs/git) (left out of the injected section: it did not fit); injected Files (fs/basics) (left out of the injected section: it did not fit); injected Databases (database/basics) (left out of the injected section: it did not fit).

Injected items left out: hub/finding_fns (mode: only for the tools mode; this chat is in static); widgets/basics (no-fit: did not fit the injected section (600 tokens)); web/basics (no-fit: did not fit the injected section (600 tokens)); input/basics (no-fit: did not fit the injected section (600 tokens)); fs/git (no-fit: did not fit the injected section (600 tokens)); fs/basics (no-fit: did not fit the injected section (600 tokens)); database/basics (no-fit: did not fit the injected section (600 tokens)).

Fns spelled `system/name` in the rendered prompt, tools and messages: none.

Other `system/name` spellings of an installed system that name no fn, context key or type (example fn names, not real fns): `api/request` ×2, `api/github.open_issues` ×1, `code/program` ×2, `code/price_with_tax` ×1, `database/query` ×1, `database/main.expenses_create` ×1, `input/form` ×1, `input/trip_details` ×2, `widgets/widget` ×1, `hub/ctx_dr` ×1, `hub/data` ×1, `hub/m` ×1, `database/main.sales_by_month` ×1.

Installable systems the core instructions name (word matches; `input` and `web` are also English words):
- `input`: "- When a fn is refused or unavailable, stop: tell the person what blocks you and why, with the reason the hub gave (such as "this fn changed and waits for an ad"

## hub/chat_small, static mode, openai/gpt-6-luna

| Part | Tokens |
|---|---:|
| core instructions | 848 |
| systems list | 2,238 |
| mode guide | 111 |
| injected: hub/memory (listed) | 47 |
| injected: hub/earlier_chats (summary) | 37 |
| injected: hub/asking (summary) | 46 |
| injected: hub/attached_files (summary) | 51 |
| injected: hub/resources (summary) | 37 |
| injected: hub/saved_fns (summary) | 43 |
| injected: hub/examples (summary) | 27 |
| injected: hub/background_runs (summary) | 39 |
| injected: hub/undo (summary) | 38 |
| injected: hub/limits (summary) | 50 |
| injected: api/basics (summary) | 41 |
| injected: code/basics (summary) | 37 |
| injected: database/basics (summary) | 40 |
| injected: fs/basics (summary) | 38 |
| injected section, total | 582 |
| other context (cards, citations rule, tail) | 102,055 |
| tools (6) | 1,399 |
|   tool find | 450 |
|   tool find_ctx | 258 |
|   tool inspect | 140 |
|   tool load | 149 |
|   tool unload | 111 |
|   tool run | 291 |
| messages (1) | 42 |
| system message, whole | 105,833 |
| request estimate (planner) | 107,286 |

Window 1,050,000: reply 16000, reasoning 64000, margin 63000, so 907,000 for the prompt; the estimate is 107,286 (fits). Cut: injected Memory (hub/memory) (as a line under <more_ctx>, to fit the injected section); injected Widgets (widgets/basics) (left out of the injected section: it did not fit); injected The web (web/basics) (left out of the injected section: it did not fit); injected Forms (input/basics) (left out of the injected section: it did not fit); injected The <fs_git> block (fs/git) (left out of the injected section: it did not fit).

Injected items left out: hub/finding_fns (mode: only for the tools mode; this chat is in static); widgets/basics (no-fit: did not fit the injected section (600 tokens)); web/basics (no-fit: did not fit the injected section (600 tokens)); input/basics (no-fit: did not fit the injected section (600 tokens)); fs/git (no-fit: did not fit the injected section (600 tokens)).

Fns spelled `system/name` in the rendered prompt, tools and messages: none.

Other `system/name` spellings of an installed system that name no fn, context key or type (example fn names, not real fns): `api/request` ×3, `api/github.open_issues` ×2, `code/program` ×3, `code/price_with_tax` ×2, `database/query` ×2, `database/main.expenses_create` ×1, `input/form` ×1, `input/trip_details` ×6, `widgets/widget` ×1, `hub/llm` ×4, `hub/fns` ×1, `hub/context` ×1, `hub/whole` ×1, `hub/headings` ×1, `hub/symbols` ×1, `hub/pages` ×1, `hub/paragraphs` ×1, `hub/tables` ×1, `database/main.spending_by_month` ×1, `database/main.expenses` ×1, `database/main.chores` ×1, `database/main.chores_create` ×3, `database/main.chores_selectPage` ×1, `database/main.expenses_by_month` ×1, `widgets/spending_by_month` ×1, `database/main.spending_by_category` ×1, `database/main.projects` ×2, `database/main.sales_by_month` ×1, `code/total_with_tax` ×1, `database/main.overdue_invoices` ×7, `database/main.orders_by_status` ×6, `database/main.projects_selectPage` ×1.

Installable systems the core instructions name (word matches; `input` and `web` are also English words):
- `input`: "- When a fn is refused or unavailable, stop: tell the person what blocks you and why, with the reason the hub gave (such as "this fn changed and waits for an ad"
