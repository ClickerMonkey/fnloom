/**
 * The part of js-yaml 4 (no bundled types) the context folder reader uses: loading one document with `CORE_SCHEMA`
 * (no custom tags; timestamps stay strings), and its error, which says where the YAML broke (0-based).
 */
declare module 'js-yaml' {
  interface Schema {
    readonly __schema: unique symbol;
  }
  interface Mark {
    readonly line: number;
    readonly column: number;
  }
  export class YAMLException extends Error {
    readonly reason: string;
    readonly mark: Mark | undefined;
  }
  export const CORE_SCHEMA: Schema;
  export function load(text: string, options?: { schema?: Schema; filename?: string }): unknown;
}
