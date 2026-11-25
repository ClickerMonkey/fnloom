/**
 * Gin types and expressions on the wire. A gin type travels as its JSON definition (gin's `TypeDef`) and an expression
 * as gin's `ExprDef`; the receiving side rebuilds the real thing with the registry (`registry.parse` for types, the
 * engine for expressions), which checks every key. These schemas only check the outer shape, because gin itself is the
 * full check. In the API documents (and MCP tool inputs) each one is gin's own JSON Schema for it: gin's `a` grammar,
 * rendered as code holds it (`LENIENT`).
 */
import { type ExprDef, type Registry, type TypeDef } from '@aeye/gin';
import { LENIENT, type Bound } from '@aeye/schema';
import { withJsonSchema, type JsonSchemaObject } from '@ayepi/core';
import { z } from 'zod';
import { harnessRegistry } from './gin-record.ts';
import { ginBundle, HarnessGrammar } from './gin-a.ts';

/** A registry of gin's built-in types and the harness's (`record`), made on first use. */
let ginRegistry: Registry | undefined;
function registryOf(): Registry {
  ginRegistry ??= harnessRegistry();
  return ginRegistry;
}

/** The grammar's TypeDef and Expr, bound over the built-in registry (named types accepted by name). */
const TypeDefA = HarnessGrammar.result('TypeDef');
const ExprA = HarnessGrammar.result('Expr');

/** gin's JSON Schema for one of its `a` schemas, over the built-in registry. */
function ginJsonSchema(pick: (registry: Registry) => Bound<unknown>): () => JsonSchemaObject {
  return () => {
    // its own description gives way to the field's (`.describe()` on the zod schema that carries it)
    const { description: _own, ...schema }: Record<string, unknown> = pick(registryOf()).render(LENIENT).jsonSchema;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a rendered schema is a JSON Schema object
    return schema as JsonSchemaObject;
  };
}

/** Whether a value is a JSON object (not null, not an array). */
function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` has the outer shape of a gin type definition: an object with a string `name`. */
export function isGinTypeDef(value: unknown): value is TypeDef {
  return isRecord(value) && 'name' in value && typeof value.name === 'string';
}

/**
 * What gin itself says is wrong with a type definition (`registry.parse` over the built-in registry), or undefined when
 * it parses, or when its only fault is a name the built-in registry doesn't know (a stored type, a row type), which a
 * hub with that type would accept. A short, exact problem for the model where a schema's union says little.
 */
export function ginTypeProblem(def: TypeDef): string | undefined {
  const registry = registryOf();
  const problem = (candidate: unknown): string | undefined => {
    try {
      registry.parse(candidate);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  const message = problem(def);
  if (message === undefined || !/no type named|unknown type/.test(message)) return message;
  // an unknown name with props (a row type named like its table): what is wrong with the props, as an object type's
  const props: unknown = isRecord(def) && 'props' in def ? def.props : undefined;
  if (props === undefined) return undefined;
  const inner = problem({ name: 'obj', props });
  return inner === undefined ? `"${def.name}" is not a type; an object type is named "obj"` : `"${def.name}" is not a type (an object type is named "obj"), and ${inner}`;
}

/** A gin type in its JSON wire form. `registry.parse` turns it back into a gin type and checks it fully. */
export const GinTypeDef = withJsonSchema(
  z.custom<TypeDef>(isGinTypeDef, { message: 'Expected a gin type definition ({ name, ... }).' }),
  ginJsonSchema((registry) => TypeDefA.bind(registry, undefined, { namedRefs: true })),
);
export type GinTypeDef = z.infer<typeof GinTypeDef>;

/** `isGinTypeDef` for an object type; its own function, so `GinObjTypeDef` is told apart from `GinTypeDef`. */
export function isGinObjTypeDef(value: unknown): value is TypeDef {
  return isGinTypeDef(value);
}

/**
 * A gin object type in its JSON wire form (`{ name: 'obj', props }`, or a named type or extension of one): a row, a
 * form's answers. In a fn's args it is gin's `typ<obj>`, so a model is sent the obj TypeDef schema.
 */
export const GinObjTypeDef = withJsonSchema(
  z.custom<TypeDef>(isGinObjTypeDef, { message: 'Expected a gin object type definition ({ name: "obj", props: { ... } }).' }),
  ginJsonSchema((registry) => ginBundle(registry.typ(registry.obj({}))).bind(registry, undefined, { namedRefs: true })),
);

/** True when `value` has the outer shape of a gin expression: an object with a string `kind`. */
export function isGinExprDef(value: unknown): value is ExprDef {
  return isRecord(value) && 'kind' in value && typeof value.kind === 'string';
}

/**
 * A gin expression in its JSON wire form (a constraint, a default, a program step). The engine parses and checks it;
 * the web's expression editor and viewer draw it.
 */
export const GinExprDef = withJsonSchema(
  z.custom<ExprDef>(isGinExprDef, { message: 'Expected a gin expression ({ kind, ... }).' }),
  ginJsonSchema((registry) => ExprA.bind(registry, undefined, { namedRefs: true })),
);
export type GinExprDef = z.infer<typeof GinExprDef>;
