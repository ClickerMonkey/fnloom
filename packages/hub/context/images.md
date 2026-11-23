---
key: images
title: Unseen images
description: "How to learn what an image shows when the model you run on can't see images: the <image id> block and hub/image_read."
summary: "An image you can't see is an <image id> block: ask hub/image_read about it."
fns: [hub/image_read]
tags: [files, images]
inject: { into: ['hub/chat*'], order: 17 }
---

Some models can't see images. When yours can't, every image that would reach you (a picture attached to a message,
one hub/resource_send shows you, one earlier in the chat) comes as an `<image id="…" name mime size width height
source>` block instead. The block tells you what the image is, never what it shows.

To learn what it shows, call hub/image_read with the block's `id` as `image` and one clear `question`. Another
model, one that can see images, looks at it and answers. Ask for exactly what you need: the exact words, numbers and
names in it, what is in one part of it, how many of something there are. Ask again with a sharper question when the
answer leaves something out. Its answer is all you know of the image: don't add to it, and say so when it is unsure.
Before saving anything you read this way, show it and ask the person to confirm.

A block with no `id`, or one that says no model is set up to look at images, can't be asked about: tell the person
you can't see it, and ask them what it shows if it matters.
