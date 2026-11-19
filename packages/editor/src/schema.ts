// SPDX-License-Identifier: Apache-2.0
/**
 * The engine's schema, built from what plugins declare (the registry) and widened to fit the document it opens: a node, a mark or
 * an attribute no enabled plugin declares is still drawn as a placeholder that keeps its exact name and attributes. loro-prosemirror
 * drops what the schema does not know and then deletes it from the Live document on the next edit; widening the schema is what keeps
 * a switched-off plugin's content untouched (ADR 0094).
 */
import { Schema, type MarkSpec, type NodeSpec } from "prosemirror-model";
import { LoroList, LoroMap, LoroText, type LoroDoc } from "loro-crdt";
import { toProseMirrorSpec, type Registry } from "@nuah/editor-core";
import { elementNodes } from "./nodes";

/** What a document holds, by name: each node's attribute keys and whether it holds inline content; each mark's attribute keys. */
export interface Found {
  nodes: Map<string, { attrs: Set<string>; inline: boolean; content: "inline" | "block" | null }>;
  marks: Map<string, Set<string>>;
}
const empty = (): Found => ({ nodes: new Map(), marks: new Map() });

function noteNode(f: Found, name: string, attrs: string[], inline: boolean, content: "inline" | "block" | null) {
  const n = f.nodes.get(name) ?? { attrs: new Set<string>(), inline, content };
  attrs.forEach((a) => n.attrs.add(a));
  n.content ??= content;
  f.nodes.set(name, n);
}
function noteMark(f: Found, name: string, value: unknown) {
  const s = f.marks.get(name) ?? new Set<string>();
  if (value && typeof value === "object" && !Array.isArray(value)) Object.keys(value).forEach((k) => s.add(k));
  f.marks.set(name, s);
}

/** Everything the Live document's body (root map `doc`, loro-prosemirror's layout) holds. */
export function scanLoro(doc: LoroDoc): Found {
  const f = empty();
  const go = (m: LoroMap, inline: boolean) => {
    const name = m.get("nodeName");
    const attrs = m.get("attributes");
    const kids = m.get("children");
    const list = kids instanceof LoroList ? kids.toArray() : [];
    const hasText = list.some((c) => c instanceof LoroText);
    const content = list.length === 0 ? null : hasText || list.some((c) => c instanceof LoroMap && isInlineName(c)) ? "inline" : "block";
    if (typeof name === "string") noteNode(f, name, attrs instanceof LoroMap ? attrs.keys() : [], inline, content);
    for (const c of list) {
      if (c instanceof LoroMap) go(c, content === "inline");
      else if (c instanceof LoroText) for (const d of c.toDelta()) for (const [k, v] of Object.entries(d.attributes ?? {})) noteMark(f, k, v);
    }
  };
  const root = doc.getMap("doc");
  if (root.get("nodeName") !== undefined) go(root, false);
  return f;
}
// a child map among text is inline; a map alone is decided by its parent's other children
const isInlineName = (_m: LoroMap) => false;

/** Everything a ProseMirror JSON document holds (for opening without a Live document). */
export function scanJson(json: unknown): Found {
  const f = empty();
  const go = (n: any, inline: boolean) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text") { for (const m of n.marks ?? []) noteMark(f, m.type, m.attrs); return; }
    const kids: any[] = Array.isArray(n.content) ? n.content : [];
    const content = kids.length === 0 ? null : kids.some((k) => k?.type === "text") ? "inline" : "block";
    noteNode(f, n.type, Object.keys(n.attrs ?? {}), inline, content);
    kids.forEach((k) => go(k, content === "inline"));
  };
  go(json, false);
  return f;
}

const withAttrs = (spec: NodeSpec | MarkSpec, keys: Iterable<string>) => {
  const attrs: Record<string, { default: unknown }> = { ...(spec.attrs as Record<string, { default: unknown }> | undefined) };
  for (const k of keys) attrs[k] ??= { default: null };
  return Object.keys(attrs).length ? { ...spec, attrs } : spec;
};

/** The schema: the host's nodes, the registry's, and placeholders for whatever else `found` holds. */
export function buildSchema(registry: Registry, found: Found = empty()): Schema {
  const pm = toProseMirrorSpec(registry);
  const nodes: Record<string, NodeSpec> = {};
  for (const [name, s] of Object.entries(pm.nodes)) {
    const { dom, ...rest } = s as typeof s & { dom?: { tag: string; class?: string } };
    const spec: NodeSpec = { ...rest };
    if (name === "text" || name === "doc") { nodes[name] = spec; continue; }
    const tag = dom?.tag ?? (s.inline ? "span" : "div");
    const textual = typeof s.content === "string" && /inline|text/.test(s.content);
    spec.toDOM = (n) => {
      const a: Record<string, string> = {};
      if (dom?.class) a.class = dom.class;
      if (n.attrs.blockId) a["data-bid"] = n.attrs.blockId;
      if (textual) a.dir = "auto";
      return s.content ? [tag, a, 0] : [tag, a];
    };
    spec.parseDOM = [{ tag: dom?.class ? `${tag}.${dom.class.split(" ")[0]}` : tag }];
    nodes[name] = spec;
  }
  for (const [name, spec] of Object.entries(elementNodes)) nodes[name] ??= spec;
  for (const [name, n] of found.nodes) {
    if (nodes[name]) { nodes[name] = withAttrs(nodes[name]!, n.attrs) as NodeSpec; continue; }
    // a node no enabled plugin declares: drawn as a placeholder, kept exactly
    const attrs = Object.fromEntries([...n.attrs].map((k) => [k, { default: null }]));
    const inline = n.inline;
    nodes[name] = {
      group: inline ? "inline" : "block", inline, atom: n.content === null, selectable: n.content === null, attrs,
      ...(n.content ? { content: n.content === "inline" ? "inline*" : "block*" } : {}),
      toDOM: () => [inline ? "span" : "div", { class: "nuah-unknown", "data-unknown": name }, ...(n.content ? [0] : [])] as never,
    };
  }
  const marks: Record<string, MarkSpec> = {};
  for (const [name, m] of Object.entries(pm.marks)) {
    const dom = (registry.marks.get(name)?.dom?.tag) ?? "span";
    marks[name] = { ...m, toDOM: () => [dom, 0], parseDOM: [{ tag: dom }] };
  }
  for (const [name, keys] of found.marks) {
    if (marks[name]) { marks[name] = withAttrs(marks[name]!, keys) as MarkSpec; continue; }
    marks[name] = withAttrs({ toDOM: () => ["span", { class: "nuah-unknown-mark", "data-unknown-mark": name }, 0] as const }, keys) as MarkSpec;
  }
  return new Schema({ nodes: { doc: nodes.doc!, text: nodes.text!, ...nodes }, marks });
}

/** Whether `found` holds a name or an attribute the schema lacks (the engine then rebuilds it). */
export function outgrows(schema: Schema, found: Found): boolean {
  for (const [name, n] of found.nodes) {
    const t = schema.nodes[name];
    if (!t) return true;
    for (const a of n.attrs) if (!(a in (t.spec.attrs ?? {}))) return true;
  }
  for (const [name, keys] of found.marks) {
    const t = schema.marks[name];
    if (!t) return true;
    for (const a of keys) if (!(a in (t.spec.attrs ?? {}))) return true;
  }
  return false;
}
