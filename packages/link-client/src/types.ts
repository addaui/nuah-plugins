/** What `describe` returns, as far as a Face needs it (`specs/link.md`). */
export type JsonSchema = { [key: string]: unknown };

export interface OperationDescription {
  kind: "command" | "query" | "outbound";
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  permission: string | null;
  plugin: string;
  public: boolean;
  allowed: boolean;
  reasons: Record<string, string>;
  resource: { type: string; id: string } | null;
}

export interface Describe {
  contract: string;
  envelope: number;
  profile: string;
  who: { subject: string; display: string; roles: string[] } | null;
  operations: Record<string, OperationDescription>;
  events: Record<string, unknown>;
  permissions: Record<string, unknown>;
  plugins: unknown;
  slots: Record<string, unknown>;
  themes: unknown;
  extension_points: Record<string, unknown>;
}

/** The map the generator writes: operation name to its input and output types. */
export interface OperationTypes {
  input: unknown;
  output: unknown;
  kind: "command" | "query" | "outbound";
}
export type OperationMap = Record<string, OperationTypes>;
