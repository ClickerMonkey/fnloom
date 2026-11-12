# Build 8

It starts only after build 7 is done and I've checked these four things against what the owner described:
- the harness itself
- the UX
- the code is written the way the owner expects
- the fs documentation, which must be solid: the context folder graph for authoring systems

The check is an audit against the Decided section, the build specs and the feedback files. Whatever it finds is fixed
first, or put on this list.

## The request, verbatim (2026-11-11)

> Build 8
> - widget system
> - data system
> - after bash collect which files were modified and for text based ones have tabs of diffs
> - maybe fs watched for file system changes where you start it and any that can reliably be tied to a bash call should be and display a tabbed view of the changes assuming they are in git
> - make sure fs system has safe guards against git ignored and sensitive looking files - maybe auto mode classifier does that

## Added by the owner (2026-11-12)

> Let's make it configurable so that you can feed in a custom harness name (right now it's just Harness) and have that be used visually everywhere in the app. Let's do next build

- **One setting:** the hub's display name is configurable. Today it is the fixed `name: 'Harness'` in
  packages/hub/src/boot/info.ts. The design step picks where it is set: an env var, an admin setting stored by the
  hub, or both, with the stored setting winning.
- **Used everywhere it shows:** the app brand (AppBrand), the sign-in and setup page, the browser tab title, the PWA
  manifest and install name, the version line, notification titles, and any user-visible text that says "Harness".
  Code names (packages, the `harness` CLI, env var prefixes, storage keys) stay as they are.
- **Live:** a change shows in open tabs without a rebuild of the web app.
- **Check:** a test that sets a custom name and finds it on the sign-in page, in the shell and in the tab title, and
  finds no "Harness" anywhere it would be shown to a person.

Also from the owner the same day, already done on top of build 7 (`9b49d1b`): the sign-in page has "Remember me"
(stays signed in and keeps the email; unticked, the session ends with the browser), a show/hide button on the password,
and the field names password managers need.

## Prior art to read

In product (`C:\Users\pdiff\Documents\GitHub\product\design`):
- widget-kind.md
- widget-actions.md
- widget-controls.md
- widget-authoring-fn.md
- widget-writes-and-routing.md
- query-visuals.md, which the widget system builds on, together with the visual registry from build 5

Take the intent, not the code. Product has no doc named for a "data system": the design step defines it with the
owner's notes, starting from product's data surfaces (`packages/app/src/next/surfaces/data`).

## Notes for the design step (my reading; the owner can overrule)

- **Changes made by bash:**
  - fs records which files each bash call changed.
  - Inside git, it uses `git status` and diffs taken before and after the call. Outside git, it uses a file watcher
    started with the call.
  - Changes that can be tied to the call reliably (the watcher saw them during the call, in the call's working tree)
    are attached to the run.
  - The run view shows a tab per changed text file, with its diff. Binary and large files are listed but not diffed.
- **Safeguards:** fs refuses or asks before reading or writing:
  - gitignored files
  - files that look sensitive: `.env*`, keys, credentials, tokens, and secrets found by content patterns
  - In `auto` chat mode the classifier model sees these flags. Writes to them always need approval.

  The rules come from one list, are configurable per fs instance, and are tested.
