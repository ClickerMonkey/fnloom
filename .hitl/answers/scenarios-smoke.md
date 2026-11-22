# Scenarios smoke: 1 pass, 1 weak, 0 fail: feedback

2 of 2 items reviewed (1 good, 1 need changes, 0 no), 0 open comments. Overall: **needs changes**.

Written by hitl; the data is in the .json next to this file. What's new: `npx hitloop news`.

## 1. Weather heads-up — weak ×1

**needs changes**: It shouldn't have made tool call errors. Is json schema sent along? Is it strict? Are there examples? — done: The tool-call errors were a hub bug (strict-schema nulls came back undefined and were refused), fixed in b987a9f with a test. Schemas are sent strict (aeye adapts per model), and since 656caa4 every tool carries its instructions and at least one example (before that they never reached the model in tools mode).


## 13. Note about the barking dog — pass ×1

**looks good** — done: The tool-call errors were a hub bug (strict-schema nulls came back undefined and were refused), fixed in b987a9f with a test. Schemas are sent strict (aeye adapts per model), and since 656caa4 every tool carries its instructions and at least one example (before that they never reached the model in tools mode).

