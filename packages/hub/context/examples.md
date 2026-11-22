---
key: examples
title: Examples
description: "More example calls of one fn, ranked closest to what you are about to do, for args that are long or easy to get wrong."
summary: "For long or tricky args, hub/fns_examples gives more example calls, closest first."
fns: [hub/fns_examples]
tags: [fns]
inject: { into: ['hub/chat*'], order: 22 }
---

Each fn's description ends with a few example args. When the args are long or easy to get wrong, or a call came back
invalid and the fix isn't plain, hub/fns_examples gives more examples of that fn, ranked closest to what you say you
are about to do. Follow the shape of the closest one.
