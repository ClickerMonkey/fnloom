# To-do batch done: follow-up calls: answers

8 of 8 answered. Written by questionme; the answers themselves are in the .json next to this file.

### aits-commit: The aits work (@aeye/ollama, System One decide, maxQuestions, image embeddings, resources image links) is uncommitted on aits branch `harness`. What now?

Commit locally on harness, no push/tag

Applied: Recorded in docs/plans/todo-2026-11-18.md. aits committed locally (52b9a37). SSO redirect, A/B undo notice, Claude Stop and the api connection check are being built now. Nothing pushed.

### push-harness: Harness has 6 new local commits (beb633b … c947bad), plus ayepi 0855f3b. Push?

Hold until you've tried it

Applied: Recorded in docs/plans/todo-2026-11-18.md. aits committed locally (52b9a37). SSO redirect, A/B undo notice, Claude Stop and the api connection check are being built now. Nothing pushed.

### suggest-default: A fresh hub (or an old `enabled:false` setting) now suggests nothing until an admin picks a decision model or an LLM. Keep that default?

Keep 'none' until an admin chooses

Applied: Recorded in docs/plans/todo-2026-11-18.md. aits committed locally (52b9a37). SSO redirect, A/B undo notice, Claude Stop and the api connection check are being built now. Nothing pushed.

### sso-origin: SSO sign-in only completes when the hub is opened at HARNESS_URL; at the LAN IP or dev port it fails with 'started in another browser'. OK?

Redirect to HARNESS_URL before starting sign-in

Applied: Recorded in docs/plans/todo-2026-11-18.md. aits committed locally (52b9a37). SSO redirect, A/B undo notice, Claude Stop and the api connection check are being built now. Nothing pushed.

### ab-model: A/B compare is user-only. Should the model be able to start or pick a compare (hub fns)?

No, user only

Applied: Recorded in docs/plans/todo-2026-11-18.md. aits committed locally (52b9a37). SSO redirect, A/B undo notice, Claude Stop and the api connection check are being built now. Nothing pushed.

### ab-undo: Undo before choosing a variant leaves the variants' effects (writes they made) in place. What should it do?

Keep effects, but list them in the undo notice

Applied: Recorded in docs/plans/todo-2026-11-18.md. aits committed locally (52b9a37). SSO redirect, A/B undo notice, Claude Stop and the api connection check are being built now. Nothing pushed.

### claude-stop: The Claude page composer's Stop opens the run-control panel (one more click). Change it?

Stop interrupts at once; panel via long-press/menu

Applied: Recorded in docs/plans/todo-2026-11-18.md. aits committed locally (52b9a37). SSO redirect, A/B undo notice, Claude Stop and the api connection check are being built now. Nothing pushed.

### keyed-fn: An api fn for a service the person isn't connected to now fails inside the run (`not-connected`), so a write fn may ask for approval first and then fail. Check before approval?

Check the connection before asking approval

Applied: Recorded in docs/plans/todo-2026-11-18.md. aits committed locally (52b9a37). SSO redirect, A/B undo notice, Claude Stop and the api connection check are being built now. Nothing pushed.
