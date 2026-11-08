`type({ description, shape, display, methods? })` declares a **named type**: a shape with a name (`notes/Note`), shown to
people in a consistent way, that other systems can use as a field and that `@` mentions can point at.

<!-- include: scripts/docs/example/shared/index.ts#note-type -->

- **`shape`** is any gin type; `ValueOf<typeof Note>` (or `Infer<typeof Note.shape>`) is its value type.
- **`display`**: `label` and `plural` name the type for people, `icon` and `color` mark chips and cards, and `title` and
  `subtitle` name the fields that name a value. `title` and `subtitle` must be text or number fields of the shape; a
  name that isn't one doesn't compile.
- **`methods`** are native fns called on a value of the type. Declare each with `fn()`; its qualified name is
  `notes/Note.pin`, and its args are the value as `self` plus its own args (`{ self: Note, pinned: boolean }`). A person
  can run a method from a mention's card (when the mention provider declares `of: types.Note`), code calls it through
  `notes.types.Note.methods.pin` as a dep, and the LLM sees it only when its `visibility` says so (`'user'` hides it).

The server implements every method under `types`, getting the value as `self`:

<!-- include: scripts/docs/example/server/impl.ts#impl-method -->

Use a named type for things with identity that people point at or other systems take as input (a file entry, a row, a
ticket). For a one-off shape, a plain `g.obj` constant is enough.
