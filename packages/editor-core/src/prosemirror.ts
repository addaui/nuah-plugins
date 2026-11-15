import type { Registry } from "./registry";

/**
 * What an engine needs to build its schema, from the plugins' declarations (the shape `prosemirror-model`'s `Schema` takes). The engine adapter adds the
 * browser parts (parseDOM / toDOM) from `dom`. Keeping this a pure function of the registry is what lets the model and the engine be two things.
 */
export interface PmNodeSpec { content?: string; group?: string; inline?: boolean; atom?: boolean; selectable?: boolean; attrs?: Record<string, { default: unknown }>; dom?: { tag: string; class?: string } }
export function toProseMirrorSpec(r: Registry): { nodes: Record<string, PmNodeSpec>; marks: Record<string, { attrs?: Record<string, { default: unknown }> }> } {
  const nodes: Record<string, PmNodeSpec> = {};
  for (const s of r.nodes.values()) {
    const attrs = { ...(s.attrs ?? {}), ...(s.ids ? { blockId: { default: null } } : {}) };
    nodes[s.id] = {
      ...(s.content !== undefined && s.content !== "" ? { content: s.content } : {}),
      // text is an inline thing for content expressions ("inline*" must take it)
      ...(s.id !== "doc" ? { group: s.group === "text" ? "inline" : s.group } : {}),
      ...(s.group === "inline" ? { inline: true } : {}),
      ...(s.atom ? { atom: true, selectable: true } : {}),
      ...(Object.keys(attrs).length ? { attrs } : {}),
      ...(s.dom ? { dom: s.dom } : {}),
    };
  }
  return { nodes, marks: Object.fromEntries([...r.marks.values()].map((m) => [m.id, m.attrs ? { attrs: m.attrs } : {}])) };
}
