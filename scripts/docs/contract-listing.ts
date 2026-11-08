/**
 * A contract as a reference listing, read from the live contract (the hub's, for the guide): its fns with their gin
 * signatures, kinds with their payloads, types, mentions and sectioners. Long signatures are shortened to their top-level
 * fields, so a hub fn that returns a whole record stays one readable line.
 */
import { ListType, ObjType, OptionalType } from '@aeye/gin';
import type { AnyContract, AnyFnDef, GinType } from '@harness/sdk';
import { fence } from './compose.ts';

/** Signatures longer than this many characters are shortened. */
export const SIGNATURE_LIMIT = 360;

/**
 * A gin type as gin code, at most `limit` characters where it can be shortened: an object over the limit shows its
 * field names only (`obj{ id, title, tags? … }`), a list shows its item that way.
 */
export function briefType(type: GinType, limit = SIGNATURE_LIMIT): string {
  const code = type.toCode();
  if (code.length <= limit) { return code; }
  if (type instanceof ObjType) {
    const fields = Object.entries(type.fields).map(([name, prop]) => (prop.type instanceof OptionalType || prop.type.isOptional() ? `${name}?` : name));
    return `obj{ ${fields.join(', ')} … }`;
  }
  if (type instanceof ListType) { return `list<${briefType(type.item, limit)}>`; }
  return code;
}

/** Indent a block under a list item. */
function underItem(block: string): string {
  return block.split('\n').map((line) => `  ${line}`).join('\n');
}

/** One fn: its qualified name, what it does, its kind and tags, and its signature. */
function fnEntry(system: string, name: string, def: AnyFnDef): string {
  const tags = def.tags.length === 0 ? '' : ` Tags: ${def.tags.map((t) => `\`${t}\``).join(', ')}.`;
  const kind = def.kind === 'native' ? '' : ` A fn of the \`${def.kind.name}\` kind.`;
  return `- \`${system}/${name}\`: ${def.description}${kind}${tags}\n\n${underItem(fence(`(${briefType(def.args)}) => ${briefType(def.returns)}`, 'text'))}`;
}

/** A contract's declarations as markdown, section by section; sections with nothing in them are left out. */
export function contractListing(contract: AnyContract): string {
  const d = contract.defs;
  const n = contract.name;
  const section = (title: string, lines: string[]): string[] => (lines.length === 0 ? [] : [`#### ${title}`, lines.join('\n')]);
  return [
    ...section(`Fns of \`${n}\``, Object.entries(d.fns).map(([name, def]) => fnEntry(n, name, def))),
    ...section(`Kinds of \`${n}\``, Object.entries(d.kinds).map(([name, def]) => `- \`${n}/${name}\`: ${def.description} ${def.applicability}\n\n${underItem(fence(def.payload.toCode(), 'text'))}`)),
    ...section(`Types of \`${n}\``, Object.entries(d.types).map(([name, def]) => `- \`${n}/${name}\`: ${def.description} Shape: \`${briefType(def.shape)}\`.`)),
    ...section(`Mentions of \`${n}\``, Object.entries(d.mentions).map(([name, def]) => `- \`${n}/${name}\` (${def.title}): ${def.description} Target: \`${briefType(def.target)}\`.`)),
    ...section(`Sectioners of \`${n}\``, Object.entries(d.sectioners).map(([name, def]) => `- \`${n}/${name}\`: ${def.description} Matches: \`${JSON.stringify(def.match)}\`.`)),
  ].join('\n\n');
}
