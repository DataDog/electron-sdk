// Declare the `json-schema-to-typescript` types because the package might not be always built.
declare module 'json-schema-to-typescript' {
  export type Options = any;
  export function compile(schema: object, name: string, options?: Partial<Options>): Promise<string>;
}
