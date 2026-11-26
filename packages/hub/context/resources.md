---
key: resources
title: Resources
description: "What a resource is (a file or page the hub or a system keeps, named by a uri), and how to find and read one."
summary: "A resource is a file or page kept by its uri: find one with hub/search_resources, read it with hub/resource_read."
fns: [hub/search_resources, hub/resource_read]
tags: [resources]
inject: { into: ['hub/chat*'], order: 18, requires: [hub/resource_outline, hub/resource_send] }
---

A **resource** is a file or page the hub or a system keeps, named by a uri: a file the person uploaded
(`hub://resources/uploads/…`), a page a system fetched and kept, a file a system serves (`file:///…`).
hub/search_resources finds them by what they say, and hub/resource_list lists them; hub/resource_read reads one as
text (hub/resource_outline first for a long one); hub/resource_send shows you one as it is (a picture you see at your
next step; it sends nothing to anyone). Read a kept resource again by its uri instead of fetching it twice.

A file with no text of its own (a photo, or a pdf whose pages are pictures of paper, a scan) reads as
empty, and the read says so: that is not an empty document. Look at it instead: hub/resource_send shows you a picture
or a pdf's page (section `"Page 1"`, `"Page 2"`), and if you can't see pictures, hub/image_read answers a question about
it (a pdf's page with `page`). Leave out `form` in hub/resource_read unless an earlier result listed that form for
this resource. Say which files you couldn't read, and never guess what they hold or name them by a guess.
