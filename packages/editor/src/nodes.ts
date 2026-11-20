// SPDX-License-Identifier: Apache-2.0
/**
 * The two nodes the host always has (ADR 0094): every card element is one of them, whatever its kind. The editor never looks
 * inside; the plugin that opens the kind draws it.
 */
import type { NodeSpec } from "prosemirror-model";

// `copy` only lives in the clipboard: a copied element's state, taken out again as it is pasted (never stored)
const elementAttrs = { blockId: { default: null }, kind: { default: "" }, v: { default: 1 }, plugin: { default: "" }, data: { default: {} }, fallback: { default: null }, copy: { default: null } };

/** All of an element's attributes travel in the markup as one JSON attribute, so a copy through the clipboard keeps them (`copy` included). */
const toAttr = (attrs: Record<string, unknown>) => JSON.stringify(attrs);
function fromAttr(d: HTMLElement): Record<string, unknown> | false {
  try {
    const a = JSON.parse(d.getAttribute("data-nuah") ?? "") as Record<string, unknown>;
    return a && typeof a === "object" && typeof a.kind === "string" && a.kind ? a : false;
  } catch {
    return false;
  }
}

export const elementNodes: Record<string, NodeSpec> = {
  element: {
    group: "block", atom: true, selectable: true, draggable: true, attrs: elementAttrs,
    toDOM: (n) => ["div", { class: "nuah-element", "data-kind": n.attrs.kind, "data-bid": n.attrs.blockId ?? undefined, "data-nuah": toAttr(n.attrs) }],
    parseDOM: [{ tag: "div.nuah-element", getAttrs: (d) => fromAttr(d as HTMLElement) }],
  },
  elementInline: {
    group: "inline", inline: true, atom: true, selectable: true, attrs: elementAttrs,
    toDOM: (n) => ["span", { class: "nuah-element nuah-element-inline", "data-kind": n.attrs.kind, "data-nuah": toAttr(n.attrs) }],
    parseDOM: [{ tag: "span.nuah-element", getAttrs: (d) => fromAttr(d as HTMLElement) }],
  },
};
/** Node types whose blocks carry ids besides the registry's `ids` ones. */
export const ELEMENT_TYPES = new Set(Object.keys(elementNodes));
