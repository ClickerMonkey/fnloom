/**
 * Qualified type names inside gin. The hub names a system's types `system/Type` (`fs/Entry`), but gin's parser only
 * accepts `\w+` in a type's `name`, `extends` and `satisfies`. Until gin accepts qualified names (library ask), the
 * catalog hands gin definitions with those names spelled in an escaped `\w+` form and reads them back the same way.
 * Every place the hub gives gin a definition goes through `toGin`, so the escape lives here and nowhere else.
 */
import type { TypeDef } from '@aeye/gin';
import { GinTypeDef } from '@harness/core';

/** Characters gin accepts in a type name. */
const WORD = /^\w+$/;
/** One character gin refuses, escaped as `_x<hex>_`. */
const ESCAPED = /_x([0-9a-f]+)_/g;

/** A type name as gin can parse it: `fs/Entry` becomes `fs_x2f_Entry`; plain names are unchanged. */
export function ginName(name: string): string {
  if (WORD.test(name)) { return name; }
  return name.replace(/\W/g, (char) => `_x${char.charCodeAt(0).toString(16)}_`);
}

/** The hub's name for a gin name: the inverse of `ginName`. */
export function hubName(name: string): string {
  return name.replace(ESCAPED, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** The definition keys that hold type names. */
const NAME_KEYS = new Set(['name', 'extends']);

/** Rewrite every type name in a JSON tree with `rename`, leaving field names, docs and everything else alone. */
function renameTree(value: unknown, rename: (name: string) => string): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map((item) => renameTree(item, rename));
  }
  if (value === null || typeof value !== 'object') { return value; }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (NAME_KEYS.has(key) && typeof item === 'string') { return [key, rename(item)]; }
    if (key === 'satisfies' && Array.isArray(item)) {
      const names: unknown[] = item;
      return [key, names.map((entry) => (typeof entry === 'string' ? rename(entry) : entry))];
    }
    return [key, renameTree(item, rename)];
  }));
}

/** A wire definition with every qualified type name escaped for gin. */
export function toGin(def: GinTypeDef): TypeDef {
  return GinTypeDef.parse(renameTree(def, ginName));
}

/** A definition gin produced, with its type names back in the hub's qualified form. */
export function fromGin(def: TypeDef): GinTypeDef {
  return GinTypeDef.parse(renameTree(def, hubName));
}
