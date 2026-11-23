# Schedule system: open decisions: answers

10 of 10 answered. Written by hitl; the answers themselves are in the .json next to this file.

## What a schedule is, and where its timer lives

### shape: Is a schedule a fn of a kind (`schedule/schedule`, a saved fn like a code fn or a widget), or a record the schedule system keeps?

A fn kind

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### timer-home: Who owns the timer: the schedule system, or a firing service in the hub?

The system owns it

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### run-as: Who does a scheduled run run as?

Its owner only

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

## The args program

### args-scope: Besides `fire`, what can the args program read?

`fire` and the previous firing's result

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### args-authoring: How does the chat model write args that change with each firing?

In plain words, written by an authoring step

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

## When a firing happens

### results: Where does a firing's result go?

Notification and run page only

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### approvals: A firing's target asks for approval and nobody is watching. What happens?

Wait and notify; allow at creation; admin can refuse

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### missed: Firings were missed (the hub or system was down). What happens when it's back?

Run the latest once, if within a grace window

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

### overlap: A firing is due while the last one still runs (a long agent, a wait for approval). Default?

Skip it

Applied: Recorded in docs/plans/schedule-system.md (Decided). Next: the design and types revised to these answers (results: a notification and the run page only, no chat per schedule), shown to you for approval before the build.

## What the chat is told

### limits-text: The hub's injected `limits` item says 'Nothing runs later by itself'. How does that change when the schedule system is installed, without hub text naming the system?

Other: What makes sense based on previous selections 

Applied: Saw the change: going with a context item that replaces another (InjectDecl.replaces), which fits the other answers.
