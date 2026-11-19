// SPDX-License-Identifier: Apache-2.0
/**
 * Elements (ADR 0094): what a plugin declares about each kind of element it brings, and what every element stores. The editor knows
 * no kind; these types are the agreement between it and the plugins that fill `editor.element`.
 */
import type { OptionDecl } from "./options";

/** One kind of element, as a plugin declares it in its `provides` data (and its module repeats with code). */
export interface ElementKindDecl {
  /** `@<scope>/<plugin>/<name>`: the first two parts are the declaring plugin. */
  kind: string;
  version: number;
  /** A card is one closed thing the plugin draws; a content element holds editable text. */
  shape: "card" | "content";
  placement: "block" | "inline" | "floating";
  label: { en: string; ar?: string };
  icon?: string;
  group?: string;
  keywords?: string;
  /** JSON Schema of the element's settings (`attrs.data`), checked by the Core. */
  schema?: Record<string, unknown>;
  /** The Loro container the element's own data lives in, under the root map `elements`. */
  state?: "text" | "map" | "list" | "movableList" | "tree";
  /** File types and extensions it can be made from (`text/csv`, `.mmd`). */
  accepts?: string[];
  /** Other plugins' kinds it can open, as `kind@version`. */
  opens?: string[];
  options?: OptionDecl[];
}

/** What every element stores as its attributes. */
export interface ElementAttrs {
  blockId: string;
  kind: string;
  v: number;
  plugin: string;
  data: Record<string, unknown>;
  fallback: { text: string; picture?: string } | null;
}

const KIND = /^(@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*)\/([a-z0-9][a-z0-9-]*)$/;

/** The plugin and the name of a kind; anything not of the form `@scope/plugin/name` is refused. */
export function parseKind(kind: string): { plugin: string; name: string } {
  const m = KIND.exec(kind);
  if (!m) throw new Error(`"${kind}" is not an element kind: it must be @scope/plugin/name, in lower case`);
  return { plugin: m[1]!, name: m[2]! };
}
