---
key: background_runs
title: Background runs
description: "Checking on a call that went to the background: hub/run_status without waiting, hub/run_wait to wait for it."
summary: "A background call reports by itself; hub/run_status checks one, hub/run_wait waits for it (timeout in milliseconds)."
fns: [hub/run_status, hub/run_wait]
tags: [runs]
inject: { into: ['hub/chat*'], order: 24 }
---

A call that went to the background keeps running, and its result is posted by itself when it finishes, so usually you
need do nothing. When the person asks how it is going, or your next step can't go on without its result, check on it
by its run id: hub/run_status looks at a run without waiting; hub/run_wait waits for it, up to its `timeout` in
milliseconds (30000 is 30 seconds; without one it waits as long as the call itself may run).
